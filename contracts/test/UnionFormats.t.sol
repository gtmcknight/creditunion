// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {ratingsOf} from "../script/RatingsOf.sol";
import {Batch, IRatings} from "../src/Batch.sol";
import {BatchFactory} from "../src/BatchFactory.sol";
import {UnionFormats, IUnionFactory} from "../src/UnionFormats.sol";
import {MockAssembler} from "../src/mocks/MockAssembler.sol";
import {IAssembler} from "../src/interfaces/IAssembler.sol";
import {ICredits} from "../src/interfaces/ICredits.sol";
import {MockCredits} from "../src/mocks/MockCredits.sol";
import {MockStatement} from "../src/mocks/MockStatement.sol";

/// @notice A union's creator picks its Statement format while every member can still leave, and not from the
///         countdown on.
contract UnionFormatsTest is Test {
    MockCredits credits;
    MockAssembler asm_;
    BatchFactory factory;
    UnionFormats formats;
    Batch.Filter noFilter;
    address setter = makeAddr("setter");
    address alice = makeAddr("alice"); // creates the unions
    address bob = makeAddr("bob");

    event FormatPicked(address indexed union, uint8 format);

    function setUp() public {
        vm.warp(1_000_000);
        credits = new MockCredits();
        asm_ = new MockAssembler(new MockStatement(ICredits(address(credits))));
        factory = new BatchFactory(ICredits(address(credits)), IRatings(address(0)), IAssembler(address(0)), setter, makeAddr("fee"), 100, 0, 1);
        formats = new UnionFormats(IUnionFactory(address(factory)));
        credits.mint(alice, 100); // 1..100
        credits.mint(bob, 100); // 101..200
        vm.prank(alice);
        credits.setApprovalForAll(address(factory), true);
        vm.prank(bob);
        credits.setApprovalForAll(address(factory), true);
    }

    function _range(uint256 from, uint256 n) internal pure returns (uint256[] memory a) {
        a = new uint256[](n);
        for (uint256 i; i < n; ++i) a[i] = from + i;
    }

    /// alice opens with 1..40; `full` has bob fill it with 101..140.
    function _union(bool full) internal returns (Batch b) {
        vm.prank(alice);
        b = Batch(factory.create("U", noFilter, new uint256[](0), 0, Batch.Arrangement.Deposit, Batch.Split.Equal, 14 days, _range(1, 40), 100, 0, ratingsOf(address(factory))));
        if (full) {
            vm.prank(bob);
            factory.deposit(address(b), _range(101, 40));
        }
    }

    function _activate() internal {
        vm.prank(setter);
        factory.proposeAssembler(asm_);
        skip(factory.ASSEMBLER_DELAY());
        factory.activateAssembler();
    }

    function _fixed(Batch.Phase p) internal pure returns (bytes memory) {
        return abi.encodeWithSelector(UnionFormats.FormatFixed.selector, p);
    }

    function test_nothingPickedAtFirst() public {
        Batch b = _union(false);
        (bool picked, uint8 format) = formats.pickOf(address(b));
        assertFalse(picked);
        assertEq(format, 0);
    }

    function test_theCreatorPicks() public {
        Batch b = _union(false);
        vm.expectEmit(address(formats));
        emit FormatPicked(address(b), 7);
        vm.prank(alice);
        formats.pick(address(b), 7);
        (bool picked, uint8 format) = formats.pickOf(address(b));
        assertTrue(picked);
        assertEq(format, 7);
    }

    function test_pickingIssuedIsAPick() public {
        Batch b = _union(false);
        vm.prank(alice);
        formats.pick(address(b), 0);
        (bool picked, uint8 format) = formats.pickOf(address(b));
        assertTrue(picked);
        assertEq(format, 0);
    }

    function test_theLatestPickStands() public {
        Batch b = _union(false);
        vm.startPrank(alice);
        formats.pick(address(b), 2);
        formats.pick(address(b), 5);
        vm.stopPrank();
        (, uint8 format) = formats.pickOf(address(b));
        assertEq(format, 5);
    }

    function test_onlyTheCreatorPicks() public {
        Batch b = _union(true);
        vm.prank(bob); // a member, not the creator
        vm.expectRevert(UnionFormats.NotTheCreator.selector);
        formats.pick(address(b), 3);
    }

    function test_onlyTheFactorysUnions() public {
        vm.prank(alice);
        vm.expectRevert(UnionFormats.NotAUnion.selector);
        formats.pick(makeAddr("not a union"), 3);
    }

    /// The burn contract decides what an index means; this only keeps it.
    function test_keepsAnyIndex() public {
        Batch b = _union(false);
        vm.prank(alice);
        formats.pick(address(b), 255);
        (bool picked, uint8 format) = formats.pickOf(address(b));
        assertTrue(picked);
        assertEq(format, 255);
    }

    function test_picksWhileMembersCanLeave() public {
        Batch b = _union(false);
        assertEq(uint256(b.phase()), uint256(Batch.Phase.Open));
        vm.prank(alice);
        formats.pick(address(b), 1);

        vm.prank(bob);
        factory.deposit(address(b), _range(101, 40));
        assertEq(uint256(b.phase()), uint256(Batch.Phase.Waiting)); // full, burning not on yet
        vm.prank(alice);
        formats.pick(address(b), 2);

        _activate();
        skip(5 minutes + 1 hours); // the countdown and its burn hour pass unused
        assertEq(uint256(b.phase()), uint256(Batch.Phase.Expired));
        vm.prank(alice);
        formats.pick(address(b), 3);
        (, uint8 format) = formats.pickOf(address(b));
        assertEq(format, 3);
    }

    function test_fixedFromTheCountdown() public {
        Batch b = _union(true);
        vm.prank(alice);
        formats.pick(address(b), 4);
        _activate();
        assertEq(uint256(b.phase()), uint256(Batch.Phase.Countdown));
        vm.prank(alice);
        vm.expectRevert(_fixed(Batch.Phase.Countdown));
        formats.pick(address(b), 5);

        skip(5 minutes);
        assertEq(uint256(b.phase()), uint256(Batch.Phase.Burnable));
        vm.prank(alice);
        vm.expectRevert(_fixed(Batch.Phase.Burnable));
        formats.pick(address(b), 5);
        (, uint8 format) = formats.pickOf(address(b));
        assertEq(format, 4);
    }

    function test_fixedOnceBurned() public {
        Batch b = _union(true);
        _activate();
        skip(5 minutes);
        b.assemble();
        assertEq(uint256(b.phase()), uint256(Batch.Phase.Assembled));
        vm.prank(alice);
        vm.expectRevert(_fixed(Batch.Phase.Assembled));
        formats.pick(address(b), 1);
    }
}
