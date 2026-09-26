// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {Batch, IRatings} from "../src/Batch.sol";
import {BatchFactory} from "../src/BatchFactory.sol";
import {MockAssembler} from "../src/mocks/MockAssembler.sol";
import {IAssembler} from "../src/interfaces/IAssembler.sol";
import {ICredits} from "../src/interfaces/ICredits.sol";
import {MockCredits} from "../src/mocks/MockCredits.sol";
import {MockStatement} from "../src/mocks/MockStatement.sol";
import {ready} from "./utils/Ready.sol";

/// @dev Assembler that pretends: as operator it moves the Credits away instead of burning them.
contract StealingAssembler is IAssembler {
    address immutable sink;
    MockStatement immutable st;
    ICredits immutable credits;

    constructor(address sink_, MockStatement st_) {
        sink = sink_;
        st = st_;
        credits = st_.credits();
    }

    function statement() external view returns (address) {
        return address(st);
    }

    function assemble(uint256[] calldata ids, uint8) external returns (uint256) {
        for (uint256 i; i < ids.length; ++i) credits.transferFrom(msg.sender, sink, ids[i]);
        return 1;
    }
}

contract RevertingReceiver {
    Batch b;

    constructor(Batch b_) {
        b = b_;
    }

    function bid() external payable {
        b.bid{value: msg.value}();
    }

    receive() external payable {
        revert("no");
    }
}

