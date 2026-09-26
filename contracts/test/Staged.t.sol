// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {Batch, IRatings} from "../src/Batch.sol";
import {BatchFactory} from "../src/BatchFactory.sol";
import {MockAssembler} from "../src/MockAssembler.sol";
import {IAssembler} from "../src/interfaces/IAssembler.sol";
import {ICredits} from "../src/interfaces/ICredits.sol";
import {MockCredits} from "../src/mocks/MockCredits.sol";
import {MockStatement} from "../src/mocks/MockStatement.sol";

/// @notice Pooling before the Statement contract exists: factory with no assembler, then propose → exit
///         window → activate.
contract StagedTest is Test {
    MockCredits credits;
    MockStatement statement;
    MockAssembler asm;
    BatchFactory factory;
    address setter = makeAddr("setter");
    address fee = makeAddr("fee");
    address alice = makeAddr("alice");
    address bob = makeAddr("bob");
    Batch.Filter noFilter;

    function setUp() public {
        credits = new MockCredits();
        statement = new MockStatement(ICredits(address(credits)));
        asm = new MockAssembler(statement);
        factory = new BatchFactory(ICredits(address(credits)), IRatings(address(0)), IAssembler(address(0)), setter, fee, 100, 0, 10);
        credits.mint(alice, 50);
        credits.mint(bob, 50);
        for (uint256 i; i < 2; ++i) {
            address u = [alice, bob][i];
            vm.prank(u);
            credits.setApprovalForAll(address(factory), true);
            vm.deal(u, 10 ether);
        }
    }

    function _range(uint256 from, uint256 n) internal pure returns (uint256[] memory a) {
        a = new uint256[](n);
        for (uint256 i; i < n; ++i) a[i] = from + i;
    }

    function _full() internal returns (Batch b) {
        vm.prank(alice);
        b = Batch(factory.create("Early", noFilter, new uint256[](0), 0, Batch.Arrangement.Deposit, Batch.Split.Equal, 14 days, _range(1, 40), 100, 0));
        vm.prank(bob);
        factory.deposit(address(b), _range(51, 40));
    }

    function test_NeedsAssemblerOrSetter() public {
        vm.expectRevert(BatchFactory.NoAssembler.selector);
        new BatchFactory(ICredits(address(credits)), IRatings(address(0)), IAssembler(address(0)), address(0), fee, 100, 0, 10);
    }

    function test_PoolsAndLocksButCannotBurnYet() public {
        Batch b = _full();
        assertEq(uint256(b.state()), uint256(Batch.State.Full));
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(Batch.WrongState.selector, Batch.State.Full));
        b.withdraw(_range(1, 1)); // locked as usual: no exit window yet
        vm.expectRevert(Batch.AssemblerNotReady.selector);
        b.assemble();
        assertFalse(b.summary().canAssemble);
    }

    function test_OnlySetterProposes() public {
        vm.prank(alice);
        vm.expectRevert(BatchFactory.NotSetter.selector);
        factory.proposeAssembler(asm);
        vm.prank(setter);
        vm.expectRevert(BatchFactory.NoAssembler.selector);
        factory.proposeAssembler(IAssembler(address(0)));
    }

    function test_ExitWindowOpensFullBatches() public {
        Batch b = _full();
        vm.prank(setter);
        factory.proposeAssembler(asm);
        assertTrue(factory.exitWindowOpen());
        assertTrue(b.summary().exitWindow);

        // Still can't burn; but bob can leave, even though the batch is full.
        vm.expectRevert(Batch.AssemblerNotReady.selector);
        b.assemble();
        vm.prank(bob);
        b.withdraw(_range(51, 40));
        assertEq(credits.balanceOf(bob), 50);
        assertEq(uint256(b.state()), uint256(Batch.State.Open));

        // Too early to activate.
        vm.expectRevert(BatchFactory.TooEarly.selector);
        factory.activateAssembler();
    }

    function test_ActivateThenBurnAndSell() public {
        Batch b = _full();
        vm.prank(setter);
        factory.proposeAssembler(asm);
        skip(factory.ASSEMBLER_DELAY());
        factory.activateAssembler(); // anyone
        assertEq(address(factory.assembler()), address(asm));
        assertFalse(factory.exitWindowOpen());

        // Window closed: locked again, and the burn works.
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(Batch.WrongState.selector, Batch.State.Full));
        b.withdraw(_range(1, 1));
        b.assemble();
        assertEq(statement.ownerOf(1), address(b));
        vm.prank(bob);
        b.bid{value: 1 ether}();
        skip(1 days);
        b.settle();
        assertEq(statement.ownerOf(1), bob);
    }

    function test_SetterHasNoPowerAfterActivation() public {
        vm.prank(setter);
        factory.proposeAssembler(asm);
        skip(3 days);
        factory.activateAssembler();
        vm.prank(setter);
        vm.expectRevert(BatchFactory.AssemblerFixed.selector);
        factory.proposeAssembler(IAssembler(address(0xBAD)));
        vm.expectRevert(BatchFactory.NothingPending.selector);
        factory.activateAssembler();
    }

    function test_ReplacingProposalRestartsWindow() public {
        vm.prank(setter);
        factory.proposeAssembler(IAssembler(address(0xBAD)));
        skip(20 minutes);
        vm.prank(setter);
        factory.proposeAssembler(asm);
        assertEq(factory.pendingUntil(), block.timestamp + factory.ASSEMBLER_DELAY());
        skip(20 minutes);
        vm.expectRevert(BatchFactory.TooEarly.selector);
        factory.activateAssembler();
        skip(10 minutes);
        factory.activateAssembler();
        assertEq(address(factory.assembler()), address(asm));
    }

    /// A batch that filled long before activation is still full on arrival (unlocked, nobody left):
    /// it can be assembled as soon as the assembler is active.
    function test_FullBatchWaitsForActivation() public {
        Batch b = _full();
        skip(20 days); // well past the lock
        assertEq(uint256(b.state()), uint256(Batch.State.Full));
        vm.prank(setter);
        factory.proposeAssembler(asm);
        skip(3 days);
        factory.activateAssembler();
        b.assemble();
        assertEq(statement.ownerOf(1), address(b));
    }

    /// If someone left while it was unlocked, it stays open (under 80) rather than reviving as full.
    function test_UnlockedWithdrawalIsRespected() public {
        Batch b = _full();
        skip(20 days);
        vm.prank(bob);
        b.withdraw(_range(51, 1));
        vm.prank(setter);
        factory.proposeAssembler(asm);
        skip(3 days);
        factory.activateAssembler();
        assertEq(uint256(b.state()), uint256(Batch.State.Open));
        assertEq(b.count(), 79);
    }

    function test_ConstructorAssemblerIsActiveImmediately() public {
        BatchFactory f = new BatchFactory(ICredits(address(credits)), IRatings(address(0)), asm, address(0), fee, 100, 0, 10);
        assertEq(address(f.assembler()), address(asm));
        assertGt(f.assemblerActiveAt(), 0);
        assertFalse(f.exitWindowOpen());
    }
}
