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
import {TestCredits} from "../../src/mocks/TestCredits.sol";
import {ready} from "../utils/Ready.sol";

/// @notice Round 5 audit. Each test demonstrates a finding (R5-n) or re-verifies an earlier property
///         after the layoutTrait change. MockCredits: even ids print CMY (mask 7), odd ids K (mask 8);
///         mock Eights = (id / 2) % 3.
contract Audit5Test is Test {
    MockCredits credits;
    MockStatement statement;
    MockAssembler asm;
    BatchFactory factory; // assembler active from deploy
    BatchFactory staged; // no assembler yet; setter proposes
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
        factory = new BatchFactory(ICredits(address(credits)), IRatings(address(0)), asm, address(0), fee, 200, 0, 1);
        staged = new BatchFactory(ICredits(address(credits)), IRatings(address(0)), IAssembler(address(0)), setter, fee, 200, 0, 1);
        credits.mint(alice, 40); // 1..40
        credits.mint(alice, 40); // 41..80
        credits.mint(bob, 40); // 81..120
        credits.mint(bob, 40); // 121..160
        address[3] memory us = [alice, bob, eve];
        for (uint256 i; i < 3; ++i) {
            vm.startPrank(us[i]);
            credits.setApprovalForAll(address(factory), true);
            credits.setApprovalForAll(address(staged), true);
            vm.stopPrank();
            vm.deal(us[i], 100 ether);
        }
    }

    function _range(uint256 from, uint256 n) internal pure returns (uint256[] memory a) {
        a = new uint256[](n);
        for (uint256 i; i < n; ++i) a[i] = from + i;
    }

    function _parity(uint256 from, uint256 n, bool even) internal pure returns (uint256[] memory a) {
        a = new uint256[](n);
        uint256 id = from;
        for (uint256 i; i < n; ++id) {
            if ((id % 2 == 0) == even) a[i++] = id;
        }
    }

    function _open(BatchFactory f, Batch.Filter memory filter, uint256 reserve, Batch.Arrangement arr, uint256[] memory ids)
        internal
        returns (Batch b)
    {
        vm.prank(alice);
        b = Batch(f.create("x", filter, new uint256[](0), reserve, arr, Batch.Split.Equal, 14 days, ids, 200, 0));
    }

    // ------------------------------------------------------------------ R5-1 reserve below the floor

    /// R5-1 (Low, fixed). A reserve between 1 wei and MIN_RAISE used to lower the opening floor (a 1 wei bid
    /// started the 24 h clock). `initialize` now rejects 0 < reserve < MIN_RAISE.
    function test_R5_1_ReserveBelowFloorRejected() public {
        uint256[] memory none = new uint256[](0);
        vm.startPrank(alice);
        vm.expectRevert(Batch.ReserveTooLow.selector);
        factory.create("x", noFilter, none, 1, Batch.Arrangement.Deposit, Batch.Split.Equal, 14 days, _range(1, 1), 200, 0);
        vm.expectRevert(Batch.ReserveTooLow.selector);
        factory.create("x", noFilter, none, 0.01 ether - 1, Batch.Arrangement.Deposit, Batch.Split.Equal, 14 days, _range(1, 1), 200, 0);
        vm.stopPrank();
    }

    /// R5-1 positive: reserve 0 opens at MIN_RAISE; exactly MIN_RAISE and above open at the reserve.
    function test_R5_1_ValidReservesStillWork() public {
        assertEq(_open(factory, noFilter, 0, Batch.Arrangement.Deposit, _range(1, 1)).reserve(), 0);
        assertEq(_open(factory, noFilter, 0.5 ether, Batch.Arrangement.Deposit, _range(2, 1)).reserve(), 0.5 ether);
        // Exactly the floor: the opening bid is 0.01 ETH and a bid at it is taken.
        Batch b = _open(factory, noFilter, 0.01 ether, Batch.Arrangement.Deposit, _range(41, 40));
        vm.prank(bob);
        factory.deposit(address(b), _range(81, 40));
        ready(b);
        b.assemble();
        assertEq(b.minBid(), 0.01 ether);
        vm.prank(eve);
        vm.expectRevert(abi.encodeWithSelector(Batch.BidTooLow.selector, 0.01 ether));
        b.bid{value: 0.01 ether - 1}();
        vm.prank(eve);
        b.bid{value: 0.01 ether}();
        assertEq(b.highBid(), 0.01 ether);
    }

    // ------------------------------------------------------------------ R5-2 unfillable Eights layouts

    /// R5-2 (Low, fixed). Eights validation used to allow slot values up to 9 (8 eights), but the real edition's
    /// maximum is 5 eights. `_topKey` now caps Eights at 6.
    function test_R5_2_EightsLayoutAboveEditionRejected() public {
        Batch.Filter memory f;
        f.layoutTrait = 1; // Eights
        for (uint256 v = 7; v <= 9; ++v) {
            f.layout0 = v;
            vm.prank(alice);
            vm.expectRevert(Batch.BadFilter.selector);
            factory.create("x", f, new uint256[](0), 0, Batch.Arrangement.Layout, Batch.Split.Equal, 14 days, _range(1, 1), 200, 0);
        }
    }

    /// R5-2 positive: an Eights layout painted with value 6 (5 eights) is still accepted.
    function test_R5_2_EightsLayoutValueSixAccepted() public {
        Batch.Filter memory f;
        f.layoutTrait = 1;
        f.layout0 = 6;
        Batch b = _open(factory, f, 0, Batch.Arrangement.Layout, _range(1, 1));
        assertEq(b.layout()[0], 6);
    }

    /// R5-2b (Info, fixed). A painted value the filter excludes (a K slot on a CMY-only batch) used to make the
    /// batch unfillable from creation. `initialize` now rejects it, per trait.
    function test_R5_2b_LayoutContradictingFilterRejected() public {
        Batch.Filter memory f;
        // Colors: K slot, CMY-only palettes.
        f.palettes = uint16(1 << 7);
        f.layout0 = 8;
        _expectBadLayout(f);
        // Eights: slot wants 2 eights (value 3), filter allows 0 or 1 eights.
        f = _blank();
        f.layoutTrait = 1;
        f.eights = 3;
        f.layout0 = 3;
        _expectBadLayout(f);
        // Print: slot wants Slip (value 3), filter allows Registered only.
        f = _blank();
        f.layoutTrait = 2;
        f.prints = 1;
        f.layout0 = 3;
        _expectBadLayout(f);
        // Weight: slot wants extreme (value 4), filter allows even and lean.
        f = _blank();
        f.layoutTrait = 3;
        f.weights = 3;
        f.layout0 = 4;
        _expectBadLayout(f);
        // Plates: slot wants 4 inks, filter allows only CMY (3 inks) and K (1 ink).
        f = _blank();
        f.layoutTrait = 4;
        f.palettes = uint16((1 << 7) | (1 << 8));
        f.layout0 = 4;
        _expectBadLayout(f);
    }

    /// R5-2b positive: layouts consistent with their filter, per trait, are accepted; the original CMY/K case fills.
    function test_R5_2b_ConsistentLayoutAndFilterAccepted() public {
        Batch.Filter memory f;
        f.palettes = uint16((1 << 7) | (1 << 8)); // CMY or K
        f.layout0 = 8; // slot 0: K
        Batch b = _open(factory, f, 0, Batch.Arrangement.Layout, _parity(2, 40, true)); // 40 CMY
        vm.prank(bob);
        factory.deposit(address(b), _parity(82, 39, true)); // 79 CMY fill the any slots
        vm.prank(bob);
        factory.deposit(address(b), _range(81, 1)); // a K takes the painted slot
        assertEq(b.count(), 80);

        f = _blank();
        f.layoutTrait = 1;
        f.eights = 7; // 0, 1 or 2 eights (every mock Credit)
        f.layout0 = 3 | (2 << 4) | (1 << 8); // slots: 2 eights, 1 eight, none
        _open(factory, f, 0, Batch.Arrangement.Layout, _range(1, 1));

        f = _blank();
        f.layoutTrait = 2;
        f.prints = 1 | (1 << 2); // Registered (every mock Credit) or Slip
        f.layout0 = 3; // Slip
        _open(factory, f, 0, Batch.Arrangement.Layout, _range(3, 1));

        f = _blank();
        f.layoutTrait = 3;
        f.weights = 1 | 8; // even (every mock Credit) or extreme
        f.layout0 = 4; // extreme
        _open(factory, f, 0, Batch.Arrangement.Layout, _range(5, 1));

        f = _blank();
        f.layoutTrait = 4;
        f.palettes = uint16((1 << 7) | (1 << 8)); // CMY (3 inks) or K (1 ink)
        f.layout0 = 3 | (1 << 4);
        _open(factory, f, 0, Batch.Arrangement.Layout, _range(7, 1));
    }

    function _blank() internal pure returns (Batch.Filter memory f) {}

    function _expectBadLayout(Batch.Filter memory f) internal {
        vm.prank(alice);
        vm.expectRevert(Batch.BadFilter.selector);
        factory.create("x", f, new uint256[](0), 0, Batch.Arrangement.Layout, Batch.Split.Equal, 14 days, _range(1, 1), 200, 0);
    }

    // ------------------------------------------------------------------ R5-3 empty withdraw by anyone

    /// R5-3 (Info, fixed). During the old exit window anyone could call withdraw([]) on a Full batch and zero its
    /// filledAt. An empty withdraw still reverts, so a stranger can't touch the countdown. (The refill half of
    /// this test asserted the retired one-lock rule; the new cycle is in test/Lock.t.sol.)
    function test_R5_3_StrangerEmptyWithdrawRejected() public {
        Batch b = _open(staged, noFilter, 0, Batch.Arrangement.Deposit, _range(1, 40));
        vm.prank(bob);
        staged.deposit(address(b), _range(81, 40));
        uint64 filled = b.filledAt();
        assertGt(filled, 0);
        vm.prank(setter);
        staged.proposeAssembler(asm);

        vm.prank(eve); // holds nothing in this batch
        vm.expectRevert(Batch.NothingToClaim.selector);
        b.withdraw(new uint256[](0));
        assertEq(b.filledAt(), filled, "filledAt kept");
    }

    // ------------------------------------------------------------------ re-verification with the real art

    /// Re-verifies round 4 against the real CreditArt (TestCredits): for every paintable trait, keyOf of any
    /// Credit is within the slot books (≤ 15, so _have/_slots never go out of bounds) and, apart from Eights,
    /// within the trait's validated range. Also measures a 40-Credit deposit into a layout batch with a trait
    /// filter, where describe() runs twice per Credit (passes() and _keyOf()).
    function testFuzz_R5_KeyOfInRangeRealArt(uint256 rnd, uint8 trait) public {
        trait = uint8(bound(trait, 0, 4));
        vm.prevrandao(bytes32(rnd));
        TestCredits tc = new TestCredits();
        BatchFactory tf = new BatchFactory(ICredits(address(tc)), IRatings(address(0)), IAssembler(address(0)), setter, fee, 200, 0, 1);
        tc.mint(alice, 40);
        vm.startPrank(alice);
        tc.setApprovalForAll(address(tf), true);
        Batch.Filter memory f;
        f.layoutTrait = trait;
        f.layout0 = 1; // one painted slot, 79 any: every Credit fits until 80
        f.weights = 15; // any weight, but forces the describe() path in passes()
        uint256 g = gasleft();
        Batch b = Batch(tf.create("x", f, new uint256[](0), 0, Batch.Arrangement.Layout, Batch.Split.Equal, 14 days, _range(1, 40), 200, 0));
        g -= gasleft();
        vm.stopPrank();
        emit log_named_uint("create+deposit 40, layout + trait filter, real art", g);
        assertLt(g, 16_000_000, "40-Credit create fits comfortably");
        uint256 top = trait == 0 ? 15 : trait == 1 ? 15 : trait == 2 ? 6 : 4;
        for (uint256 id = 1; id <= 40; ++id) {
            uint256 k = b.keyOf(id);
            assertGe(k, 1);
            assertLe(k, top);
        }
    }

    /// Re-verifies B1/B4/R2-5 after round 4 in one lifecycle on a Plates layout: burn in painted order, settle
    /// pays exactly, the batch keeps no ETH, and rescue can't take the Statement.
    function test_R5_PlatesLayoutLifecycleExact() public {
        Batch.Filter memory f;
        f.layoutTrait = 4; // Plates: CMY = 3 inks, K = 1
        for (uint256 i; i < 40; ++i) f.layout0 |= uint256(i % 2 == 0 ? 3 : 1) << (4 * i);
        Batch b = _open(factory, f, 0, Batch.Arrangement.Layout, _range(1, 40)); // 20 CMY + 20 K
        vm.prank(bob);
        factory.deposit(address(b), _range(81, 40));
        ready(b);
        b.assemble();
        vm.prank(eve);
        b.bid{value: 1 ether + 3}();
        skip(24 hours);
        b.settle();
        b.claim(alice);
        b.claim(bob);
        assertEq(address(b).balance, 0);
        assertEq(fee.balance + alice.balance + bob.balance, 200 ether + 1 ether + 3);
        uint256 sid = b.statementId();
        vm.expectRevert(Batch.NotStray.selector);
        b.rescue(address(statement), sid);
    }

    /// Re-verifies clone initialisation after round 4: neither a live batch nor the implementation can be
    /// initialised again (a second call would otherwise rewrite the layout books and fees).
    function test_R5_InitializeOnlyOnce() public {
        Batch b = _open(factory, noFilter, 0, Batch.Arrangement.Deposit, _range(1, 1));
        Batch.Filter memory f;
        f.layout0 = 8;
        vm.prank(eve);
        vm.expectRevert(Batch.AlreadyInitialized.selector);
        b.initialize(eve, "y", f, new uint256[](0), 0, 0, 0, Batch.Arrangement.Layout, Batch.Split.Equal, 0);
        Batch impl = Batch(factory.implementation());
        vm.expectRevert(Batch.AlreadyInitialized.selector);
        impl.initialize(eve, "y", noFilter, new uint256[](0), 0, 0, 0, Batch.Arrangement.Deposit, Batch.Split.Equal, 0);
    }
}
