// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {ratingsOf} from "../../script/RatingsOf.sol";
import {Batch, IRatings} from "../../src/Batch.sol";
import {BatchFactory} from "../../src/BatchFactory.sol";
import {MockAssembler} from "../../src/mocks/MockAssembler.sol";
import {IAssembler} from "../../src/interfaces/IAssembler.sol";
import {ICredits} from "../../src/interfaces/ICredits.sol";
import {MockCredits} from "../../src/mocks/MockCredits.sol";
import {MockStatement} from "../../src/mocks/MockStatement.sol";
import {TestCredits} from "../../src/mocks/TestCredits.sol";
import {CreditArt} from "../../src/vendor/credits/CreditArt.sol";
import {ready} from "../utils/Ready.sol";

/// @notice Round 6 audit. First block re-verifies the four round 5 fixes against an independent model and the
///         real CreditArt; the R6-n tests demonstrate the new findings.
contract Audit6Test is Test {
    MockCredits credits;
    MockStatement statement;
    MockAssembler asm;
    BatchFactory factory; // mock art, assembler active, minOpen 0 so filters can be probed without deposits
    address setter = makeAddr("setter");
    address fee = makeAddr("fee");
    address alice = makeAddr("alice");
    address bob = makeAddr("bob");
    address eve = makeAddr("eve");

    function setUp() public {
        credits = new MockCredits();
        statement = new MockStatement(ICredits(address(credits)));
        asm = new MockAssembler(statement);
        factory = new BatchFactory(ICredits(address(credits)), IRatings(address(0)), asm, address(0), fee, 200, 0, 0);
        credits.mint(alice, 40); // 1..40
        credits.mint(alice, 40); // 41..80
        credits.mint(bob, 40); // 81..120
        vm.prank(alice);
        credits.setApprovalForAll(address(factory), true);
        vm.prank(bob);
        credits.setApprovalForAll(address(factory), true);
        vm.deal(eve, 100 ether);
    }

    // ------------------------------------------------------------------ helpers

    function _range(uint256 from, uint256 n) internal pure returns (uint256[] memory a) {
        a = new uint256[](n);
        for (uint256 i; i < n; ++i) a[i] = from + i;
    }

    function _create(BatchFactory f, Batch.Filter memory filter, uint256[] memory list, uint256 reserve, uint256[] memory ids)
        internal
        returns (Batch)
    {
        bool layout = filter.layout0 != 0 || filter.layout1 != 0;
        return Batch(
            f.create(
                "x",
                filter,
                list,
                reserve,
                layout ? Batch.Arrangement.Layout : Batch.Arrangement.Deposit,
                Batch.Split.Equal,
                14 days,
                ids,
                200,
                0
            , ratingsOf(address(f)))
        );
    }

    function _try(BatchFactory f, Batch.Filter memory filter) internal returns (bool ok) {
        try this.createExternal(f, filter) {
            ok = true;
        } catch (bytes memory err) {
            assertEq(bytes4(err), Batch.BadFilter.selector, "only BadFilter expected");
        }
    }

    function createExternal(BatchFactory f, Batch.Filter memory filter) external returns (address) {
        return address(_create(f, filter, new uint256[](0), 0, new uint256[](0)));
    }

    function _popcount(uint256 m) internal pure returns (uint256 n) {
        for (; m != 0; m >>= 1) n += m & 1;
    }

    function _top(uint8 t) internal pure returns (uint256) {
        return t == 0 ? 15 : t == 1 ? 6 : t == 2 ? 6 : 4;
    }

    /// Independent model of which painted values a filter's trait rules can admit (what _filterKeys should say).
    function _modelAdmits(uint8 t, Batch.Filter memory f, uint256 v) internal pure returns (bool) {
        if (t == 0) return f.palettes == 0 || (f.palettes >> v) & 1 == 1;
        if (t == 1) return f.eights == 0 || (f.eights >> (v - 1)) & 1 == 1;
        if (t == 2) return f.prints == 0 || (f.prints >> (v - 1)) & 1 == 1;
        if (t == 3) return f.weights == 0 || (f.weights >> (v - 1)) & 1 == 1;
        if (f.palettes == 0) return true;
        for (uint256 m = 1; m < 16; ++m) {
            if ((f.palettes >> m) & 1 == 1 && _popcount(m) == v) return true;
        }
        return false;
    }

    /// Slot value of a real-art Credit for trait `t`, computed here rather than through Batch._keyOf.
    function _keyReal(CreditArt.Read memory r, uint8 t) internal pure returns (uint256) {
        bytes memory c = bytes(r.colors);
        if (t == 0) {
            uint256 m;
            for (uint256 i; i < c.length; ++i) {
                m |= c[i] == "C" ? 1 : c[i] == "M" ? 2 : c[i] == "Y" ? 4 : 8;
            }
            return m;
        }
        if (t == 1) return r.eights < 14 ? r.eights + 1 : 15;
        if (t == 2) {
            string[6] memory p = ["Registered", "Nudge", "Slip", "Skew", "Drift", "Loose"];
            for (uint256 i; i < 6; ++i) if (keccak256(bytes(r.register)) == keccak256(bytes(p[i]))) return i + 1;
            revert("print");
        }
        if (t == 3) {
            string[4] memory w = ["even", "lean", "sparse", "extreme"];
            for (uint256 i; i < 4; ++i) if (keccak256(bytes(r.weight)) == keccak256(bytes(w[i]))) return i + 1;
            revert("weight");
        }
        return c.length;
    }

    function _realFactory(uint256 rnd, uint256 mints) internal returns (TestCredits tc, BatchFactory tf) {
        vm.prevrandao(bytes32(rnd));
        tc = new TestCredits();
        tf = new BatchFactory(ICredits(address(tc)), IRatings(address(0)), IAssembler(address(0)), setter, fee, 200, 0, 0);
        for (uint256 i; i < mints; ++i) tc.mint(alice, 40);
        vm.prank(alice);
        tc.setApprovalForAll(address(tf), true);
    }

    // ------------------------------------------------------------------ round 5 fixes, re-verified

    /// ReserveTooLow: accepted iff reserve is 0 or at least MIN_RAISE; nothing else in create depends on it.
    function testFuzz_R6_ReserveRuleExact(uint256 reserve) public {
        bool ok = reserve == 0 || reserve >= 0.01 ether;
        if (!ok) vm.expectRevert(Batch.ReserveTooLow.selector);
        Batch b = _create(factory, _blank(), new uint256[](0), reserve, new uint256[](0));
        if (ok) assertEq(b.reserve(), reserve);
    }

    /// With the fix, the opening floor is never below MIN_RAISE for any accepted reserve, in or after the window.
    function test_R6_OpeningFloorNeverBelowMinRaise() public {
        uint256[3] memory reserves = [uint256(0), 0.01 ether, 3 ether];
        for (uint256 k; k < 3; ++k) {
            uint256[] memory a = _fresh(alice, 40);
            uint256[] memory c = _fresh(alice, 40);
            vm.startPrank(alice);
            Batch b = _create(factory, _blank(), new uint256[](0), reserves[k], a);
            factory.deposit(address(b), c);
            vm.stopPrank();
            ready(b);
            b.assemble();
            assertGe(b.minBid(), 0.01 ether);
            skip(7 days);
            assertEq(b.minBid(), 0.01 ether);
        }
    }

    function _fresh(address to, uint256 n) internal returns (uint256[] memory ids) {
        uint256 first = credits.mint(to, n);
        ids = _range(first, n);
    }

    /// _filterKeys against an independent model, every trait, random trait rules and any painted value: the
    /// layout is accepted exactly when the model says a Credit with that value can pass the trait rules, and a
    /// value above the trait's top is always refused. No off-by-one between slot values and filter bits.
    function testFuzz_R6_FilterKeysMatchesModel(uint8 t, uint16 pal, uint8 pr, uint8 wt, uint32 ei, uint8 v, uint8 slot)
        public
    {
        t = uint8(bound(t, 0, 4));
        v = uint8(bound(v, 1, 15));
        slot = uint8(bound(slot, 0, 79));
        Batch.Filter memory f;
        f.layoutTrait = t;
        f.palettes = pal;
        f.prints = pr;
        f.weights = wt;
        f.eights = ei;
        if (slot < 64) f.layout0 = uint256(v) << (4 * slot);
        else f.layout1 = uint64(uint256(v) << (4 * (slot - 64)));
        // palettes = {mask 0} alone is refused outright since R6-2 (no Credit has zero inks).
        bool expect = pal != 1 && v <= _top(t) && _modelAdmits(t, f, v);
        assertEq(_try(factory, f), expect);
    }

    /// Plates ink-count mapping, exhaustively over single-palette filters: palette m admits exactly the value
    /// popcount(m).
    function test_R6_PlatesMappingExhaustive() public {
        for (uint256 m = 1; m < 16; ++m) {
            for (uint256 v = 1; v <= 4; ++v) {
                Batch.Filter memory f;
                f.layoutTrait = 4;
                f.palettes = uint16(1 << m);
                f.layout0 = v;
                assertEq(_try(factory, f), _popcount(m) == v);
            }
        }
    }

    /// The soundness direction on the real art: for random trait rules, every Credit that passes() the filter
    /// has a key the layout check admits, so the fix never refuses a layout a real Credit could fill. The
    /// Credit is then deposited into the painted slot.
    /// forge-config: default.fuzz.runs = 48
    function testFuzz_R6_FilterKeysAdmitsEveryPassingCredit(uint256 rnd, uint8 t, uint16 pal, uint8 pr, uint8 wt, uint32 ei)
        public
    {
        _admitsEveryPassing(rnd, uint8(bound(t, 0, 4)), pal, pr, wt, ei);
    }

    /// The fuzz above is not vacuous: with the rules off, every trait deposits three real Credits.
    function test_R6_FilterKeysAdmitsEveryPassingCreditNotVacuous() public {
        for (uint8 t; t < 5; ++t) {
            assertEq(_admitsEveryPassing(uint256(keccak256(abi.encode(t))) & ~uint256(0xf00), t, 0, 0, 0, 0), 3);
        }
        // and with every rule on (random sets), at least one Credit is exercised
        assertGt(_admitsEveryPassing(0xf00, 4, 0xffff, 0x3f, 0x0f, 0x3f), 0);
    }

    function _admitsEveryPassing(uint256 rnd, uint8 t, uint16 pal, uint8 pr, uint8 wt, uint32 ei)
        internal
        returns (uint256 checked)
    {
        (TestCredits tc, BatchFactory tf) = _realFactory(rnd, 1);
        Batch.Filter memory f;
        // Each rule is on half the time, so some of the 40 Credits usually pass.
        if (rnd >> 8 & 1 == 1 && pal != 1) f.palettes = pal; // {mask 0} alone is refused (R6-2)
        if (rnd >> 9 & 1 == 1) f.prints = pr;
        if (rnd >> 10 & 1 == 1) f.weights = wt;
        if (rnd >> 11 & 1 == 1) f.eights = ei;
        checked = _checkPassingAdmitted(tc, tf, f, t);
    }

    /// Empty withdraw reverts in every pre-assembly state (Open included), and a stranger can't reach the
    /// filledAt reset with a non-empty list either (NotDepositor rolls it back).
    function test_R6_FilledAtResetOnlyByARealLeave() public {
        BatchFactory staged =
            new BatchFactory(ICredits(address(credits)), IRatings(address(0)), IAssembler(address(0)), setter, fee, 200, 0, 0);
        vm.prank(alice);
        credits.setApprovalForAll(address(staged), true);
        vm.prank(bob);
        credits.setApprovalForAll(address(staged), true);
        vm.prank(alice);
        Batch b = _create(staged, _blank(), new uint256[](0), 0, _range(1, 40));
        vm.expectRevert(Batch.NothingToClaim.selector);
        b.withdraw(new uint256[](0)); // Open
        vm.prank(bob);
        staged.deposit(address(b), _range(81, 40));
        uint64 filled = b.filledAt();
        vm.prank(setter);
        staged.proposeAssembler(asm);
        vm.prank(eve);
        vm.expectRevert(abi.encodeWithSelector(Batch.NotDepositor.selector, 1));
        b.withdraw(_range(1, 1));
        assertEq(b.filledAt(), filled);
        vm.prank(alice);
        b.withdraw(_range(1, 1));
        assertEq(b.filledAt(), 0, "a real leave stops the countdown");
    }

    // ------------------------------------------------------------------ R6-1: the layout check and Bits

    /// Weight exactly as CreditArt._weight computes it (1 even, 2 lean, 3 sparse, 4 extreme).
    function _weightOf(uint256 marks, uint256 capacity) internal pure returns (uint256) {
        if (marks * 256 >= 120 * capacity && marks * 256 <= 136 * capacity) return 1;
        if (marks * 256 >= 112 * capacity && marks * 256 <= 144 * capacity) return 2;
        if (marks * 256 >= 96 * capacity && marks * 256 <= 160 * capacity) return 3;
        return 4;
    }

    /// Brute force: some Credit (n inks 1..4, any marks 0..64n) with painted value v has marks in [lo, hi].
    function _bitsModel(uint8 t, uint256 v, uint256 lo, uint256 hi) internal pure returns (bool) {
        for (uint256 n = 1; n <= 4; ++n) {
            if (t == 0 && _popcount(v) != n) continue;
            if (t == 4 && v != n) continue;
            for (uint256 m = lo; m <= hi && m <= 64 * n; ++m) {
                if (t != 3 || _weightOf(m, 64 * n) == v) return true;
            }
        }
        return false;
    }

    /// The weight bounds documented in Batch._bitsKeys are exact: over every ink count and mark count, even
    /// spans 30..136 marks, lean 28..144, sparse 24..160, extreme 0..256.
    function test_R6_1_WeightBoundsExact() public pure {
        uint256[5] memory lo = [uint256(0), 999, 999, 999, 999];
        uint256[5] memory hi;
        for (uint256 n = 1; n <= 4; ++n) {
            for (uint256 m; m <= 64 * n; ++m) {
                uint256 w = _weightOf(m, 64 * n);
                if (m < lo[w]) lo[w] = m;
                if (m > hi[w]) hi[w] = m;
            }
        }
        assertEq(lo[1], 30);
        assertEq(hi[1], 136);
        assertEq(lo[2], 28);
        assertEq(hi[2], 144);
        assertEq(lo[3], 24);
        assertEq(hi[3], 160);
        assertEq(lo[4], 0);
        assertEq(hi[4], 256);
    }

    /// R6-1 fixed: for any Bits range and any painted value of Colors, Weight or Plates, the layout is accepted
    /// exactly when some possible Credit with that value has marks in range. Eights and Print ignore Bits.
    function testFuzz_R6_1_BitsKeysMatchModel(uint8 t, uint8 v, uint16 lo, uint16 hi) public {
        t = uint8(bound(t, 0, 4));
        v = uint8(bound(v, 1, _top(t)));
        lo = uint16(bound(lo, 0, 256));
        hi = uint16(bound(hi, 0, 256));
        if (hi != 0 && hi < lo) (lo, hi) = (hi, lo);
        Batch.Filter memory f;
        f.layoutTrait = t;
        f.layout0 = v;
        f.bitsFrom = lo;
        f.bitsTo = hi;
        bool expect = t == 1 || t == 2 || _bitsModel(t, v, lo, hi == 0 ? 256 : hi);
        assertEq(_try(factory, f), expect);
    }

    /// R6-1 fixed. The three layouts from the finding are refused; the boundary ones just inside are accepted.
    /// On the real art (200 Credits) the refused ones really were unfillable: no 1-ink Credit reaches 65 marks
    /// and no even Credit reaches 137.
    function test_R6_1_BitsRangeMakesPaintedValueImpossible() public {
        Batch.Filter memory f;
        f.layoutTrait = 0;
        f.layout0 = 1; // slot 0 wants C (1 ink)
        f.bitsFrom = 65;
        assertFalse(_try(factory, f));
        f.bitsFrom = 64;
        assertTrue(_try(factory, f));

        f.layoutTrait = 4;
        f.layout0 = 1; // slot 0 wants 1 ink
        f.bitsFrom = 65;
        assertFalse(_try(factory, f));
        f.bitsFrom = 64;
        assertTrue(_try(factory, f));

        f.layoutTrait = 3;
        f.layout0 = 1; // slot 0 wants "even"
        f.bitsFrom = 137;
        assertFalse(_try(factory, f));
        f.bitsFrom = 136;
        assertTrue(_try(factory, f));
        f.bitsFrom = 0;
        f.bitsTo = 29; // even needs at least 30 marks (1 ink)
        assertFalse(_try(factory, f));
        f.bitsTo = 30;
        assertTrue(_try(factory, f));

        (TestCredits tc,) = _realFactory(uint256(keccak256("r6-1")), 5);
        CreditArt art = tc.art();
        uint256 oneInk;
        uint256 even;
        for (uint256 id = 1; id <= 200; ++id) {
            CreditArt.Read memory r = art.describe(tc.seedOf(id), tc.timestampOf(id));
            assertLe(r.marks, 64 * r.plates, "marks never exceed 64 per ink");
            if (r.plates == 1) {
                ++oneInk;
                assertLt(r.marks, 65);
            }
            if (keccak256(bytes(r.weight)) == keccak256("even")) {
                ++even;
                assertLt(r.marks, 137);
                assertGe(r.marks, 30);
            }
        }
        assertGt(oneInk, 0);
        assertGt(even, 0);
    }

    /// Soundness on the real art with a Bits range: every Credit that passes() a random Bits range has a value
    /// the layout check admits, for every painted trait, and it deposits into its slot.
    /// forge-config: default.fuzz.runs = 32
    function testFuzz_R6_1_BitsNeverRefusesAPassingCredit(uint256 rnd, uint8 t, uint16 lo, uint16 hi) public {
        t = uint8(bound(t, 0, 4));
        (TestCredits tc, BatchFactory tf) = _realFactory(rnd, 1);
        CreditArt art = tc.art();
        // Center the range on a real Credit so something passes.
        uint256 marks = art.describe(tc.seedOf(1), tc.timestampOf(1)).marks;
        Batch.Filter memory f;
        f.bitsFrom = uint16(marks - bound(lo, 0, marks));
        f.bitsTo = uint16(marks + bound(hi, 0, 40));
        assertGt(_checkPassingAdmitted(tc, tf, f, t), 0);
    }

    /// Every Credit (up to 3 of ids 1..40) that passes `f` is admitted into a slot painted with its own value.
    function _checkPassingAdmitted(TestCredits tc, BatchFactory tf, Batch.Filter memory f, uint8 t)
        internal
        returns (uint256 checked)
    {
        Batch ref = Batch(this.createExternal(tf, f));
        for (uint256 id = 1; id <= 40 && checked < 3; ++id) {
            if (!ref.passes(id)) continue;
            uint256 k = _keyReal(tc.art().describe(tc.seedOf(id), tc.timestampOf(id)), t);
            if (k > _top(t)) continue;
            Batch.Filter memory lf = f;
            lf.layoutTrait = t;
            lf.layout0 = k;
            assertTrue(_try(tf, lf), "a passing Credit's value was refused");
            vm.prank(alice);
            Batch b = _create(tf, lf, new uint256[](0), 0, _range(id, 1));
            assertEq(b.keyOf(id), k);
            ++checked;
        }
    }

    // ------------------------------------------------------------------ R6-2: filters that admit fewer than 80

    function createListExternal(uint256[] memory list) external returns (address) {
        return address(_create(factory, _blank(), list, 0, new uint256[](0)));
    }

    function _tryList(uint256[] memory list) internal returns (bool ok) {
        try this.createListExternal(list) {
            ok = true;
        } catch (bytes memory err) {
            assertEq(bytes4(err), Batch.BadFilter.selector, "only BadFilter expected");
        }
    }

    /// R6-2 fixed. Filters that can never admit 80 Credits are refused: an allowlist of 1 to 79 distinct ids
    /// (duplicates don't count), an id range of 79, bitsFrom above 256, palettes = {mask 0}.
    function test_R6_2_FiltersThatCanNeverFill() public {
        assertFalse(_tryList(_range(1, 1)));
        assertFalse(_tryList(_range(1, 79)));
        uint256[] memory dup = new uint256[](80);
        for (uint256 i; i < 79; ++i) dup[i] = i + 1;
        dup[79] = 1; // 80 entries, 79 distinct
        assertFalse(_tryList(dup));

        Batch.Filter memory f;
        f.idFrom = 1;
        f.idTo = 79;
        assertFalse(_try(factory, f));
        f.idFrom = 0;
        f.idTo = 78; // 0..78 is 79 numbers
        assertFalse(_try(factory, f));

        f = _blank();
        f.bitsFrom = 257;
        assertFalse(_try(factory, f));

        f = _blank();
        f.palettes = 1;
        assertFalse(_try(factory, f));
    }

    /// The boundary configs still work: an allowlist of exactly 80 fills and locks, an id range of exactly 80
    /// fills, bitsFrom 256 and palettes {mask 0, C} are accepted, and idFrom alone (no idTo) is unbounded.
    function test_R6_2_BoundaryFiltersStillWork() public {
        vm.prank(alice);
        Batch b = _create(factory, _blank(), _range(1, 80), 0, _range(1, 40));
        vm.prank(alice);
        factory.deposit(address(b), _range(41, 40));
        assertEq(b.count(), 80);
        assertEq(uint256(b.state()), uint256(Batch.State.Full));

        uint256 first = credits.mint(alice, 40);
        credits.mint(bob, 40);
        Batch.Filter memory f;
        f.idFrom = first;
        f.idTo = first + 79; // exactly 80
        vm.prank(alice);
        Batch r = _create(factory, f, new uint256[](0), 0, _range(first, 40));
        vm.prank(bob);
        factory.deposit(address(r), _range(first + 40, 40));
        assertEq(uint256(r.state()), uint256(Batch.State.Full));

        f = _blank();
        f.idFrom = 1000; // open-ended: no width to check
        assertTrue(_try(factory, f));

        f = _blank();
        f.bitsFrom = 256;
        assertTrue(_try(factory, f));

        f = _blank();
        f.palettes = 3; // mask 0 plus C
        assertTrue(_try(factory, f));
    }

    function _blank() internal pure returns (Batch.Filter memory f) {}
}
