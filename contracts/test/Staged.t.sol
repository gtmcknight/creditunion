// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {ratingsOf} from "../script/RatingsOf.sol";
import {Batch, IRatings} from "../src/Batch.sol";
import {BatchFactory} from "../src/BatchFactory.sol";
import {MockAssembler} from "../src/mocks/MockAssembler.sol";
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
        b = Batch(factory.create("Early", noFilter, new uint256[](0), 0, Batch.Arrangement.Deposit, Batch.Split.Equal, 14 days, _range(1, 40), 100, 0, ratingsOf(address(factory))));
        vm.prank(bob);
        factory.deposit(address(b), _range(51, 40));
    }

    function test_NeedsAssemblerOrSetter() public {
        vm.expectRevert(BatchFactory.NoAssembler.selector);
        new BatchFactory(ICredits(address(credits)), IRatings(address(0)), IAssembler(address(0)), address(0), fee, 100, 0, 10);
    }

    /// No assembler: a full batch pools but never locks, and can't burn.
    function test_PoolsButNeverLocksOrBurnsYet() public {
        Batch b = _full();
        assertEq(uint256(b.state()), uint256(Batch.State.Full));
        assertEq(uint256(b.phase()), uint256(Batch.Phase.Waiting));
        assertEq(b.lockAt(), 0);
        vm.expectRevert(abi.encodeWithSelector(Batch.WrongPhase.selector, Batch.Phase.Waiting));
        b.assemble();
        assertFalse(b.summary().canAssemble);
        vm.prank(alice);
        b.withdraw(_range(1, 1)); // free to leave at 80/80
        assertEq(uint256(b.state()), uint256(Batch.State.Open));
    }

    function test_OnlySetterProposes() public {
        vm.prank(alice);
        vm.expectRevert(BatchFactory.NotSetter.selector);
        factory.proposeAssembler(asm);
        vm.prank(setter);
        vm.expectRevert(BatchFactory.NoAssembler.selector);
        factory.proposeAssembler(IAssembler(address(0)));
    }

    function test_ProposedAssemblerStillUnlocked() public {
        Batch b = _full();
        vm.prank(setter);
        factory.proposeAssembler(asm);
        assertEq(uint256(b.summary().phase), uint256(Batch.Phase.Waiting));

        // Still can't burn; bob can leave, even though the batch is full.
        vm.expectRevert(abi.encodeWithSelector(Batch.WrongPhase.selector, Batch.Phase.Waiting));
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

        // Active: a 5-minute countdown, then locked and burnable.
        assertEq(b.lockAt(), block.timestamp + b.LOCK_DELAY());
        skip(b.LOCK_DELAY());
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(Batch.WrongPhase.selector, Batch.Phase.Burnable));
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

    /// A batch that filled long before activation is still full on arrival (nobody left): it can be
    /// assembled LOCK_DELAY after the assembler goes live.
    function test_FullBatchWaitsForActivation() public {
        Batch b = _full();
        skip(20 days);
        assertEq(uint256(b.state()), uint256(Batch.State.Full));
        vm.prank(setter);
        factory.proposeAssembler(asm);
        skip(3 days);
        factory.activateAssembler();
        skip(b.LOCK_DELAY());
        b.assemble();
        assertEq(statement.ownerOf(1), address(b));
    }

    /// If someone left before activation, it stays open (under 80) rather than reviving as full.
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
    }
}
