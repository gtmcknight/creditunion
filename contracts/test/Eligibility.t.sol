// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {Batch, IRatings} from "../src/Batch.sol";
import {BatchFactory} from "../src/BatchFactory.sol";
import {MockAssembler} from "../src/MockAssembler.sol";
import {ICredits} from "../src/interfaces/ICredits.sol";
import {MockCredits} from "../src/mocks/MockCredits.sol";
import {MockStatement} from "../src/mocks/MockStatement.sol";
import {Ratings} from "../src/Ratings.sol";
import {RatingsDeploy} from "../script/DeployRatings.s.sol";

/// @notice Time windows, number ranges and explicit allowlists. MockCredits stamps timestampOf(id) = id.
contract EligibilityTest is Test {
    MockCredits credits;
    BatchFactory factory;
    address alice = makeAddr("alice");
    uint256[] none;

    function setUp() public {
        credits = new MockCredits();
        MockStatement st = new MockStatement(ICredits(address(credits)));
        factory = new BatchFactory(ICredits(address(credits)), IRatings(address(0)), new MockAssembler(st), address(0), address(0xFEE), 100, 0, 1);
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
        b = Batch(factory.create("E", f, list, 0, Batch.Arrangement.Deposit, Batch.Split.Equal, 14 days, _one(seed), 100, 0));
    }

    /// Rating rules read the frozen score table. Here: ids 1..4 score 1000, 5000, 8000, 5500 (×10).
    function test_RatingRule() public {
        bytes memory data = abi.encodePacked(bytes2(0xE803), bytes2(0x8813), bytes2(0x401F), bytes2(0x7C15)); // LE
        Ratings r = RatingsDeploy.deploy(data);
        assertEq(r.scoreOf(2), 5000);
        MockStatement st = new MockStatement(ICredits(address(credits)));
        BatchFactory f2 = new BatchFactory(ICredits(address(credits)), IRatings(address(r)), new MockAssembler(st), address(0), address(0xFEE), 100, 0, 1);
        vm.prank(alice);
        credits.setApprovalForAll(address(f2), true);
        Batch.Filter memory f;
        f.minScore = 4000;
        vm.prank(alice);
        Batch b = Batch(f2.create("R", f, none, 0, Batch.Arrangement.Deposit, Batch.Split.Equal, 14 days, _one(2), 100, 0));
        assertFalse(b.passes(1)); // 100.0 < 400.0
        assertTrue(b.passes(2));
        assertTrue(b.passes(3));
        assertTrue(b.passes(4));
        assertFalse(b.passes(5)); // unknown id scores 0
        f.maxScore = 6000;
        vm.prank(alice);
        Batch c = Batch(f2.create("R2", f, none, 0, Batch.Arrangement.Deposit, Batch.Split.Equal, 14 days, _one(4), 100, 0));
        assertTrue(c.passes(2));
        assertFalse(c.passes(3)); // 800 > 600
        assertFalse(c.passes(1));
    }

    function test_RatingRuleNeedsTable() public {
        Batch.Filter memory f;
        f.minScore = 100; // this factory has no ratings table
        vm.prank(alice);
        vm.expectRevert(Batch.BadFilter.selector);
        factory.create("R", f, none, 0, Batch.Arrangement.Deposit, Batch.Split.Equal, 14 days, _one(9), 100, 0);
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
        f.idTo = 89; // exactly 80 numbers, the narrowest range allowed
        Batch b = _open(f, none, 15);
        assertTrue(b.passes(10));
        assertTrue(b.passes(89));
        assertFalse(b.passes(9));
        assertFalse(b.passes(90));
    }

    function test_Allowlist() public {
        uint256[] memory list = new uint256[](81);
        for (uint256 i; i < 80; ++i) list[i] = 7 + 2 * i; // 80 odd ids from 7
        list[80] = 9; // duplicates are harmless
        Batch.Filter memory f;
        Batch b = _open(f, list, 7);
        assertEq(b.allowlistSize(), 80);
        assertTrue(b.passes(9));
        assertFalse(b.passes(8));
        assertEq(b.summary().allowlistSize, 80);
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(Batch.Excluded.selector, 8));
        factory.deposit(address(b), _one(8));
        vm.prank(alice);
        factory.deposit(address(b), _one(9));
    }

    function test_AllowlistCombinesWithOtherRules() public {
        uint256[] memory list = new uint256[](80);
        for (uint256 i; i < 80; ++i) list[i] = 1 + i; // 30 and 40 among them
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
        factory.create("E", f, list, 0, Batch.Arrangement.Deposit, Batch.Split.Equal, 14 days, _one(1), 100, 0);
    }

    function test_BadRangesRejected() public {
        Batch.Filter memory f;
        f.paidFrom = 10;
        f.paidTo = 5;
        vm.prank(alice);
        vm.expectRevert(Batch.BadFilter.selector);
        factory.create("E", f, none, 0, Batch.Arrangement.Deposit, Batch.Split.Equal, 14 days, _one(7), 100, 0);
        Batch.Filter memory g;
        g.idFrom = 10;
        g.idTo = 5;
        vm.prank(alice);
        vm.expectRevert(Batch.BadFilter.selector);
        factory.create("E", g, none, 0, Batch.Arrangement.Deposit, Batch.Split.Equal, 14 days, _one(7), 100, 0);
    }

    function test_CreatorsOwnDepositMustQualify() public {
        Batch.Filter memory f;
        f.idFrom = 100;
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(Batch.Excluded.selector, 5));
        factory.create("E", f, none, 0, Batch.Arrangement.Deposit, Batch.Split.Equal, 14 days, _one(5), 100, 0);
    }
}
