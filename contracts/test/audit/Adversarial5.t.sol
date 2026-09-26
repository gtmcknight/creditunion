// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {ERC721} from "@openzeppelin/contracts/token/ERC721/ERC721.sol";
import {Batch, IRatings} from "../../src/Batch.sol";
import {BatchFactory} from "../../src/BatchFactory.sol";
import {MockAssembler} from "../../src/mocks/MockAssembler.sol";
import {IAssembler} from "../../src/interfaces/IAssembler.sol";
import {ICredits, ICreditArt} from "../../src/interfaces/ICredits.sol";
import {MockStatement} from "../../src/mocks/MockStatement.sol";
import {ready} from "../utils/Ready.sol";

/// @dev Art with the mainnet plate rule (paidAt % 15 + 1 is the CMYK mask, so all 15 palettes exist) plus one
///      case mainnet can never produce: paidAt == BLANK returns letters that map to no plate (mask 0).
contract PaletteArt {
    uint64 public constant BLANK = type(uint64).max;

    function describe(bytes21, uint64 paidAt) external pure returns (ICreditArt.Read memory r) {
        if (paidAt == BLANK) {
            r.colors = "??";
        } else {
            uint256 mask = uint256(paidAt) % 15 + 1;
            bytes memory letters = "CMYK";
            bytes memory names;
            for (uint256 i; i < 4; ++i) {
                if (mask & (1 << i) != 0) names = abi.encodePacked(names, letters[i]);
            }
            r.colors = string(names);
        }
        r.register = "Registered";
        r.weight = "even";
        r.eightsLabel = "0";
    }
}

/// @dev Credits whose palette is chosen at mint (paidAt), so a test can build any mix.
contract PaletteCredits is ERC721 {
    PaletteArt public immutable art = new PaletteArt();
    bool public constant isSealed = true;
    uint256 public supply;
    mapping(uint256 => bytes21) public seedOf;
    mapping(uint256 => uint64) public timestampOf;

    constructor() ERC721("Credits", "CREDIT") {}

    function mintAt(address to, uint256 n, uint64 paidAt) external returns (uint256 first) {
        first = supply + 1;
        for (uint256 i; i < n; ++i) {
            uint256 id = ++supply;
            seedOf[id] = bytes21(keccak256(abi.encode(id)));
            timestampOf[id] = paidAt;
            _mint(to, id);
        }
    }

    function burn(address owner_, uint256[] calldata ids) external returns (bytes21[] memory seeds) {
        require(msg.sender == owner_ || isApprovedForAll(owner_, msg.sender), "NotApproved");
        seeds = new bytes21[](ids.length);
        for (uint256 i; i < ids.length; ++i) {
            require(_ownerOf(ids[i]) == owner_, "NotOwner");
            seeds[i] = seedOf[ids[i]];
            _burn(ids[i]);
        }
    }

    function tokensOf(address) external pure returns (uint256[] memory out) {}
}

