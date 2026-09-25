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

/// @dev A depositor that tries to re-enter claim()/withdraw() from its ETH receive hook.
contract ReentrantClaimer {
    Batch b;
    address victim;
    uint256 public hits;

    function arm(Batch b_, address victim_) external {
        b = b_;
        victim = victim_;
    }

    receive() external payable {
        ++hits;
        // try to steal the victim's claim or a second claim of our own; both must fail
        try b.claim(victim) {} catch {}
        try b.claim(address(this)) {} catch {}
    }
}

/// @notice Round 4: attacks on the Early split (positions, exactness, sharesOf/_ids coherence, gas).
contract Adversarial4Test is Test {
    MockCredits credits;
    MockStatement statement;
    MockAssembler asm;
    BatchFactory factory; // assembler active from the start
    BatchFactory staged; // no assembler yet: propose → exit window → activate
    address setter = makeAddr("setter");
    address alice = makeAddr("alice");
    address bob = makeAddr("bob");
    address carol = makeAddr("carol");
    address fee = makeAddr("fee");
    Batch.Filter noFilter;

    uint256 constant FEE_BPS = 200;

    function setUp() public {
        credits = new MockCredits();
        statement = new MockStatement(ICredits(address(credits)));
        asm = new MockAssembler(statement);
        factory = new BatchFactory(ICredits(address(credits)), IRatings(address(0)), asm, address(0), fee, FEE_BPS, 0, 1);
        staged = new BatchFactory(ICredits(address(credits)), IRatings(address(0)), IAssembler(address(0)), setter, fee, FEE_BPS, 0, 1);
        credits.mint(alice, 40); // 1..40
        credits.mint(alice, 40); // 41..80
        credits.mint(bob, 40); // 81..120
        credits.mint(bob, 40); // 121..160
        credits.mint(carol, 40); // 161..200
        credits.mint(carol, 40); // 201..240
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

    function _open(BatchFactory f, address who, uint256[] memory ids, Batch.Split split, Batch.Arrangement arr) internal returns (Batch b) {
        vm.prank(who);
        b = Batch(f.create("S", noFilter, new uint256[](0), 0, arr, split, 14 days, ids, FEE_BPS, 0));
    }

    function _bidAndSettle(Batch b, uint256 amount) internal {
        vm.deal(address(0xB1D), amount);
        vm.prank(address(0xB1D));
        b.bid{value: amount}();
        skip(1 days);
        b.settle();
    }

    /// Reference model: units from the on-chain slot order (what unitsOf must agree with).
    function _modelUnits(Batch b, address who) internal view returns (uint256 u) {
        (, address[] memory deps) = b.slots();
        for (uint256 i; i < deps.length; ++i) {
            if (deps[i] == who) u += 237 - 2 * i;
        }
    }

    /// Σ claimable + protocol fee (incl. dust) + creator fee must equal highBid; then every claim empties the batch.
    function _assertConserved(Batch b, address[] memory ds, uint256 amount) internal {
        uint256 sum;
        for (uint256 i; i < ds.length; ++i) sum += b.claimable(ds[i]);
        uint256 creatorFee = amount * b.creatorFeeBps() / 10_000;
        uint256 paidFee = fee.balance;
        assertEq(sum + paidFee + creatorFee, amount, "claimable + fees != highBid");
        uint256 before;
        for (uint256 i; i < ds.length; ++i) before += ds[i].balance;
        for (uint256 i; i < ds.length; ++i) {
            if (b.claimable(ds[i]) > 0) b.claim(ds[i]);
        }
        uint256 after_;
        for (uint256 i; i < ds.length; ++i) after_ += ds[i].balance;
        assertEq(after_ - before, sum, "claims paid != claimable");
        assertEq(address(b).balance, 0, "dust left in batch");
    }

    // ---------------------------------------------------------------- 1. exactness / conservation

    /// 80 distinct depositors, one Credit each, half via the factory and half via the ERC721 hook.
    /// Conservation over all 80; claim gas for the last position (the worst case: walks all 80 slots).
    function test_EightyDepositors_ConservationAndLastPositionGas() public {
        address[] memory ds = new address[](80);
        for (uint256 i; i < 80; ++i) {
            ds[i] = address(uint160(0xD000 + i));
            credits.mint(ds[i], 1); // ids 241..320
        }
        uint256 first = 241;
        vm.startPrank(ds[0]);
        credits.setApprovalForAll(address(factory), true);
        Batch b = Batch(factory.create("S", noFilter, new uint256[](0), 0, Batch.Arrangement.Deposit, Batch.Split.Early, 14 days, _one(first), FEE_BPS, 0));
        vm.stopPrank();
        for (uint256 i = 1; i < 80; ++i) {
            if (i % 2 == 0) {
                vm.startPrank(ds[i]);
                credits.setApprovalForAll(address(factory), true);
                factory.deposit(address(b), _one(first + i));
                vm.stopPrank();
            } else {
                vm.prank(ds[i]);
                credits.safeTransferFrom(ds[i], address(b), first + i);
            }
        }
        assertEq(b.count(), 80);
        uint256 total;
        for (uint256 i; i < 80; ++i) {
            assertEq(b.unitsOf(ds[i]), 237 - 2 * i, "position weight");
            assertEq(b.sharesOf(ds[i]), 1);
            total += b.unitsOf(ds[i]);
        }
        assertEq(total, 12_640);

        b.assemble();
        uint256 amount = 7.123456789012345678 ether;
        _bidAndSettle(b, amount);

        // gas: last position, one Credit → full 80-slot walk inside claim()
        uint256 g = gasleft();
        b.claim(ds[79]);
        uint256 used = g - gasleft();
        emit log_named_uint("claim gas, position 79, 1 Credit", used);
        assertLt(used, 500_000);
        // first position for comparison
        g = gasleft();
        b.claim(ds[0]);
        emit log_named_uint("claim gas, position 0, 1 Credit", g - gasleft());

        // conservation over the rest
        uint256 paid = ds[0].balance + ds[79].balance;
        for (uint256 i = 1; i < 79; ++i) {
            b.claim(ds[i]);
            paid += ds[i].balance;
        }
        assertEq(paid + fee.balance, amount, "every wei accounted for");
        assertEq(address(b).balance, 0);
        // dust bound for Early: < 12,640 wei above the nominal fee
        assertLt(fee.balance - amount * FEE_BPS / 10_000, 12_640);
    }

    /// Worst case for a whale: 40 Credits sitting in positions 40..79 (early-exit never fires before the end).
    function test_ClaimGas_FortyCreditsAtTheBack() public {
        Batch b = _open(factory, alice, _range(1, 40), Batch.Split.Early, Batch.Arrangement.Deposit);
        vm.prank(bob);
        factory.deposit(address(b), _range(81, 40));
        b.assemble();
        _bidAndSettle(b, 1 ether);
        uint256 g = gasleft();
        b.claim(bob);
        uint256 used = g - gasleft();
        emit log_named_uint("claim gas, 40 Credits at positions 40..79", used);
        assertLt(used, 500_000);
    }

    /// Random churn while Open (deposit / withdraw / re-deposit by three actors), then fill and sell:
    /// unitsOf must equal the slot-order model, sum to 12,640, and conserve every wei.
    function testFuzz_ChurnThenSellExact(uint256 seed, uint96 amount) public {
        amount = uint96(bound(amount, 0.01 ether, 10_000 ether));
        Batch b = _open(factory, alice, _range(1, 3), Batch.Split.Early, Batch.Arrangement.Deposit);
        address[3] memory who = [alice, bob, carol];
        uint256[3] memory base = [uint256(1), 81, 161];
        // 60 random moves: each actor toggles a random Credit of theirs in/out
        for (uint256 k; k < 60; ++k) {
            uint256 r = uint256(keccak256(abi.encode(seed, k)));
            uint256 a = r % 3;
            uint256 id = base[a] + (r >> 8) % 60;
            if (b.count() == 80) break;
            if (b.depositorOf(id) == who[a]) {
                vm.prank(who[a]);
                b.withdraw(_one(id));
            } else if (b.depositorOf(id) == address(0)) {
                vm.prank(who[a]);
                factory.deposit(address(b), _one(id));
            }
        }
        // fill with whatever is left, round robin
        uint256[3] memory next = [uint256(60), 60, 60]; // ids base+60.. are untouched so far
        uint256 a2;
        while (b.count() < 80) {
            uint256 id = base[a2] + next[a2]++;
            if (next[a2] > 80) revert("out of credits");
            vm.prank(who[a2]);
            factory.deposit(address(b), _one(id));
            a2 = (a2 + 1) % 3;
        }
        assertEq(b.count(), 80);
        uint256 sum;
        for (uint256 i; i < 3; ++i) {
            assertEq(b.unitsOf(who[i]), _modelUnits(b, who[i]), "unitsOf != slot model");
            (uint256[] memory ids_, address[] memory deps) = b.slots();
            uint256 c;
            for (uint256 j; j < ids_.length; ++j) if (deps[j] == who[i]) ++c;
            assertEq(b.sharesOf(who[i]), c, "sharesOf != slots held");
            sum += b.unitsOf(who[i]);
        }
        assertEq(sum, 12_640);

        b.assemble();
        _bidAndSettle(b, amount);
        address[] memory ds = new address[](3);
        (ds[0], ds[1], ds[2]) = (alice, bob, carol);
        _assertConserved(b, ds, amount);
    }

    /// Equal path is the old maths: payoutPerShare == net/80, dust ≤ 79 wei, unitsOf == sharesOf,
    /// Settled event carries the same number as payoutPerShare()/summary().
    function testFuzz_EqualUnchanged(uint96 amount) public {
        amount = uint96(bound(amount, 0.01 ether, 10_000 ether));
        Batch b = _open(factory, alice, _range(1, 40), Batch.Split.Equal, Batch.Arrangement.Deposit);
        vm.prank(bob);
        factory.deposit(address(b), _range(81, 40));
        b.assemble();
        uint256 net = uint256(amount) - uint256(amount) * FEE_BPS / 10_000;
        uint256 per = net / 80;
        uint256 dust = net - per * 80;
        vm.deal(address(0xB1D), amount);
        vm.prank(address(0xB1D));
        b.bid{value: amount}();
        skip(1 days);
        vm.expectEmit(true, false, false, true);
        emit Batch.Settled(address(0xB1D), amount, uint256(amount) * FEE_BPS / 10_000 + dust, 0, per);
        b.settle();
        assertEq(b.payoutPerShare(), per);
        assertEq(b.payoutPerUnit(), per);
        assertEq(b.summary().payoutPerShare, per);
        assertEq(b.unitsOf(alice), b.sharesOf(alice));
        assertEq(b.claimable(alice), 40 * per);
        assertLe(dust, 79);
        address[] memory ds = new address[](2);
        (ds[0], ds[1]) = (alice, bob);
        _assertConserved(b, ds, amount);
    }

    /// Early: the Settled event's payoutPerShare == payoutPerUnit × 158 == summary().payoutPerShare.
    function test_EarlySettledEventMatchesViews() public {
        Batch b = _open(factory, alice, _range(1, 40), Batch.Split.Early, Batch.Arrangement.Deposit);
        vm.prank(bob);
        factory.deposit(address(b), _range(81, 40));
        b.assemble();
        uint256 amount = 5 ether + 12_345;
        uint256 net = amount - amount * FEE_BPS / 10_000;
        uint256 per = net / 12_640;
        vm.deal(address(0xB1D), amount);
        vm.prank(address(0xB1D));
        b.bid{value: amount}();
        skip(1 days);
        vm.expectEmit(true, false, false, true);
        emit Batch.Settled(address(0xB1D), amount, amount - per * 12_640, 0, per * 158);
        b.settle();
        assertEq(b.summary().payoutPerShare, per * 158);
        assertEq(b.payoutPerShare(), per * 158);
    }

    /// A bid whose net is below one unit per position: everything is dust → protocol fee; nobody can claim;
    /// the batch still ends empty. (Early needs net ≥ 12,640 wei for any depositor payout; Equal ≥ 80 wei.)
    /// The 0.01 ETH floor after the reserve lapses means a sale can never be all dust: even the minimum bid
    /// pays every position something.
    function test_MinimumBidPaysEveryPosition() public {
        Batch b = _open(factory, alice, _range(1, 40), Batch.Split.Early, Batch.Arrangement.Deposit);
        vm.prank(bob);
        factory.deposit(address(b), _range(81, 40));
        b.assemble();
        assertEq(b.minBid(), 0.01 ether);
        vm.prank(carol);
        vm.expectRevert(abi.encodeWithSelector(Batch.BidTooLow.selector, 0.01 ether));
        b.bid{value: 12_639}();
        _bidAndSettle(b, 0.01 ether);
        assertGt(b.payoutPerUnit(), 0);
        assertGt(b.claimable(bob), 0); // even the back of the line
        b.claim(alice);
        b.claim(bob);
        assertEq(address(b).balance, 0);
    }

    // ---------------------------------------------------------------- 2. sharesOf / _ids coherence

    /// Hook deposit with a beneficiary: units and shares go to the beneficiary, none to the sender.
    function test_HookBeneficiaryGetsThePosition() public {
        Batch b = _open(factory, alice, _range(1, 2), Batch.Split.Early, Batch.Arrangement.Deposit);
        vm.prank(bob);
        credits.safeTransferFrom(bob, address(b), 81, abi.encode(carol));
        vm.prank(bob);
        credits.safeTransferFrom(bob, address(b), 82); // no data: bob himself
        assertEq(b.sharesOf(bob), 1);
        assertEq(b.sharesOf(carol), 1);
        assertEq(b.unitsOf(carol), 237 - 4);
        assertEq(b.unitsOf(bob), 237 - 6);
        assertEq(b.depositorOf(81), carol);
        // bob cannot withdraw carol's slot; carol can
        vm.prank(bob);
        vm.expectRevert(abi.encodeWithSelector(Batch.NotDepositor.selector, 81));
        b.withdraw(_one(81));
        vm.prank(carol);
        b.withdraw(_one(81));
        assertEq(b.sharesOf(carol), 0);
        assertEq(b.unitsOf(carol), 0);
        assertEq(b.unitsOf(bob), 237 - 4); // bob moved up
        assertEq(credits.ownerOf(81), carol);
    }

    /// Exit window on a Full batch: a middle depositor leaves and comes back last; the batch refills and
    /// sells; _ids is exactly 80 at settle and every wei is conserved.
    function test_ExitWindowWithdrawRedepositThenSell() public {
        Batch b = _open(staged, alice, _range(1, 10), Batch.Split.Early, Batch.Arrangement.Deposit);
        vm.prank(bob);
        staged.deposit(address(b), _range(81, 30));
        vm.prank(carol);
        staged.deposit(address(b), _range(161, 40));
        assertEq(uint256(b.state()), uint256(Batch.State.Full));
        vm.prank(setter);
        staged.proposeAssembler(asm);
        assertTrue(b.summary().exitWindow);

        // bob pulls 5 of his (positions 10..14): carol moves up 5; bob re-deposits them at the back
        vm.prank(bob);
        b.withdraw(_range(81, 5));
        assertEq(uint256(b.state()), uint256(Batch.State.Open));
        assertEq(b.unitsOf(carol), _modelUnits(b, carol));
        vm.prank(bob);
        staged.deposit(address(b), _range(81, 5));
        assertEq(b.count(), 80);
        assertEq(b.unitsOf(alice), 2280);
        // bob: positions 10..34 and 75..79
        uint256 exp;
        for (uint256 i = 10; i < 35; ++i) exp += 237 - 2 * i;
        for (uint256 i = 75; i < 80; ++i) exp += 237 - 2 * i;
        assertEq(b.unitsOf(bob), exp);
        assertEq(b.unitsOf(carol), _modelUnits(b, carol));
        assertEq(b.unitsOf(alice) + b.unitsOf(bob) + b.unitsOf(carol), 12_640);

        skip(3 days);
        staged.activateAssembler();
        b.assemble();
        uint256 amount = 2.5 ether;
        _bidAndSettle(b, amount);
        assertEq(b.count(), 80);
        address[] memory ds = new address[](3);
        (ds[0], ds[1], ds[2]) = (alice, bob, carol);
        _assertConserved(b, ds, amount);
    }

    /// Once the Statement exists, _ids is frozen: no withdraw (Auction, Settled) and no deposit.
    function test_IdsFrozenAfterAssembly() public {
        Batch b = _open(factory, alice, _range(1, 40), Batch.Split.Early, Batch.Arrangement.Deposit);
        vm.prank(bob);
        factory.deposit(address(b), _range(81, 40));
        b.assemble();
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(Batch.WrongState.selector, Batch.State.Auction));
        b.withdraw(_one(1));
        // the exit window does not reopen an auctioning batch either
        vm.prank(carol);
        vm.expectRevert(abi.encodeWithSelector(Batch.WrongState.selector, Batch.State.Auction));
        factory.deposit(address(b), _one(161));
        _bidAndSettle(b, 1 ether);
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(Batch.WrongState.selector, Batch.State.Settled));
        b.withdraw(_one(1));
        assertEq(b.count(), 80);
        // Credits are burned; rescue cannot touch a recorded id even though ownerOf reverts
        vm.expectRevert(Batch.NotStray.selector);
        b.rescue(address(credits), 1);
    }

    /// Expired Full batch (never assembled): withdrawals shift positions but nothing can be added back,
    /// and settle is unreachable, so unitsOf can never be summed against a payout.
    function test_ExpiredCannotRefill() public {
        Batch b = _open(staged, alice, _range(1, 40), Batch.Split.Early, Batch.Arrangement.Deposit);
        vm.prank(bob);
        staged.deposit(address(b), _range(81, 40));
        skip(15 days); // deadline 14d; no assembler activation → no FILL_GRACE extension
        assertEq(uint256(b.state()), uint256(Batch.State.Expired));
        vm.prank(alice);
        b.withdraw(_range(1, 40));
        assertEq(b.unitsOf(bob), _modelUnits(b, bob));
        assertEq(b.unitsOf(bob), 7920); // positions 0..39 now
        vm.prank(carol);
        vm.expectRevert(abi.encodeWithSelector(Batch.WrongState.selector, Batch.State.Expired));
        staged.deposit(address(b), _one(161));
    }

    /// Duplicate ids in one deposit or withdraw call cannot double-count.
    function test_DuplicatesRejected() public {
        Batch b = _open(factory, alice, _range(1, 2), Batch.Split.Early, Batch.Arrangement.Deposit);
        uint256[] memory dup = new uint256[](2);
        dup[0] = 81;
        dup[1] = 81;
        vm.prank(bob);
        vm.expectRevert(); // second transferFrom: batch already owns it
        factory.deposit(address(b), dup);
        assertEq(b.sharesOf(bob), 0);
        assertEq(b.count(), 2);
        dup[0] = 1;
        dup[1] = 1;
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(Batch.NotDepositor.selector, 1));
        b.withdraw(dup);
        assertEq(b.sharesOf(alice), 2);
    }

    /// A depositor cannot claim twice, and a contract depositor re-entering claim() from receive() gets nothing.
    function test_ReentrantClaimBlocked() public {
        ReentrantClaimer rc = new ReentrantClaimer();
        Batch b = _open(factory, alice, _range(1, 40), Batch.Split.Early, Batch.Arrangement.Deposit);
        vm.prank(bob);
        factory.depositFor(address(b), _range(81, 40), address(rc));
        rc.arm(b, alice);
        b.assemble();
        _bidAndSettle(b, 3 ether);
        uint256 due = b.claimable(address(rc));
        b.claim(address(rc));
        assertEq(rc.hits(), 1);
        assertEq(address(rc).balance, due);
        assertEq(b.claimable(address(rc)), 0);
        assertGt(b.claimable(alice), 0, "alice's claim untouched by the re-entrant attempt");
        vm.expectRevert(Batch.NothingToClaim.selector);
        b.claim(address(rc));
        b.claim(alice);
        assertEq(address(b).balance, 0);
    }

    // ---------------------------------------------------------------- 3. position gaming

    /// Creator arrangement: assembleOrdered changes the Statement order only. Payout positions stay in
    /// deposit order, so the creator cannot promote their own Credits.
    function test_AssembleOrderedDoesNotMovePayoutPositions() public {
        // bob seeds 1 as creator (position 0), alice adds 39, carol 40: creator's remaining Credits come last
        Batch b = _open(factory, bob, _range(81, 1), Batch.Split.Early, Batch.Arrangement.Creator);
        vm.prank(alice);
        factory.deposit(address(b), _range(1, 39));
        vm.prank(carol);
        factory.deposit(address(b), _range(161, 20));
        vm.prank(bob);
        factory.deposit(address(b), _range(82, 20)); // positions 60..79
        uint256 bobBefore = b.unitsOf(bob);
        uint256 aliceBefore = b.unitsOf(alice);
        uint256 carolBefore = b.unitsOf(carol);
        // creator burns with his own Credits first
        uint256[] memory order = new uint256[](80);
        uint256 k;
        for (uint256 i; i < 21; ++i) order[k++] = 81 + i;
        for (uint256 i; i < 39; ++i) order[k++] = 1 + i;
        for (uint256 i; i < 20; ++i) order[k++] = 161 + i;
        vm.prank(bob);
        b.assembleOrdered(order);
        assertEq(b.unitsOf(bob), bobBefore);
        assertEq(b.unitsOf(alice), aliceBefore);
        assertEq(b.unitsOf(carol), carolBefore);
        (uint256[] memory ids_,) = b.slots();
        assertEq(ids_[0], 81);
        assertEq(ids_[1], 1); // deposit order intact
        _bidAndSettle(b, 4 ether);
        assertEq(b.claimable(bob), bobBefore * b.payoutPerUnit());
        address[] memory ds = new address[](3);
        (ds[0], ds[1], ds[2]) = (alice, bob, carol);
        _assertConserved(b, ds, 4 ether);
    }

    /// Within one multi-id call, positions follow the array order; a later call can never precede an
    /// earlier one; withdraw + re-deposit in one tx still lands at the back.
    function test_OrderIsStrictlyArrival() public {
        Batch b = _open(factory, alice, _range(1, 1), Batch.Split.Early, Batch.Arrangement.Deposit);
        uint256[] memory rev = new uint256[](3);
        (rev[0], rev[1], rev[2]) = (83, 82, 81);
        vm.prank(bob);
        factory.deposit(address(b), rev);
        (uint256[] memory ids_,) = b.slots();
        assertEq(ids_[1], 83);
        assertEq(ids_[3], 81);
        // alice (position 0) leaves and re-enters in the same tx: she is now last
        vm.startPrank(alice);
        b.withdraw(_one(1));
        factory.deposit(address(b), _one(1));
        vm.stopPrank();
        (ids_,) = b.slots();
        assertEq(ids_[0], 83);
        assertEq(ids_[3], 1);
        assertEq(b.unitsOf(alice), 237 - 6);
        assertEq(b.unitsOf(bob), 237 + 235 + 233);
    }

    /// depositFor: the buyer, not the caller, takes the positions; the caller ends with nothing here.
    function test_DepositForCallerGetsNoPosition() public {
        Batch b = _open(factory, alice, _range(1, 1), Batch.Split.Early, Batch.Arrangement.Deposit);
        vm.prank(bob);
        factory.depositFor(address(b), _range(81, 2), carol);
        assertEq(b.sharesOf(bob), 0);
        assertEq(b.unitsOf(bob), 0);
        assertEq(b.unitsOf(carol), 235 + 233);
        assertEq(b.unitsOf(alice), 237);
    }
}
