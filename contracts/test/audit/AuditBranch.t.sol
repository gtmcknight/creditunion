// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {Batch, IRatings} from "../../src/Batch.sol";
import {BatchFactory} from "../../src/BatchFactory.sol";
import {MockAssembler} from "../../src/mocks/MockAssembler.sol";
import {IAssembler} from "../../src/interfaces/IAssembler.sol";
import {ICredits} from "../../src/interfaces/ICredits.sol";
import {MockCredits} from "../../src/mocks/MockCredits.sol";
import {MockStatement} from "../../src/mocks/MockStatement.sol";
import {ready} from "../utils/Ready.sol";

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

    /// Staged launch: a batch that filled long before the assembler went live counts down from activation,
    /// so it gets the full LOCK_DELAY notice and then a burn window.
    function test_LockRunsFromActivation() public {
        Batch b = _open79();
        vm.prank(bob);
        factory.deposit(address(b), _range(90, 1)); // real fill, no assembler yet
        skip(7 days);
        vm.prank(setter);
        factory.proposeAssembler(asm);
        skip(3 days);
        factory.activateAssembler();
        assertEq(b.lockAt(), block.timestamp + b.LOCK_DELAY());
        skip(b.LOCK_DELAY());
        vm.prank(bob);
        vm.expectRevert(abi.encodeWithSelector(Batch.WrongPhase.selector, Batch.Phase.Burnable));
        b.withdraw(_range(90, 1));
        ready(b);
        b.assemble();
        assertEq(uint256(b.state()), uint256(Batch.State.Auction));
    }

    // test_ExitWindowFillAndLeaveKeepsLock and test_RefillAfterUnlockDoesNotRelock covered the retired
    // exit-window and one-lock rules; the new cycle is in test/Lock.t.sol.

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
