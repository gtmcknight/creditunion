// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {Batch} from "../src/Batch.sol";
import {BatchFactory} from "../src/BatchFactory.sol";
import {MockAssembler} from "../src/MockAssembler.sol";
import {ICredits} from "../src/interfaces/ICredits.sol";
import {MockCredits} from "../src/mocks/MockCredits.sol";
import {MockStatement} from "../src/mocks/MockStatement.sol";

/// @notice Time windows, number ranges and explicit allowlists. MockCredits stamps timestampOf(id) = id.
contract EligibilityTest is Test {
    MockCredits credits;
    BatchFactory factory;
    address alice = makeAddr("alice");
    uint256[] none;

    function setUp() public {
        credits = new MockCredits();
        MockStatement st = new MockStatement(ICredits(address(credits)));
        factory = new BatchFactory(ICredits(address(credits)), new MockAssembler(st), address(0), address(0xFEE), 100, 1);
        credits.mint(alice, 200);
        vm.prank(alice);
        credits.setApprovalForAll(address(factory), true);
    }

    function _one(uint256 id) internal pure returns (uint256[] memory a) {
        a = new uint256[](1);
        a[0] = id;
    }

    function _open(Batch.Filter memory f, uint256[] memory list, uint256 seed) internal returns (Batch b) {
        vm.prank(alice);
        b = Batch(factory.create("E", f, list, 0, 0, Batch.Arrangement.Deposit, 14 days, _one(seed)));
    }

    function test_PaymentWindow() public {
        Batch.Filter memory f;
        f.paidFrom = 50;
        f.paidTo = 60;
        Batch b = _open(f, none, 55);
        assertTrue(b.passes(50));
        assertTrue(b.passes(60));
        assertFalse(b.passes(49));
        assertFalse(b.passes(61));
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(Batch.Excluded.selector, 61));
        factory.deposit(address(b), _one(61));
    }

    function test_OpenEndedWindow() public {
        Batch.Filter memory f;
        f.paidFrom = 150; // no upper bound
        Batch b = _open(f, none, 199);
        assertTrue(b.passes(150));
        assertTrue(b.passes(200));
        assertFalse(b.passes(149));
    }

    function test_NumberRange() public {
        Batch.Filter memory f;
        f.idFrom = 10;
        f.idTo = 20;
        Batch b = _open(f, none, 15);
        assertTrue(b.passes(10));
        assertTrue(b.passes(20));
        assertFalse(b.passes(9));
        assertFalse(b.passes(21));
    }

    function test_Allowlist() public {
        uint256[] memory list = new uint256[](3);
        list[0] = 7;
        list[1] = 9;
        list[2] = 9; // duplicates are harmless
        Batch.Filter memory f;
        Batch b = _open(f, list, 7);
        assertEq(b.allowlistSize(), 2);
        assertTrue(b.passes(9));
        assertFalse(b.passes(8));
        assertEq(b.summary().allowlistSize, 2);
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(Batch.Excluded.selector, 8));
        factory.deposit(address(b), _one(8));
        vm.prank(alice);
        factory.deposit(address(b), _one(9));
    }

    function test_AllowlistCombinesWithOtherRules() public {
        uint256[] memory list = new uint256[](2);
        list[0] = 30;
        list[1] = 40;
        Batch.Filter memory f;
        f.paidTo = 35; // 40 is listed but paid too late
        Batch b = _open(f, list, 30);
        assertTrue(b.passes(30));
        assertFalse(b.passes(40));
    }

    function test_AllowlistCap() public {
        uint256[] memory list = new uint256[](201);
        for (uint256 i; i < 201; ++i) list[i] = i + 1;
        Batch.Filter memory f;
        vm.prank(alice);
        vm.expectRevert(Batch.AllowlistTooLong.selector);
        factory.create("E", f, list, 0, 0, Batch.Arrangement.Deposit, 14 days, _one(1));
    }

    function test_BadRangesRejected() public {
        Batch.Filter memory f;
        f.paidFrom = 10;
        f.paidTo = 5;
        vm.prank(alice);
        vm.expectRevert(Batch.BadFilter.selector);
        factory.create("E", f, none, 0, 0, Batch.Arrangement.Deposit, 14 days, _one(7));
        Batch.Filter memory g;
        g.idFrom = 10;
        g.idTo = 5;
        vm.prank(alice);
        vm.expectRevert(Batch.BadFilter.selector);
        factory.create("E", g, none, 0, 0, Batch.Arrangement.Deposit, 14 days, _one(7));
    }

    function test_CreatorsOwnDepositMustQualify() public {
        Batch.Filter memory f;
        f.idFrom = 100;
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(Batch.Excluded.selector, 5));
        factory.create("E", f, none, 0, 0, Batch.Arrangement.Deposit, 14 days, _one(5));
    }
}