/// @notice Round 5: palette layouts. Completability bookkeeping, greedy order, gas, edge slots, odd palettes.
contract Adversarial5Test is Test {
    uint8 constant CMY = 7;
    uint8 constant K = 8;
    uint8 constant CMYK = 15;
    uint64 constant CMY_AT = 6; // mask = paidAt % 15 + 1
    uint64 constant K_AT = 7;
    uint64 constant CMYK_AT = 14;

    PaletteCredits credits;
    MockStatement statement;
    MockAssembler asm;
    BatchFactory factory;
    BatchFactory staged;
    address setter = makeAddr("setter");
    address alice = makeAddr("alice");
    address bob = makeAddr("bob");
    address carol = makeAddr("carol");
    address fee = makeAddr("fee");

    function setUp() public {
        credits = new PaletteCredits();
        statement = new MockStatement(ICredits(address(credits)));
        asm = new MockAssembler(statement);
        factory = new BatchFactory(ICredits(address(credits)), IRatings(address(0)), asm, address(0), fee, 200, 0, 1);
        staged = new BatchFactory(ICredits(address(credits)), IRatings(address(0)), IAssembler(address(0)), setter, fee, 200, 0, 1);
        for (uint256 i; i < 3; ++i) {
            address u = [alice, bob, carol][i];
            vm.startPrank(u);
            credits.setApprovalForAll(address(factory), true);
            credits.setApprovalForAll(address(staged), true);
            vm.stopPrank();
            vm.deal(u, 100 ether);
        }
    }

    // ---------------------------------------------------------------- helpers

    function _range(uint256 from, uint256 n) internal pure returns (uint256[] memory a) {
        a = new uint256[](n);
        for (uint256 i; i < n; ++i) a[i] = from + i;
    }

    function _one(uint256 id) internal pure returns (uint256[] memory a) {
        a = new uint256[](1);
        a[0] = id;
    }

    function _layout(uint8[80] memory slots) internal pure returns (Batch.Filter memory f) {
        for (uint256 i; i < 80; ++i) {
            if (i < 64) f.layout0 |= uint256(slots[i]) << (4 * i);
            else f.layout1 |= uint64(slots[i]) << uint64(4 * (i - 64));
        }
    }

    function _checkered() internal pure returns (uint8[80] memory s) {
        for (uint256 i; i < 80; ++i) s[i] = ((i / 8 + i % 8) % 2 == 0) ? CMY : K;
    }

    function _open(BatchFactory f, address who, Batch.Filter memory filter, uint256[] memory ids) internal returns (Batch b) {
        vm.prank(who);
        b = Batch(f.create("L", filter, new uint256[](0), 0, Batch.Arrangement.Layout, Batch.Split.Equal, 14 days, ids, 200, 0));
    }

    function _deposit(BatchFactory f, address who, Batch b, uint256[] memory ids) internal {
        vm.prank(who);
        f.deposit(address(b), ids);
    }

    function _noSlot(BatchFactory f, address who, Batch b, uint256 id) internal {
        vm.prank(who);
        vm.expectRevert(abi.encodeWithSelector(Batch.NoSlot.selector, id));
        f.deposit(address(b), _one(id));
    }

    /// Every painted slot has its palette, every any slot has some deposited id, all 80 distinct, none zero.
    function _assertOrderValid(Batch b, uint8[80] memory s) internal view {
        uint256[] memory order = b.layoutOrder();
        assertEq(order.length, 80, "order length");
        for (uint256 i; i < 80; ++i) {
            assertTrue(order[i] != 0, "zero id in order");
            assertTrue(b.depositorOf(order[i]) != address(0), "id not deposited");
            if (s[i] != 0) assertEq(b.keyOf(order[i]), s[i], "painted slot palette");
            for (uint256 j; j < i; ++j) assertTrue(order[i] != order[j], "duplicate in order");
        }
    }

    // ---------------------------------------------------------------- 1. completability under every path

    /// A reference model of the bookkeeping (have[p], overflow ≤ anySlots) run against random layouts over all
    /// 15 palettes and random deposit/withdraw sequences: the contract must accept exactly what the model accepts,
    /// and once Full the greedy order must be a valid assignment that burns.
    function testFuzz_ModelAgreesAllPalettes(uint256 seed) public {
        uint8[80] memory s;
        uint256[16] memory slots;
        uint256 anyS;
        uint256 r = seed;
        for (uint256 i; i < 80; ++i) {
            r = uint256(keccak256(abi.encode(r)));
            uint8 v = uint8(r % 24); // 16..23 → any, so roughly a third of the sheet is free
            if (v > 15) v = 0;
            s[i] = v;
            if (v == 0) ++anyS;
            else ++slots[v];
        }
        if (anyS == 80) {
            s[0] = K;
            anyS = 79;
            slots[K] = 1;
        }
        uint256 N = 240;
        for (uint256 i; i < N; ++i) {
            r = uint256(keccak256(abi.encode(r)));
            credits.mintAt(alice, 1, uint64(r % 15));
        }
        // open with an id that has somewhere to go
        uint256 first;
        for (uint256 id = 1; id <= N && first == 0; ++id) {
            uint256 p = credits.timestampOf(id) % 15 + 1;
            if (slots[p] > 0 || anyS > 0) first = id;
        }
        if (first == 0) return;
        Batch b = _open(factory, alice, _layout(s), _one(first));
        uint256[16] memory have;
        uint256 overflow;
        {
            uint256 p = credits.timestampOf(first) % 15 + 1;
            if (have[p] >= slots[p]) ++overflow;
            ++have[p];
        }
        for (uint256 step; step < 600 && b.count() < 80; ++step) {
            r = uint256(keccak256(abi.encode(r)));
            uint256 id = r % N + 1;
            uint256 p = credits.timestampOf(id) % 15 + 1;
            if (b.depositorOf(id) != address(0)) {
                if ((r >> 8) % 4 == 0) {
                    vm.prank(alice);
                    b.withdraw(_one(id));
                    if (have[p] > slots[p]) --overflow;
                    --have[p];
                    assertEq(b.keyOf(id), 0, "keyOf not cleared");
                }
                continue;
            }
            bool expect = have[p] < slots[p] || overflow < anyS;
            vm.prank(alice);
            try factory.deposit(address(b), _one(id)) {
                assertTrue(expect, "contract accepted what the model rejects");
                if (have[p] >= slots[p]) ++overflow;
                ++have[p];
                assertEq(b.keyOf(id), p, "keyOf");
            } catch (bytes memory err) {
                assertFalse(expect, "contract rejected what the model accepts");
                assertEq(bytes4(err), Batch.NoSlot.selector, "wrong revert");
            }
            assertLe(overflow, anyS, "model invariant");
        }
        if (b.count() < 80) return;
        _assertOrderValid(b, s);
        skip(1 days);
        ready(b);
        b.assemble();
        assertEq(statement.ownerOf(1), address(b));
    }

    /// Exit window: a withdrawal from a Full layout batch gives back exactly the withdrawn palette's slot.
    function test_ExitWindowWithdrawFromFullUndoesBookkeeping() public {
        credits.mintAt(alice, 40, CMY_AT); // 1..40
        credits.mintAt(bob, 41, K_AT); // 41..81
        Batch b = _open(staged, alice, _layout(_checkered()), _range(1, 40));
        _deposit(staged, bob, b, _range(41, 40));
        assertEq(uint256(b.state()), uint256(Batch.State.Full));
        vm.prank(setter);
        staged.proposeAssembler(asm);
        assertEq(uint256(b.phase()), uint256(Batch.Phase.Waiting)); // proposed, not active: never locked
        vm.prank(bob);
        b.withdraw(_one(41));
        assertEq(uint256(b.state()), uint256(Batch.State.Open));
        credits.mintAt(carol, 1, CMY_AT); // 82
        _noSlot(staged, carol, b, 82); // the freed slot is a K slot
        _deposit(staged, bob, b, _one(81)); // a K refills it
        assertEq(uint256(b.state()), uint256(Batch.State.Full));
        skip(3 days);
        staged.activateAssembler();
        skip(1 days);
        _assertOrderValid(b, _checkered());
        ready(b);
        b.assemble();
        assertEq(statement.ownerOf(1), address(b));
    }

    /// A long-open layout batch: withdrawals undo the bookkeeping and the batch drains normally.
    function test_OldLayoutBatchDrains() public {
        uint8[80] memory s;
        for (uint256 i; i < 80; ++i) s[i] = K; // 80 K slots, no any
        credits.mintAt(alice, 20, K_AT); // 1..20: only 20 K exist
        credits.mintAt(alice, 1, CMY_AT); // 21
        Batch b = _open(factory, alice, _layout(s), _range(1, 20));
        _noSlot(factory, alice, b, 21);
        skip(14 days);
        assertEq(uint256(b.state()), uint256(Batch.State.Open)); // open batches don't expire
        vm.prank(alice);
        b.withdraw(_range(1, 20));
        assertEq(b.count(), 0);
        assertEq(credits.ownerOf(1), alice);
        assertEq(b.keyOf(1), 0);
    }

    /// The ERC721 hook path (with a beneficiary) books the palette; a NoSlot in the hook unwinds the transfer.
    function test_HookDepositsBookPalette() public {
        credits.mintAt(alice, 2, K_AT); // 1, 2
        credits.mintAt(alice, 1, CMY_AT); // 3
        uint8[80] memory s;
        s[0] = K;
        s[1] = CMYK; // 1 K slot, 1 CMYK slot, 78 any
        Batch b = _open(factory, alice, _layout(s), _one(3)); // CMY into an any slot: overflow 1
        vm.prank(alice);
        credits.safeTransferFrom(alice, address(b), 1, abi.encode(carol));
        assertEq(b.depositorOf(1), carol);
        assertEq(b.keyOf(1), K);
        credits.mintAt(bob, 78, K_AT); // 4..81
        _deposit(factory, bob, b, _range(4, 40));
        _deposit(factory, bob, b, _range(44, 37)); // 77 more K: overflow 78 = anySlots, count 79
        assertEq(b.count(), 79);
        vm.prank(bob);
        vm.expectRevert(abi.encodeWithSelector(Batch.NoSlot.selector, 81));
        credits.safeTransferFrom(bob, address(b), 81, abi.encode(carol));
        assertEq(credits.ownerOf(81), bob);
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(Batch.NoSlot.selector, 2));
        credits.safeTransferFrom(alice, address(b), 2);
        credits.mintAt(bob, 1, CMYK_AT); // 82
        vm.prank(bob);
        credits.safeTransferFrom(bob, address(b), 82);
        assertEq(uint256(b.state()), uint256(Batch.State.Full));
        assertEq(b.layoutOrder()[1], 82);
    }

    /// One call, one id twice: the second transfer fails, nothing is booked twice.
    function test_DuplicateIdInOneCallReverts() public {
        credits.mintAt(alice, 2, K_AT);
        uint8[80] memory s;
        s[0] = K;
        Batch b = _open(factory, alice, _layout(s), _one(1));
        uint256[] memory ids = new uint256[](2);
        ids[0] = 2;
        ids[1] = 2;
        vm.prank(alice);
        vm.expectRevert();
        factory.deposit(address(b), ids);
        assertEq(b.count(), 1);
    }

    // ---------------------------------------------------------------- 2. gas

    /// Baseline: same 80 under the Deposit arrangement, to isolate what layoutOrder() adds.
    function test_Gas_AssembleDepositBaseline() public {
        credits.mintAt(alice, 40, CMY_AT);
        credits.mintAt(bob, 40, K_AT);
        Batch.Filter memory f;
        vm.prank(alice);
        Batch b = Batch(factory.create("D", f, new uint256[](0), 0, Batch.Arrangement.Deposit, Batch.Split.Equal, 14 days, _range(1, 40), 200, 0));
        _deposit(factory, bob, b, _range(41, 40));
        uint256 g = gasleft();
        ready(b);
        b.assemble();
        g -= gasleft();
        emit log_named_uint("assemble() gas, Deposit baseline", g);
    }

    function test_Gas_AssembleCheckered() public {
        credits.mintAt(alice, 40, CMY_AT);
        credits.mintAt(bob, 40, K_AT);
        Batch b = _open(factory, alice, _layout(_checkered()), _range(1, 40));
        _deposit(factory, bob, b, _range(41, 40));
        skip(1 days);
        uint256 g = gasleft();
        ready(b);
        b.assemble();
        g -= gasleft();
        emit log_named_uint("assemble() gas, checkered", g);
        assertLt(g, 10_000_000);
    }

    /// Worst case for the greedy scan: 79 painted K slots, the one any slot last, and the only CMY deposited
    /// first so every painted slot's search walks past it (Σ scan lengths is maximal, ~80²/2).
    function test_Gas_AssembleWorstCase() public {
        uint8[80] memory s;
        for (uint256 i; i < 79; ++i) s[i] = K;
        credits.mintAt(alice, 1, CMY_AT); // 1
        credits.mintAt(bob, 79, K_AT); // 2..80
        Batch b = _open(factory, alice, _layout(s), _one(1));
        _deposit(factory, bob, b, _range(2, 40));
        _deposit(factory, bob, b, _range(42, 39));
        skip(1 days);
        uint256 g = gasleft();
        ready(b);
        b.assemble();
        g -= gasleft();
        emit log_named_uint("assemble() gas, worst case", g);
        assertLt(g, 10_000_000);
    }

    /// Two palettes in reverse order of the layout: every CMY slot scans past all 40 K deposits.
    function test_Gas_AssembleReversedHalves() public {
        uint8[80] memory s;
        for (uint256 i; i < 40; ++i) s[i] = CMY;
        for (uint256 i = 40; i < 80; ++i) s[i] = K;
        credits.mintAt(alice, 40, K_AT); // 1..40 deposited first
        credits.mintAt(bob, 40, CMY_AT); // 41..80
        Batch b = _open(factory, alice, _layout(s), _range(1, 40));
        _deposit(factory, bob, b, _range(41, 40));
        skip(1 days);
        uint256 g = gasleft();
        ready(b);
        b.assemble();
        g -= gasleft();
        emit log_named_uint("assemble() gas, reversed halves", g);
        assertLt(g, 10_000_000);
    }

    // ---------------------------------------------------------------- 4. odd palettes

    /// A Credit whose colors map to no plate (mask 0; impossible on mainnet) can only ever take an any slot,
    /// never a painted one.
    function test_BlankPaletteOnlyTakesAnySlots() public {
        uint8[80] memory s;
        for (uint256 i; i < 79; ++i) s[i] = K;
        credits.mintAt(alice, 2, credits.art().BLANK()); // 1, 2
        credits.mintAt(bob, 79, K_AT); // 3..81
        Batch b = _open(factory, alice, _layout(s), _one(1));
        assertEq(b.keyOf(1), 0);
        _noSlot(factory, alice, b, 2); // the single any slot is taken
        _deposit(factory, bob, b, _range(3, 40));
        _deposit(factory, bob, b, _range(43, 39));
        assertEq(uint256(b.state()), uint256(Batch.State.Full));
        uint256[] memory order = b.layoutOrder();
        assertEq(order[79], 1, "blank goes to the any slot");
        _assertOrderValid(b, s);
        skip(1 days);
        ready(b);
        b.assemble();
        assertEq(statement.ownerOf(1), address(b));
    }

    /// All 15 palettes as painted slots resolve to distinct masks and are each enforced.
    function test_AllFifteenPalettesEnforced() public {
        uint8[80] memory s;
        for (uint256 i; i < 15; ++i) s[i] = uint8(i + 1); // slots 0..14: masks 1..15; rest any (65)
        for (uint256 m = 1; m <= 15; ++m) credits.mintAt(alice, 2, uint64(m - 1)); // ids 2m-1, 2m have mask m
        Batch b = _open(factory, alice, _layout(s), _one(1));
        assertEq(b.keyOf(1), 1);
        for (uint256 m = 2; m <= 15; ++m) {
            _deposit(factory, alice, b, _one(2 * m - 1));
            assertEq(b.keyOf(2 * m - 1), m);
        }
        // the second of each palette takes an any slot (65 of them), so all 15 fit
        for (uint256 m = 1; m <= 15; ++m) _deposit(factory, alice, b, _one(2 * m));
        assertEq(b.count(), 30);
    }

    // ---------------------------------------------------------------- 5. slot bit math

    /// Slots 63, 64 and 79 straddle the layout0/layout1 boundary and the top nibble of layout1.
    function test_SlotBoundaries() public {
        uint8[80] memory s;
        for (uint256 i; i < 80; ++i) s[i] = K;
        s[63] = CMY;
        s[64] = CMYK;
        s[79] = CMY;
        Batch.Filter memory f = _layout(s);
        assertEq(f.layout1 >> 60, CMY); // top nibble
        assertEq((f.layout0 >> 252) & 15, CMY);
        assertEq(f.layout1 & 15, CMYK);
        credits.mintAt(alice, 3, CMY_AT); // 1..3
        credits.mintAt(alice, 2, CMYK_AT); // 4, 5
        credits.mintAt(bob, 78, K_AT); // 6..83
        Batch b = _open(factory, alice, f, _one(1));
        uint8[80] memory l = b.layout();
        for (uint256 i; i < 80; ++i) assertEq(l[i], s[i], "layout()");
        _deposit(factory, alice, b, _one(2));
        _noSlot(factory, alice, b, 3); // 2 CMY slots only
        _deposit(factory, alice, b, _one(4));
        _noSlot(factory, alice, b, 5); // 1 CMYK slot only
        vm.prank(alice);
        b.withdraw(_one(4));
        _deposit(factory, bob, b, _range(6, 40));
        _deposit(factory, bob, b, _range(46, 37)); // 77 K: count 79
        _noSlot(factory, bob, b, 83); // 77 K slots only; the free slot is the CMYK one
        _deposit(factory, alice, b, _one(4));
        assertEq(b.count(), 80);
        uint256[] memory order = b.layoutOrder();
        assertEq(order[63], 1);
        assertEq(order[79], 2);
        assertEq(order[64], 4);
        _assertOrderValid(b, s);
    }

    /// Only the top nibble of layout1 set (layout0 == 0): still a layout; the one painted slot is reserved.
    function test_SinglePaintedSlotInLayout1Reserved() public {
        uint8[80] memory s;
        s[79] = K;
        credits.mintAt(alice, 80, CMY_AT); // 1..80
        credits.mintAt(bob, 1, K_AT); // 81
        Batch b = _open(factory, alice, _layout(s), _range(1, 79));
        _noSlot(factory, alice, b, 80); // 79 any slots full; slot 79 waits for a K
        _deposit(factory, bob, b, _one(81));
        uint256[] memory order = b.layoutOrder();
        assertEq(order[79], 81);
        _assertOrderValid(b, s);
    }

    /// Both words zero cannot pass as a layout, and a layout cannot ride under another arrangement.
    function test_NoHiddenLayoutBits() public {
        Batch.Filter memory f; // every nibble zero: exactly layout0 == 0 && layout1 == 0
        credits.mintAt(alice, 1, K_AT);
        vm.prank(alice);
        vm.expectRevert(Batch.BadFilter.selector);
        factory.create("L", f, new uint256[](0), 0, Batch.Arrangement.Layout, Batch.Split.Equal, 14 days, _one(1), 200, 0);
        f.layout1 = 1 << 60;
        vm.prank(alice);
        vm.expectRevert(Batch.BadFilter.selector);
        factory.create("L", f, new uint256[](0), 0, Batch.Arrangement.Deposit, Batch.Split.Equal, 14 days, _one(1), 200, 0);
    }

    // ---------------------------------------------------------------- 6. sweeps

    /// depositFor is all-or-nothing: a bundle where one id has no slot reverts whole, so a Sweeper call that
    /// bought such a bundle reverts after Seaport (nothing settles, but the sweep fails).
    function test_DepositForAtomicOnNoSlot() public {
        credits.mintAt(alice, 40, CMY_AT); // 1..40
        credits.mintAt(bob, 1, K_AT); // 41
        credits.mintAt(bob, 1, CMY_AT); // 42
        Batch b = _open(factory, alice, _layout(_checkered()), _range(1, 40));
        uint256[] memory ids = new uint256[](2);
        ids[0] = 41;
        ids[1] = 42;
        assertTrue(b.passes(41) && b.passes(42)); // passes() knows nothing about slots
        vm.prank(bob);
        vm.expectRevert(abi.encodeWithSelector(Batch.NoSlot.selector, 42));
        factory.depositFor(address(b), ids, carol);
        assertEq(credits.ownerOf(41), bob);
        assertEq(b.count(), 40);
    }
}