contract BatchTest is Test {
    MockCredits credits;
    MockStatement statement;
    BatchFactory factory;
    address fee = makeAddr("fee");
    address alice = makeAddr("alice");
    address bob = makeAddr("bob");
    address carol = makeAddr("carol");
    Batch.Filter noFilter;

    function setUp() public {
        credits = new MockCredits();
        statement = new MockStatement(ICredits(address(credits)));
        factory = new BatchFactory(ICredits(address(credits)), IRatings(address(0)), new MockAssembler(statement), address(0), fee, 100, 0, 10);
        credits.mint(alice, 50); // ids 1..50
        credits.mint(bob, 50); // ids 51..100
        for (uint256 i; i < 3; ++i) {
            address u = [alice, bob, carol][i];
            vm.prank(u);
            credits.setApprovalForAll(address(factory), true);
            vm.deal(u, 100 ether);
        }
    }

    function _range(uint256 from, uint256 n) internal pure returns (uint256[] memory a) {
        a = new uint256[](n);
        for (uint256 i; i < n; ++i) a[i] = from + i;
    }

    function _open(address who, uint256[] memory ids, uint256 reserve) internal returns (Batch) {
        return _openAt(who, ids, reserve, factory.protocolFeeBps(), factory.creatorFeeBps());
    }

    function _openAt(address who, uint256[] memory ids, uint256 reserve, uint256 pf, uint256 cf) internal returns (Batch) {
        vm.prank(who);
        return Batch(factory.create("Test", noFilter, new uint256[](0), reserve, Batch.Arrangement.Deposit, Batch.Split.Equal, 14 days, ids, pf, cf));
    }

    function _full(uint256 reserve) internal returns (Batch b) {
        b = _open(alice, _range(1, 40), reserve);
        vm.prank(bob);
        factory.deposit(address(b), _range(51, 40));
        skip(b.LOCK_DELAY()); // countdown over: locked and burnable
    }

    // ---------------------------------------------------------------- open / deposit

    function test_OpenRequiresMinimum() public {
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(BatchFactory.TooFewToOpen.selector, 10));
        factory.create("x", noFilter, new uint256[](0), 0, Batch.Arrangement.Deposit, Batch.Split.Equal, 14 days, _range(1, 9), 100, 0);
    }

    function test_OpenRejectsBadDuration() public {
        vm.startPrank(alice);
        vm.expectRevert(BatchFactory.BadDuration.selector);
        factory.create("x", noFilter, new uint256[](0), 0, Batch.Arrangement.Deposit, Batch.Split.Equal, 1 days, _range(1, 10), 100, 0);
        vm.expectRevert(BatchFactory.BadDuration.selector);
        factory.create("x", noFilter, new uint256[](0), 0, Batch.Arrangement.Deposit, Batch.Split.Equal, 91 days, _range(1, 10), 100, 0);
    }

    function test_CannotDepositSomeoneElsesCredits() public {
        Batch b = _open(alice, _range(1, 10), 0);
        vm.prank(bob);
        vm.expectRevert();
        factory.deposit(address(b), _range(11, 1)); // alice's
    }

    function test_DepositOrderAndShares() public {
        Batch b = _open(alice, _range(1, 10), 0);
        vm.prank(bob);
        factory.deposit(address(b), _range(51, 5));
        (uint256[] memory ids, address[] memory deps) = b.slots();
        assertEq(ids.length, 15);
        assertEq(ids[10], 51);
        assertEq(deps[10], bob);
        assertEq(b.sharesOf(alice), 10);
        assertEq(b.sharesOf(bob), 5);
        assertEq(uint256(b.state()), uint256(Batch.State.Open));
    }

    function test_DirectSafeTransferDeposits() public {
        Batch b = _open(alice, _range(1, 10), 0);
        vm.prank(bob);
        credits.safeTransferFrom(bob, address(b), 60);
        assertEq(b.depositorOf(60), bob);
        assertEq(b.count(), 11);
    }

    function test_RejectsOtherNFTs() public {
        Batch b = _open(alice, _range(1, 10), 0);
        MockCredits other = new MockCredits();
        other.mint(bob, 1);
        vm.prank(bob);
        vm.expectRevert(Batch.WrongToken.selector);
        other.safeTransferFrom(bob, address(b), 1);
    }

    function test_DepositToUnknownBatchReverts() public {
        vm.prank(alice);
        vm.expectRevert(BatchFactory.NotBatch.selector);
        factory.deposit(address(0xdead), _range(1, 1));
    }

    function test_OnlyFactoryRecords() public {
        Batch b = _open(alice, _range(1, 10), 0);
        vm.expectRevert(Batch.NotFactory.selector);
        b.depositFrom(alice, _range(1, 1));
    }

    function test_ImplementationAndClonesCannotBeReinitialized() public {
        Batch b = _open(alice, _range(1, 10), 0);
        vm.expectRevert(Batch.AlreadyInitialized.selector);
        b.initialize(bob, "x", noFilter, new uint256[](0), 0, 0, 0, Batch.Arrangement.Deposit, Batch.Split.Equal, 1);
        Batch impl = Batch(factory.implementation());
        vm.expectRevert(Batch.AlreadyInitialized.selector);
        impl.initialize(bob, "x", noFilter, new uint256[](0), 0, 0, 0, Batch.Arrangement.Deposit, Batch.Split.Equal, 1);
    }

    function test_Filter() public {
        Batch.Filter memory f;
        f.palettes = 1 << 7; // CMY only; even ids in the mock
        uint256[] memory evens = new uint256[](10);
        for (uint256 i; i < 10; ++i) evens[i] = 2 + 2 * i;
        vm.prank(alice);
        Batch b = Batch(factory.create("Evens", f, new uint256[](0), 0, Batch.Arrangement.Deposit, Batch.Split.Equal, 14 days, evens, 100, 0));
        assertEq(b.count(), 10);
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(Batch.Excluded.selector, 1));
        factory.deposit(address(b), _range(1, 1));
    }

    // ---------------------------------------------------------------- withdraw / lock

    function test_WithdrawWhileOpenKeepsOrder() public {
        Batch b = _open(alice, _range(1, 10), 0);
        uint256[] memory w = new uint256[](1);
        w[0] = 3;
        vm.prank(alice);
        b.withdraw(w);
        assertEq(credits.ownerOf(3), alice);
        assertEq(b.sharesOf(alice), 9);
        uint256[] memory ids = b.ids();
        assertEq(ids.length, 9);
        assertEq(ids[1], 2);
        assertEq(ids[2], 4);
    }

    function test_CannotWithdrawOthers() public {
        Batch b = _open(alice, _range(1, 10), 0);
        vm.prank(bob);
        vm.expectRevert(abi.encodeWithSelector(Batch.NotDepositor.selector, 1));
        b.withdraw(_range(1, 1));
    }

    function test_LocksAt80() public {
        Batch b = _full(0);
        assertEq(uint256(b.state()), uint256(Batch.State.Full));
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(Batch.WrongPhase.selector, Batch.Phase.Burnable));
        b.withdraw(_range(1, 1)); // _full skips the countdown: in the burn window
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(Batch.WrongState.selector, Batch.State.Full));
        factory.deposit(address(b), _range(41, 1));
    }

    function test_CannotOverfill() public {
        Batch b = _open(alice, _range(1, 40), 0);
        vm.prank(bob);
        vm.expectRevert(abi.encodeWithSelector(Batch.WrongState.selector, Batch.State.Full));
        factory.deposit(address(b), _range(51, 41));
    }

    /// An open batch never expires, whatever duration it was created with.
    function test_OpenBatchNeverExpires() public {
        vm.prank(alice);
        Batch b = Batch(factory.create("x", noFilter, new uint256[](0), 0, Batch.Arrangement.Deposit, Batch.Split.Equal, 3 days, _range(1, 40), 100, 0));
        skip(365 days);
        assertEq(uint256(b.state()), uint256(Batch.State.Open));
        assertEq(b.lockAt(), 0);
        vm.prank(bob);
        factory.deposit(address(b), _range(51, 40));
        assertEq(uint256(b.state()), uint256(Batch.State.Full));
    }

    // The lock cycle (countdown, burn window, expiry) is covered in test/Lock.t.sol.

    // ---------------------------------------------------------------- assemble

    function test_AssembleBurnsInDepositOrder() public {
        Batch b = _full(0);
        ready(b);
        vm.prank(carol);
        b.assemble();
        assertEq(uint256(b.state()), uint256(Batch.State.Auction));
        assertEq(statement.ownerOf(1), address(b));
        assertEq(b.statement(), address(statement));
        vm.expectRevert();
        credits.ownerOf(1);
    }

    function test_AssembleOnlyWhenFull() public {
        Batch b = _open(alice, _range(1, 40), 0);
        ready(b);
        vm.expectRevert(abi.encodeWithSelector(Batch.WrongPhase.selector, Batch.Phase.Open));
        b.assemble();
    }

    function test_AssembleRejectsAssemblerThatDoesNotBurn() public {
        BatchFactory bad =
            new BatchFactory(ICredits(address(credits)), IRatings(address(0)), new StealingAssembler(carol, statement), address(0), fee, 100, 0, 10);
        vm.prank(alice);
        credits.setApprovalForAll(address(bad), true);
        vm.prank(bob);
        credits.setApprovalForAll(address(bad), true);
        vm.prank(alice);
        Batch b = Batch(bad.create("x", noFilter, new uint256[](0), 0, Batch.Arrangement.Deposit, Batch.Split.Equal, 14 days, _range(1, 40), 100, 0));
        vm.prank(bob);
        bad.deposit(address(b), _range(51, 40));
        ready(b);
        vm.expectRevert(Batch.CreditsNotBurned.selector);
        b.assemble();
        assertEq(credits.ownerOf(1), address(b)); // rolled back
    }

    // ---------------------------------------------------------------- auction

    function test_ReserveThenLapses() public {
        Batch b = _full(2 ether);
        ready(b);
        b.assemble();
        vm.prank(carol);
        vm.expectRevert(abi.encodeWithSelector(Batch.BidTooLow.selector, 2 ether));
        b.bid{value: 1 ether}();
        skip(7 days);
        vm.prank(carol);
        b.bid{value: 1 ether}();
        assertEq(b.highBid(), 1 ether);
    }

    function test_CannotBidBeforeAssembly() public {
        Batch b = _full(0);
        vm.prank(carol);
        vm.expectRevert(abi.encodeWithSelector(Batch.WrongState.selector, Batch.State.Full));
        b.bid{value: 1 ether}();
    }

    function test_FullAuctionAndSplit() public {
        Batch b = _full(0);
        ready(b);
        b.assemble();
        vm.prank(carol);
        b.bid{value: 3 ether}();
        assertEq(b.auctionEnd(), block.timestamp + 24 hours);

        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(Batch.BidTooLow.selector, 3.15 ether));
        b.bid{value: 3.1 ether}();

        uint256 carolBefore = carol.balance;
        vm.prank(alice);
        b.bid{value: 4 ether}();
        assertEq(carol.balance, carolBefore + 3 ether); // refunded at once

        vm.expectRevert(Batch.AuctionRunning.selector);
        b.settle();

        skip(24 hours);
        vm.prank(carol);
        vm.expectRevert(Batch.AuctionOver.selector);
        b.bid{value: 10 ether}();

        b.settle();
        assertEq(statement.ownerOf(1), alice);
        assertEq(fee.balance, 0.04 ether);
        assertEq(b.payoutPerShare(), 0.0495 ether);

        uint256 bobBefore = bob.balance;
        vm.prank(carol);
        b.claim(bob); // anyone can push
        assertEq(bob.balance, bobBefore + 40 * 0.0495 ether);
        vm.expectRevert(Batch.NothingToClaim.selector);
        b.claim(bob);
        b.claim(alice);
        assertEq(address(b).balance, 0);
    }

    function test_AntiSnipe() public {
        Batch b = _full(0);
        ready(b);
        b.assemble();
        vm.prank(carol);
        b.bid{value: 1 ether}();
        skip(24 hours - 1 minutes);
        vm.prank(alice);
        b.bid{value: 2 ether}();
        assertEq(b.auctionEnd(), block.timestamp + 15 minutes);
    }

    function test_RevertingBidderCannotBlock() public {
        Batch b = _full(0);
        ready(b);
        b.assemble();
        RevertingReceiver r = new RevertingReceiver(b);
        r.bid{value: 1 ether}();
        vm.prank(alice);
        b.bid{value: 2 ether}(); // refund to r fails, but the bid goes through
        assertEq(b.highBidder(), alice);
        assertEq(b.owed(address(r)), 1 ether);
    }

    function test_NoSettleWithoutBids() public {
        Batch b = _full(0);
        ready(b);
        b.assemble();
        skip(365 days);
        vm.expectRevert(Batch.AuctionRunning.selector);
        b.settle();
    }

    // ---------------------------------------------------------------- fees

    function test_CreatorFeeCappedAt10Percent() public {
        MockAssembler asm = new MockAssembler(statement);
        vm.expectRevert(BatchFactory.CreatorFeeTooHigh.selector);
        new BatchFactory(ICredits(address(credits)), IRatings(address(0)), asm, address(0), fee, 100, 1001, 10);
        vm.prank(fee);
        vm.expectRevert(BatchFactory.CreatorFeeTooHigh.selector);
        factory.setFees(100, 1001);
    }

    /// Fees can move within the caps, only by the fee recipient, and only for batches opened afterwards.
    function test_FeeChangesOnlyReachLaterBatches() public {
        Batch early = _open(alice, _range(1, 10), 0);
        vm.prank(alice);
        vm.expectRevert(BatchFactory.NotFeeRecipient.selector);
        factory.setFees(200, 100);
        vm.prank(fee);
        vm.expectRevert(BatchFactory.ProtocolFeeTooHigh.selector);
        factory.setFees(501, 0);
        vm.prank(fee);
        factory.setFees(200, 100);
        assertEq(factory.protocolFeeBps(), 200);
        assertEq(factory.creatorFeeBps(), 100);
        Batch late = _open(bob, _range(51, 10), 0);
        assertEq(early.protocolFeeBps(), 100);
        assertEq(early.creatorFeeBps(), 0);
        assertEq(late.protocolFeeBps(), 200);
        assertEq(late.creatorFeeBps(), 100);
        assertEq(early.summary().protocolFeeBps, 100);
        assertEq(late.summary().creatorFeeBps, 100);
        // the earlier batch settles on the split it opened with
        vm.prank(bob);
        factory.deposit(address(early), _range(61, 40)); // bob: 51..60 went to `after`, 61..100 here
        vm.prank(alice);
        factory.deposit(address(early), _range(11, 30));
        ready(early);
        early.assemble();
        vm.prank(carol);
        early.bid{value: 1 ether}();
        skip(1 days);
        uint256 aliceBefore = alice.balance;
        early.settle();
        assertEq(fee.balance, 0.01 ether); // 1%, not 2%
        assertEq(early.payoutPerShare(), 0.99 ether / 80);
        early.claim(alice);
        assertEq(alice.balance - aliceBefore, 40 * (0.99 ether / 80)); // 40 shares, no creator fee
    }

    function test_ProtocolFeeCappedAt5Percent() public {
        MockAssembler asm = new MockAssembler(statement);
        vm.expectRevert(BatchFactory.ProtocolFeeTooHigh.selector);
        new BatchFactory(ICredits(address(credits)), IRatings(address(0)), asm, address(0), fee, 501, 0, 10);
    }

    function test_CreatorAndProtocolSplit() public {
        vm.prank(fee);
        factory.setFees(100, 200); // 2% creator
        vm.prank(alice);
        Batch b = Batch(factory.create("Fee", noFilter, new uint256[](0), 0, Batch.Arrangement.Deposit, Batch.Split.Equal, 14 days, _range(1, 40), 100, 200));
        vm.prank(bob);
        factory.deposit(address(b), _range(51, 40));
        ready(b);
        b.assemble();
        vm.prank(carol);
        b.bid{value: 3 ether}();
        skip(1 days);
        uint256 aliceBefore = alice.balance;
        b.settle();
        assertEq(fee.balance, 0.03 ether); // 1% protocol
        assertEq(alice.balance - aliceBefore, 0.06 ether); // 2% creator, paid to the opener
        assertEq(b.payoutPerShare(), 0.036375 ether); // (3 − 0.09) / 80
        b.claim(alice);
        b.claim(bob);
        assertEq(address(b).balance, 0);
    }

    // ---------------------------------------------------------------- fuzz

    /// @dev Any split of any winning bid pays out exactly: 80 shares + fee == bid.
    function testFuzz_SplitIsExact(uint96 amount, uint8 aliceShare, uint16 creatorFee) public {
        amount = uint96(bound(amount, 0.01 ether, 1_000_000 ether));
        uint256 a = bound(aliceShare, 30, 50); // bob holds 50
        creatorFee = uint16(bound(creatorFee, 0, 1000));
        vm.prank(fee);
        factory.setFees(100, creatorFee);
        vm.prank(alice);
        Batch b = Batch(factory.create("F", noFilter, new uint256[](0), 0, Batch.Arrangement.Deposit, Batch.Split.Equal, 14 days, _range(1, a), 100, creatorFee));
        vm.prank(bob);
        factory.deposit(address(b), _range(51, 80 - a));
        ready(b);
        b.assemble();
        vm.deal(carol, amount);
        vm.prank(carol);
        b.bid{value: amount}();
        skip(1 days);
        b.settle();
        if (b.claimable(alice) > 0) b.claim(alice);
        if (b.claimable(bob) > 0) b.claim(bob);
        assertEq(address(b).balance, 0);
        // alice is both a depositor and the creator: everything paid out sums to the winning bid
        assertEq(fee.balance + (alice.balance - 100 ether) + (bob.balance - 100 ether), amount);
        assertLe(fee.balance, uint256(amount) / 100 + 80);
    }

    /// @dev Deposits and withdrawals in any sequence keep ids, shares and custody consistent.
    function testFuzz_DepositWithdrawConsistent(uint256 seed) public {
        Batch b = _open(alice, _range(1, 10), 0);
        for (uint256 step; step < 30; ++step) {
            seed = uint256(keccak256(abi.encode(seed)));
            address who = seed % 2 == 0 ? alice : bob;
            uint256 id = (who == alice ? 1 : 51) + (seed >> 8) % 50;
            uint256[] memory one = new uint256[](1);
            one[0] = id;
            if (b.depositorOf(id) == who) {
                vm.prank(who);
                b.withdraw(one);
            } else if (b.count() < 80) {
                vm.prank(who);
                factory.deposit(address(b), one);
            }
        }
        (uint256[] memory ids, address[] memory deps) = b.slots();
        uint256 sa;
        for (uint256 i; i < ids.length; ++i) {
            assertEq(credits.ownerOf(ids[i]), address(b));
            if (deps[i] == alice) ++sa;
        }
        assertEq(sa, b.sharesOf(alice));
        assertEq(ids.length - sa, b.sharesOf(bob));
        assertEq(credits.balanceOf(address(b)), ids.length);
    }

    function test_GasFor40Deposit() public {
        vm.prank(alice);
        uint256 g = gasleft();
        factory.create("Gas", noFilter, new uint256[](0), 0, Batch.Arrangement.Deposit, Batch.Split.Equal, 14 days, _range(1, 40), 100, 0);
        emit log_named_uint("create with 40", g - gasleft());
    }
}
