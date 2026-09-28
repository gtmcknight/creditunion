// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {ratingsOf} from "../script/RatingsOf.sol";
import {Batch, IRatings} from "../src/Batch.sol";
import {BatchFactory} from "../src/BatchFactory.sol";
import {MockAssembler} from "../src/mocks/MockAssembler.sol";
import {ICredits} from "../src/interfaces/ICredits.sol";
import {MockCredits} from "../src/mocks/MockCredits.sol";
import {MockStatement} from "../src/mocks/MockStatement.sol";
import {ready} from "./utils/Ready.sol";

/// @dev A member contract whose receive() misbehaves until `friendly` is set.
contract Hostile {
    enum Kind {
        Revert,
        BurnGas,
        ReturnBomb,
        ReenterClaim,
        ReenterSettle,
        ReenterWithdrawOwed
    }

    Kind public kind;
    Batch public batch;
    bool public friendly;

    constructor(Kind k, Batch b) {
        kind = k;
        batch = b;
    }

    function setFriendly(bool f) external {
        friendly = f;
    }

    receive() external payable {
        if (friendly) return;
        if (kind == Kind.Revert) revert("no");
        if (kind == Kind.BurnGas) {
            while (true) {}
        }
        if (kind == Kind.ReturnBomb) {
            assembly {
                revert(0, 60000)
            }
        }
        bytes memory data;
        if (kind == Kind.ReenterClaim) data = abi.encodeCall(Batch.claim, (address(this)));
        else if (kind == Kind.ReenterSettle) data = abi.encodeCall(Batch.settle, ());
        else data = abi.encodeCall(Batch.withdrawOwed, ());
        (bool ok,) = address(batch).call(data);
        // A blocked re-entry refuses the ETH; a re-entry that got through would accept it (and fail the test).
        if (!ok) revert("reentry blocked");
    }
}

/// @dev Needs ~30k gas in receive, like a Safe proxy with a fallback handler and an event.
contract SafeLike {
    uint256 public hits;

    receive() external payable {
        uint256 g = gasleft();
        ++hits; // cold SSTORE 0 -> 1: ~22k
        while (g - gasleft() < 30_000) {}
    }
}

