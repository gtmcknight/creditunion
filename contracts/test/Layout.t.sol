// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {Batch, IRatings} from "../src/Batch.sol";
import {BatchFactory} from "../src/BatchFactory.sol";
import {MockAssembler} from "../src/MockAssembler.sol";
import {ICredits} from "../src/interfaces/ICredits.sol";
import {MockCredits} from "../src/mocks/MockCredits.sol";
import {MockStatement} from "../src/mocks/MockStatement.sol";

/// @notice Palette layouts. MockCredits: even ids print CMY (mask 7), odd ids print K (mask 8).
contract LayoutTest is Test {
    uint256 constant CMY = 7;
    uint256 constant K = 8;
    MockCredits credits;
    MockStatement statement;
    BatchFactory factory;
    Batch.Filter noFilter;
    address alice = makeAddr("alice");
    address bob = makeAddr("bob");
    address carol = makeAddr("carol");
    address fee = makeAddr("fee");

    function setUp() public {
        credits = new MockCredits();
        statement = new MockStatement(ICredits(address(credits)));
        factory = new BatchFactory(ICredits(address(credits)), IRatings(address(0)), new MockAssembler(statement), address(0), fee, 200, 0, 1);
        for (uint256 i; i < 5; ++i) credits.mint(alice, 40); // 1..200
        for (uint256 i; i < 5; ++i) credits.mint(bob, 40); // 201..400
        credits.mint(carol, 40); // 401..440
        for (uint256 i; i < 3; ++i) {
            address u = [alice, bob, carol][i];
            vm.prank(u);
            credits.setApprovalForAll(address(factory), true);
            vm.deal(u, 100 ether);
        }
    }

    /// Ids of one parity from `from`, n of them.
    function _parity(uint256 from, uint256 n, bool even) internal pure returns (uint256[] memory a) {
        a = new uint256[](n);
        uint256 id = from;
        for (uint256 i; i < n; ++id) {
            if ((id % 2 == 0) == even) a[i++] = id;
        }
    }

    function _one(uint256 id) internal pure returns (uint256[] memory a) {
        a = new uint256[](1);
        a[0] = id;
    }

    /// Pack 80 slot masks into Filter.layout0/layout1.
    function _layout(uint8[80] memory slots) internal pure returns (Batch.Filter memory f) {
        for (uint256 i; i < 80; ++i) {
            if (i < 64) f.layout0 |= uint256(slots[i]) << (4 * i);
            else f.layout1 |= uint64(slots[i]) << uint64(4 * (i - 64));
        }
    }

    function _checkered() internal pure returns (uint8[80] memory s) {
        for (uint256 i; i < 80; ++i) s[i] = ((i / 8 + i % 8) % 2 == 0) ? uint8(CMY) : uint8(K);
    }

    function _open(Batch.Filter memory f, uint256[] memory ids) internal returns (Batch b) {
        vm.prank(alice);
        b = Batch(factory.create("L", f, new uint256[](0), 0, Batch.Arrangement.Layout, Batch.Split.Equal, 14 days, ids, 200, 0));
    }

    function test_LayoutRequiresLayoutArrangement() public {
        Batch.Filter memory f = _layout(_checkered());
        vm.prank(alice);
        vm.expectRevert(Batch.BadFilter.selector);
        factory.create("L", f, new uint256[](0), 0, Batch.Arrangement.Deposit, Batch.Split.Equal, 14 days, _one(2), 200, 0);
        vm.prank(alice);
        vm.expectRevert(Batch.BadFilter.selector);
        factory.create("L", noFilter, new uint256[](0), 0, Batch.Arrangement.Layout, Batch.Split.Equal, 14 days, _one(2), 200, 0);
    }

    /// 40 CMY slots + 40 K slots: the 41st of either palette has no slot.
    function test_SlotsAreEnforced() public {
        Batch b = _open(_layout(_checkered()), _parity(2, 40, true)); // alice: 40 CMY
        assertEq(b.keyOf(2), 7);
        uint8[80] memory l = b.layout();
        assertEq(l[0], 7);
        assertEq(l[1], 8);
        vm.prank(bob);
        vm.expectRevert(abi.encodeWithSelector(Batch.NoSlot.selector, 202));
        factory.deposit(address(b), _one(202)); // a 41st CMY
        vm.prank(bob);
        factory.deposit(address(b), _parity(201, 40, false)); // 40 K fill it
        assertEq(uint256(b.state()), uint256(Batch.State.Full));
    }

    /// Withdrawing gives the slot back; re-depositing a different palette then works.
    function test_WithdrawFreesSlot() public {
        Batch b = _open(_layout(_checkered()), _parity(2, 40, true));
        vm.prank(alice);
        b.withdraw(_one(2));
        assertEq(b.keyOf(2), 0);
        vm.prank(bob);
        factory.deposit(address(b), _one(202)); // CMY slot is free again
        vm.prank(bob);
        vm.expectRevert(abi.encodeWithSelector(Batch.NoSlot.selector, 204));
        factory.deposit(address(b), _one(204));
    }

    /// "Any" slots absorb the overflow of whatever palette, but only as many as there are.
    function test_AnySlotsAbsorbOverflow() public {
        uint8[80] memory s; // 10 K slots, 70 any
        for (uint256 i; i < 10; ++i) s[i] = uint8(K);
        Batch b = _open(_layout(s), _parity(2, 40, true)); // 40 CMY → all into any slots (overflow 40 ≤ 70)
        vm.prank(bob);
        factory.deposit(address(b), _parity(202, 30, true)); // 70 CMY: any slots full
        vm.prank(bob);
        vm.expectRevert(abi.encodeWithSelector(Batch.NoSlot.selector, 262));
        factory.deposit(address(b), _one(262)); // a 71st CMY: nowhere to go
        vm.prank(bob);
        factory.deposit(address(b), _parity(201, 10, false)); // the 10 K slots
        assertEq(uint256(b.state()), uint256(Batch.State.Full));
    }

    /// The sheet order follows the layout: painted slots get their palette in deposit order, the rest fill in.
    function test_LayoutOrder() public {
        uint8[80] memory s = _checkered();
        s[79] = 0; // last slot: any
        Batch b = _open(_layout(s), _parity(1, 40, false)); // alice: 40 K first (odd ids)
        vm.prank(bob);
        factory.deposit(address(b), _parity(202, 40, true)); // bob: 40 CMY
        uint256[] memory order = b.layoutOrder();
        assertEq(order.length, 80);
        for (uint256 i; i < 79; ++i) {
            uint256 want = ((i / 8 + i % 8) % 2 == 0) ? CMY : K;
            assertEq(b.keyOf(order[i]), want, "slot palette");
        }
        assertEq(order[0], 202); // first CMY slot takes the earliest CMY deposit
        assertEq(order[1], 1); // first K slot takes the earliest K deposit
        // every id exactly once
        for (uint256 i; i < 80; ++i) {
            for (uint256 j; j < i; ++j) assertTrue(order[i] != order[j]);
        }
        // burn after the creator's day: the assembler receives that order
        skip(1 days);
        vm.prank(carol);
        b.assemble();
        assertEq(statement.ownerOf(1), address(b));
    }

    /// A full layout batch burns as painted, by anyone, at once: there is no creator's turn.
    function test_LayoutBurnsAtOnceByAnyone() public {
        Batch b = _open(_layout(_checkered()), _parity(2, 40, true));
        vm.prank(bob);
        factory.deposit(address(b), _parity(201, 40, false));
        vm.prank(carol);
        b.assemble();
        assertEq(statement.ownerOf(1), address(b));
    }

    /// Any sequence of deposits and withdrawals keeps the batch completable: a Full layout batch always burns.
    function testFuzz_AlwaysCompletable(uint256 seed) public {
        uint8[80] memory s;
        uint256 kSlots = seed % 60; // 0..59 K slots
        uint256 cSlots = (seed >> 8) % (80 - kSlots); // some CMY slots, rest any
        if (kSlots + cSlots == 0) kSlots = 1; // a layout needs at least one painted slot
        for (uint256 i; i < kSlots; ++i) s[i] = uint8(K);
        for (uint256 i; i < cSlots; ++i) s[kSlots + i] = uint8(CMY);
        // seed with one Credit that has somewhere to go
        Batch b = _open(_layout(s), _one(cSlots + (80 - kSlots - cSlots) > 0 ? 2 : 1));
        uint256[] memory pool = new uint256[](400);
        for (uint256 i; i < 400; ++i) pool[i] = i + 1; // alice 1..200, bob 201..400
        uint256 r = seed;
        for (uint256 step; step < 300 && b.count() < 80; ++step) {
            r = uint256(keccak256(abi.encode(r)));
            uint256 id = pool[r % 400];
            address owner = id <= 200 ? alice : bob;
            if (b.depositorOf(id) != address(0)) {
                if (r % 5 == 0) {
                    vm.prank(owner);
                    b.withdraw(_one(id));
                }
                continue;
            }
            if (credits.ownerOf(id) != owner) continue;
            vm.prank(owner);
            try factory.deposit(address(b), _one(id)) {} catch {}
        }
        if (b.count() < 80) return; // fuzz did not fill it; fine
        uint256[] memory order = b.layoutOrder();
        for (uint256 i; i < 80; ++i) {
            if (s[i] != 0) assertEq(b.keyOf(order[i]), s[i]);
        }
        skip(1 days);
        b.assemble();
        assertEq(statement.ownerOf(1), address(b));
    }

    // ---------------------------------------------------------------- layouts painted with other traits

    /// Plates layout: CMY Credits (even ids) have 3 inks, K Credits (odd ids) 1.
    function test_PlatesLayout() public {
        uint8[80] memory s;
        for (uint256 i; i < 80; ++i) s[i] = i < 40 ? 3 : 1;
        Batch.Filter memory f = _layout(s);
        f.layoutTrait = 4;
        Batch b = _open(f, _parity(2, 40, true)); // 40 three-ink Credits fill the top half
        assertEq(b.keyOf(2), 3);
        vm.prank(bob);
        vm.expectRevert(abi.encodeWithSelector(Batch.NoSlot.selector, 202));
        factory.deposit(address(b), _one(202)); // no three-ink slot left, no any slots
        vm.prank(bob);
        factory.deposit(address(b), _parity(201, 40, false));
        assertEq(b.keyOf(201), 1);
        uint256[] memory order = b.layoutOrder();
        for (uint256 i; i < 80; ++i) assertEq(b.keyOf(order[i]), s[i], "slot value");
        b.assemble();
    }

    /// Eights layout: the mock gives (id / 2) % 3 eights, so keys are 1, 2, 3.
    function test_EightsLayout() public {
        uint8[80] memory s;
        for (uint256 i; i < 80; ++i) s[i] = i < 10 ? 3 : 0; // ten slots want two eights, the rest any
        Batch.Filter memory f = _layout(s);
        f.layoutTrait = 1;
        uint256[] memory two = new uint256[](10);
        uint256 k;
        for (uint256 id = 1; k < 10; ++id) if ((id / 2) % 3 == 2) two[k++] = id;
        Batch b = _open(f, two);
        for (uint256 i; i < 10; ++i) assertEq(b.keyOf(two[i]), 3);
        uint256[] memory order = b.layoutOrder();
        for (uint256 i; i < 10; ++i) assertEq(b.keyOf(order[i]), 3);
    }

    function test_LayoutTraitValidated() public {
        uint8[80] memory s;
        s[0] = 7; // no Credit has 7 inks
        Batch.Filter memory f = _layout(s);
        f.layoutTrait = 4;
        vm.prank(alice);
        vm.expectRevert(Batch.BadFilter.selector);
        factory.create("L", f, new uint256[](0), 0, Batch.Arrangement.Layout, Batch.Split.Equal, 14 days, _one(2), 200, 0);

        f.layoutTrait = 5; // no such trait
        s[0] = 1;
        Batch.Filter memory g = _layout(s);
        g.layoutTrait = 5;
        vm.prank(alice);
        vm.expectRevert(Batch.BadFilter.selector);
        factory.create("L", g, new uint256[](0), 0, Batch.Arrangement.Layout, Batch.Split.Equal, 14 days, _one(2), 200, 0);

        Batch.Filter memory h; // a trait with no layout
        h.layoutTrait = 1;
        vm.prank(alice);
        vm.expectRevert(Batch.BadFilter.selector);
        factory.create("L", h, new uint256[](0), 0, Batch.Arrangement.Deposit, Batch.Split.Equal, 14 days, _one(2), 200, 0);
    }
}
