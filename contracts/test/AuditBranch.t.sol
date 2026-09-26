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

/// Audit tests for the unlock / Bits / Creator-retirement branch.
contract AuditBranchTest is Test {
    MockCredits credits;
    MockStatement statement;
    MockAssembler asm;
    BatchFactory factory; // staged: no assembler yet
    address setter = makeAddr("setter");
    address fee = makeAddr("fee");
    address alice = makeAddr("alice");
    address bob = makeAddr("bob");
    address eve = makeAddr("eve");
    Batch.Filter noFilter;

    function setUp() public {
        credits = new MockCredits();
        statement = new MockStatement(ICredits(address(credits)));
        asm = new MockAssembler(statement);
        factory = new BatchFactory(ICredits(address(credits)), IRatings(address(0)), IAssembler(address(0)), setter, fee, 100, 0, 10);
        credits.mint(alice, 50); // 1..50
        credits.mint(bob, 50); // 51..100
        credits.mint(eve, 10); // 101..110
        address[3] memory us = [alice, bob, eve];
        for (uint256 i; i < 3; ++i) {
            vm.prank(us[i]);
            credits.setApprovalForAll(address(factory), true);
        }
    }

    function _range(uint256 from, uint256 n) internal pure returns (uint256[] memory a) {
        a = new uint256[](n);
        for (uint256 i; i < n; ++i) a[i] = from + i;
    }

    function _open79() internal returns (Batch b) {
        vm.prank(alice);
        b = Batch(factory.create("x", noFilter, new uint256[](0), 0, Batch.Arrangement.Deposit, Batch.Split.Equal, 14 days, _range(1, 40), 100, 0));
        vm.prank(bob);
        factory.deposit(address(b), _range(51, 39));
    }

    /// Staged launch: a batch that filled >7 days before the assembler went live still gets a full lock from
    /// activation, so it can be burned before anyone can pull out.
    function test_LockRunsFromActivation() public {
        Batch b = _open79();
        vm.prank(bob);
        factory.deposit(address(b), _range(90, 1)); // real fill, no assembler yet
        skip(7 days);
        vm.prank(setter);
        factory.proposeAssembler(asm);
        skip(3 days);
        factory.activateAssembler();
        assertEq(b.unlocksAt(), block.timestamp + 7 days);
        vm.prank(bob);
        vm.expectRevert(abi.encodeWithSelector(Batch.WrongState.selector, Batch.State.Full));
        b.withdraw(_range(90, 1));
        b.assemble();
        assertEq(uint256(b.state()), uint256(Batch.State.Auction));
    }

    /// Filling and leaving during the exit window gives the lock back: the real fill still locks.
    function test_ExitWindowFillAndLeaveKeepsLock() public {
        Batch b = _open79();
        vm.prank(setter);
        factory.proposeAssembler(asm);
        // eve fills and leaves in the same block (exit window lets Full batches withdraw)
        vm.startPrank(eve);
        factory.deposit(address(b), _range(101, 1));
        b.withdraw(_range(101, 1));
        vm.stopPrank();
        assertEq(b.filledAt(), 0);
        skip(7 days);
        factory.activateAssembler();
        skip(8 days);
        // The honest fill locks for a full 7 days.
        vm.prank(bob);
        factory.deposit(address(b), _range(90, 1));
        assertEq(uint256(b.state()), uint256(Batch.State.Full));
        assertEq(b.unlocksAt(), block.timestamp + 7 days);
        vm.prank(bob);
        vm.expectRevert(abi.encodeWithSelector(Batch.WrongState.selector, Batch.State.Full));
        b.withdraw(_range(90, 1));
        b.assemble();
    }

    /// After the lock lifts, leaving and rejoining never re-locks.
    function test_RefillAfterUnlockDoesNotRelock() public {
        Batch b = _open79();
        vm.prank(bob);
        factory.deposit(address(b), _range(90, 1));
        uint256 first = b.unlocksAt();
        skip(7 days);
        vm.prank(bob);
        b.withdraw(_range(90, 1));
        vm.prank(bob);
        factory.deposit(address(b), _range(90, 1));
        assertEq(b.unlocksAt(), first);
        assertLe(b.unlocksAt(), block.timestamp);
    }

    /// Bits filter: marks==0 cannot be targeted exactly (0/0 = no filter); bitsFrom alone works; reversed reverts.
    function test_BitsFilter() public {
        Batch.Filter memory f;
        f.bitsFrom = 5;
        f.bitsTo = 4;
        vm.prank(alice);
        vm.expectRevert(Batch.BadFilter.selector);
        factory.create("x", f, new uint256[](0), 0, Batch.Arrangement.Deposit, Batch.Split.Equal, 14 days, _range(1, 10), 100, 0);

        f.bitsTo = 0; // bitsFrom only: mock marks = 0 fails it
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(Batch.Excluded.selector, 1));
        factory.create("x", f, new uint256[](0), 0, Batch.Arrangement.Deposit, Batch.Split.Equal, 14 days, _range(1, 10), 100, 0);

        f.bitsFrom = 0;
        f.bitsTo = 3; // upper bound only admits marks 0
        vm.prank(alice);
        Batch b = Batch(factory.create("x", f, new uint256[](0), 0, Batch.Arrangement.Deposit, Batch.Split.Equal, 14 days, _range(1, 10), 100, 0));
        assertTrue(b.passes(11));
    }

    function test_CreatorRetired() public {
        vm.prank(alice);
        vm.expectRevert(Batch.ArrangementRetired.selector);
        factory.create("x", noFilter, new uint256[](0), 0, Batch.Arrangement.Creator, Batch.Split.Equal, 14 days, _range(1, 10), 100, 0);
    }
}