contract SettlePaysTest is Test {
    MockCredits credits;
    MockStatement statement;
    BatchFactory factory;
    Batch.Filter noFilter;
    address creator = makeAddr("creator");
    address funder = makeAddr("funder");
    address fee = makeAddr("fee");
    address stranger = makeAddr("stranger");
    address bidder = address(0xB1D);

    uint256 constant PROTOCOL_BPS = 200;
    uint256 constant CREATOR_BPS = 300;

    function setUp() public {
        credits = new MockCredits();
        statement = new MockStatement(ICredits(address(credits)));
        factory = new BatchFactory(
            ICredits(address(credits)), IRatings(address(0)), new MockAssembler(statement), address(0), fee, PROTOCOL_BPS, CREATOR_BPS, 0
        );
        credits.mint(funder, 80); // 1..80
        vm.prank(funder);
        credits.setApprovalForAll(address(factory), true);
    }

    // ---------------------------------------------------------------- helpers

    function _range(uint256 from, uint256 n) internal pure returns (uint256[] memory a) {
        a = new uint256[](n);
        for (uint256 i; i < n; ++i) a[i] = from + i;
    }

    function _open(Batch.Split split) internal returns (Batch b) {
        vm.prank(creator);
        b = Batch(
            factory.create(
                "S", noFilter, new uint256[](0), 0, Batch.Arrangement.Deposit, split, 14 days, new uint256[](0), PROTOCOL_BPS, CREATOR_BPS, ratingsOf(address(factory))
            )
        );
    }

    /// Funder deposits `n` Credits recorded to `to`, continuing from `next`.
    function _give(Batch b, address to, uint256 next, uint256 n) internal returns (uint256) {
        vm.prank(funder);
        factory.depositFor(address(b), _range(next, n), to);
        return next + n;
    }

    function _auction(Batch b, uint256 amount) internal {
        ready(b);
        b.assemble();
        vm.deal(bidder, amount);
        vm.prank(bidder);
        b.bid{value: amount}();
        skip(1 days);
    }

    function _fees(uint256 amount, Batch b) internal view returns (uint256 protocol, uint256 creatorFee) {
        creatorFee = amount * CREATOR_BPS / 10_000;
        uint256 units = b.split() == Batch.Split.Equal ? 80 : 12_640;
        uint256 per = (amount - amount * PROTOCOL_BPS / 10_000 - creatorFee) / units;
        protocol = amount - creatorFee - per * units;
    }

    function _balances(address[] memory who) internal view returns (uint256[] memory out) {
        out = new uint256[](who.length);
        for (uint256 i; i < who.length; ++i) out[i] = who[i].balance;
    }

    /// Checks every member was either paid exactly or left exactly claimable, and every wei is accounted for.
    function _checkConservation(Batch b, address[] memory members, uint256[] memory before, uint256 amount)
        internal
        view
        returns (uint256 paid, uint256 owedToMembers)
    {
        uint256 per = b.payoutPerUnit();
        for (uint256 i; i < members.length; ++i) {
            address m = members[i];
            uint256 share = b.unitsOf(m) * per;
            uint256 got = m.balance - before[i];
            if (b.claimed(m)) {
                assertEq(got, share, "paid exactly");
                assertEq(b.claimable(m), 0);
            } else {
                assertEq(got, 0, "unpaid got nothing");
                assertEq(b.claimable(m), share, "unpaid stays claimable");
            }
            paid += got;
            owedToMembers += b.claimable(m);
        }
        (uint256 protocol, uint256 creatorFee) = _fees(amount, b);
        assertEq(fee.balance, protocol, "protocol fee + dust");
        assertEq(creator.balance, creatorFee, "creator fee");
        assertEq(paid + owedToMembers + protocol + creatorFee, amount, "conservation");
        assertEq(address(b).balance, owedToMembers + b.owed(fee) + b.owed(creator), "batch holds only what is owed");
    }

    // ---------------------------------------------------------------- 1, 2: plain members

    function _threeMembers(Batch.Split split, uint256 a, uint256 bb) internal {
        Batch b = _open(split);
        address[] memory m = new address[](3);
        m[0] = makeAddr("alice");
        m[1] = makeAddr("bob");
        m[2] = makeAddr("carol");
        uint256 next = 1;
        next = _give(b, m[0], next, a);
        next = _give(b, m[1], next, bb);
        next = _give(b, m[2], next, 80 - a - bb);
        uint256 amount = 4 ether + 12_345;
        _auction(b, amount);
        uint256[] memory before = _balances(m);
        b.settle();
        uint256 per = b.payoutPerUnit();
        for (uint256 i; i < 3; ++i) {
            assertEq(m[i].balance - before[i], b.unitsOf(m[i]) * per, "paid exactly its share");
            assertEq(b.claimable(m[i]), 0);
            assertTrue(b.claimed(m[i]));
            vm.expectRevert(Batch.NothingToClaim.selector);
            b.claim(m[i]);
        }
        _checkConservation(b, m, before, amount);
        assertEq(address(b).balance, 0);
    }

    function test_SettlePaysEveryMemberEqual() public {
        _threeMembers(Batch.Split.Equal, 10, 30);
    }

    function test_SettlePaysEveryMemberEarly() public {
        _threeMembers(Batch.Split.Early, 10, 30);
    }

    function test_SettlePaysEveryMemberEarlyInterleaved() public {
        Batch b = _open(Batch.Split.Early);
        address[] memory m = new address[](3);
        m[0] = makeAddr("alice");
        m[1] = makeAddr("bob");
        m[2] = makeAddr("carol");
        uint256 next = 1;
        for (uint256 i; i < 80; ++i) next = _give(b, m[(i * 7 + i / 5) % 3], next, 1);
        uint256 amount = 7 ether + 1;
        _auction(b, amount);
        uint256[] memory before = _balances(m);
        b.settle();
        for (uint256 i; i < 3; ++i) {
            assertEq(m[i].balance - before[i], b.unitsOf(m[i]) * b.payoutPerUnit());
            assertTrue(b.claimed(m[i]));
        }
        _checkConservation(b, m, before, amount);
        assertEq(address(b).balance, 0);
    }

    // ---------------------------------------------------------------- 3: 80 hostile members

    function test_80DistinctMembers_AllHostile() public {
        Batch b = _open(Batch.Split.Early);
        address[] memory m = new address[](80);
        for (uint256 i; i < 80; ++i) {
            m[i] = address(new Hostile(Hostile.Kind(i % 6), b));
            _give(b, m[i], i + 1, 1);
        }
        uint256 amount = 10 ether + 777;
        _auction(b, amount);
        uint256[] memory before = _balances(m);

        uint256 g = gasleft();
        b.settle();
        uint256 used = g - gasleft();
        emit log_named_uint("settle gas, 80 hostile members", used);
        assertLt(used, 6_000_000);
        assertTrue(b.settled());

        uint256 per = b.payoutPerUnit();
        for (uint256 i; i < 80; ++i) {
            assertFalse(b.claimed(m[i]));
            assertEq(b.claimable(m[i]), (237 - 2 * i) * per, "hostile keeps its share claimable");
            assertEq(m[i].balance, before[i]);
        }
        (uint256 paid, uint256 left) = _checkConservation(b, m, before, amount);
        assertEq(paid, 0);
        assertEq(address(b).balance, left);

        // A hostile member turns friendly; a stranger claims for it and it gets paid.
        for (uint256 k; k < 6; ++k) {
            address h = m[k];
            Hostile(payable(h)).setFriendly(true);
            uint256 share = b.claimable(h);
            vm.prank(stranger);
            b.claim(h);
            assertEq(h.balance, share);
            assertEq(b.claimable(h), 0);
            assertTrue(b.claimed(h));
            vm.expectRevert(Batch.NothingToClaim.selector);
            b.claim(h);
        }
        // Still hostile: claim reverts, share stays claimable.
        vm.prank(stranger);
        vm.expectRevert(Batch.PaymentFailed.selector);
        b.claim(m[6]);
        assertGt(b.claimable(m[6]), 0);
    }

    function test_80DistinctMembers_AllGasBurners_Equal() public {
        Batch b = _open(Batch.Split.Equal);
        address[] memory m = new address[](80);
        for (uint256 i; i < 80; ++i) {
            m[i] = address(new Hostile(Hostile.Kind.BurnGas, b));
            _give(b, m[i], i + 1, 1);
        }
        uint256 amount = 3 ether;
        _auction(b, amount);
        uint256[] memory before = _balances(m);
        uint256 g = gasleft();
        b.settle();
        uint256 used = g - gasleft();
        emit log_named_uint("settle gas, 80 gas burners", used);
        // Worst case: every member eats its full 50k cap. Above 6M (see report); bound it so it can't grow.
        assertLt(used, 8_000_000);
        _checkConservation(b, m, before, amount);
    }

    function test_80DistinctEOAs_Gas() public {
        Batch b = _open(Batch.Split.Early);
        address[] memory m = new address[](80);
        for (uint256 i; i < 80; ++i) {
            m[i] = makeAddr(string(abi.encodePacked("fresh", i)));
            _give(b, m[i], i + 1, 1);
        }
        uint256 amount = 3 ether;
        _auction(b, amount);
        uint256[] memory before = _balances(m);
        uint256 g = gasleft();
        b.settle();
        emit log_named_uint("settle gas, 80 fresh EOAs", g - gasleft());
        _checkConservation(b, m, before, amount);
        assertEq(address(b).balance, 0);
    }

    // ---------------------------------------------------------------- 4: mixed

    function test_MixedMembers() public {
        Batch b = _open(Batch.Split.Early);
        address[] memory m = new address[](8);
        uint256 next = 1;
        uint256[8] memory n = [uint256(5), 15, 3, 20, 7, 10, 12, 8];
        for (uint256 i; i < 8; ++i) {
            m[i] = i % 2 == 0 ? makeAddr(string(abi.encodePacked("eoa", i))) : address(new Hostile(Hostile.Kind.Revert, b));
            next = _give(b, m[i], next, n[i]);
        }
        uint256 amount = 5 ether + 3;
        _auction(b, amount);
        uint256[] memory before = _balances(m);
        b.settle();
        for (uint256 i; i < 8; ++i) {
            if (i % 2 == 0) {
                assertTrue(b.claimed(m[i]));
                assertEq(m[i].balance - before[i], b.unitsOf(m[i]) * b.payoutPerUnit());
            } else {
                assertFalse(b.claimed(m[i]));
                assertEq(b.claimable(m[i]), b.unitsOf(m[i]) * b.payoutPerUnit());
            }
        }
        _checkConservation(b, m, before, amount);
    }

    // ---------------------------------------------------------------- 5: gas-limited settle

    function _eoaBatch(uint256 members) internal returns (Batch b, address[] memory m) {
        b = _open(Batch.Split.Equal);
        m = new address[](members);
        uint256 next = 1;
        for (uint256 i; i < members; ++i) {
            m[i] = makeAddr(string(abi.encodePacked("member", i)));
            next = _give(b, m[i], next, i == members - 1 ? 81 - next : 80 / members);
        }
        _auction(b, 2 ether);
    }

    /// Returns true if settle succeeded; asserts the all-or-nothing property either way.
    function _settleWithGas(Batch b, address[] memory m, uint256 x) internal returns (bool ok) {
        uint256[] memory before = _balances(m);
        uint256 feeBefore = fee.balance;
        uint256 held = address(b).balance;
        (ok,) = address(b).call{gas: x}(abi.encodeCall(Batch.settle, ()));
        if (!ok) {
            assertFalse(b.settled(), "reverted settle leaves settled false");
            assertEq(address(b).balance, held, "bid still held");
            assertEq(fee.balance, feeBefore);
            for (uint256 i; i < m.length; ++i) {
                assertEq(m[i].balance, before[i], "no member paid on revert");
                assertFalse(b.claimed(m[i]));
            }
        } else {
            assertTrue(b.settled());
            for (uint256 i; i < m.length; ++i) {
                assertTrue(b.claimed(m[i]), "EOA member left unpaid by a successful settle");
                assertEq(b.claimable(m[i]), 0);
                assertEq(m[i].balance - before[i], b.unitsOf(m[i]) * b.payoutPerUnit());
            }
            assertEq(address(b).balance, 0);
        }
    }

    function test_SettleWithTooLittleGasReverts() public {
        (Batch b, address[] memory m) = _eoaBatch(20);
        uint256 snap = vm.snapshotState();
        // Binary search the smallest gas that settles.
        uint256 lo = 30_000;
        uint256 hi = 3_000_000;
        while (lo + 1 < hi) {
            uint256 mid = (lo + hi) / 2;
            vm.revertToState(snap);
            (bool ok,) = address(b).call{gas: mid}(abi.encodeCall(Batch.settle, ()));
            if (ok) hi = mid;
            else lo = mid;
        }
        emit log_named_uint("min gas to settle 20 EOA members", hi);
        // Sweep around the threshold and through the whole payment loop.
        for (uint256 x = 30_000; x < hi + 100_000; x += 7919) {
            vm.revertToState(snap);
            _settleWithGas(b, m, x);
        }
        for (uint256 x = hi - 4000; x < hi + 4000; x += 37) {
            vm.revertToState(snap);
            _settleWithGas(b, m, x);
        }
    }

    function testFuzz_SettleGasAllOrNothing(uint256 x) public {
        (Batch b, address[] memory m) = _eoaBatch(20);
        x = bound(x, 21_000, 3_000_000);
        _settleWithGas(b, m, x);
    }

    // ---------------------------------------------------------------- 6: random hostility

    function testFuzz_ConservationWithRandomHostility(uint256 seed, uint96 amount) public {
        amount = uint96(bound(amount, 0.01 ether, 1_000_000 ether));
        Batch.Split split = seed & 1 == 0 ? Batch.Split.Equal : Batch.Split.Early;
        Batch b = _open(split);
        uint256 count = bound(uint256(keccak256(abi.encode(seed, "n"))), 1, 30);
        address[] memory m = new address[](count);
        bool[] memory hostile = new bool[](count);
        for (uint256 i; i < count; ++i) {
            uint256 r = uint256(keccak256(abi.encode(seed, i))) % 4;
            hostile[i] = r == 1 || r == 2;
            if (r == 0) m[i] = makeAddr(string(abi.encodePacked("eoa", i)));
            else if (r == 1) m[i] = address(new Hostile(Hostile.Kind.Revert, b));
            else if (r == 2) m[i] = address(new Hostile(Hostile.Kind.BurnGas, b));
            else m[i] = address(new SafeLike());
        }
        // Random positions: each of the 80 Credits goes to a random member; make sure every member gets one.
        for (uint256 id = 1; id <= 80; ++id) {
            uint256 who = id <= count ? id - 1 : uint256(keccak256(abi.encode(seed, "p", id))) % count;
            _give(b, m[who], id, 1);
        }
        _auction(b, amount);
        uint256[] memory before = _balances(m);
        b.settle();
        _checkConservation(b, m, before, amount);
        for (uint256 i; i < count; ++i) {
            if (!hostile[i]) assertTrue(b.claimed(m[i]), "cooperative member paid");
            else assertFalse(b.claimed(m[i]), "hostile member left claimable");
        }
    }

    // ---------------------------------------------------------------- 7: Safe-like

    function test_SafeLikeMemberPaid() public {
        Batch b = _open(Batch.Split.Equal);
        SafeLike s = new SafeLike();
        address[] memory m = new address[](2);
        m[0] = address(s);
        m[1] = makeAddr("alice");
        _give(b, m[0], 1, 40);
        _give(b, m[1], 41, 40);
        uint256 amount = 1 ether;
        _auction(b, amount);
        uint256[] memory before = _balances(m);
        b.settle();
        assertEq(s.hits(), 1);
        assertTrue(b.claimed(address(s)));
        assertEq(address(s).balance, 40 * b.payoutPerUnit());
        _checkConservation(b, m, before, amount);
        assertEq(address(b).balance, 0);
    }
}
