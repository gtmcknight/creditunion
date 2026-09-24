// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {Batch} from "../src/Batch.sol";
import {BatchFactory} from "../src/BatchFactory.sol";
import {MockAssembler} from "../src/MockAssembler.sol";
import {IAssembler} from "../src/interfaces/IAssembler.sol";
import {ICredits} from "../src/interfaces/ICredits.sol";
import {MockCredits} from "../src/mocks/MockCredits.sol";
import {MockStatement} from "../src/mocks/MockStatement.sol";

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

    function assemble(uint256[] calldata ids) external returns (uint256) {
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
        factory = new BatchFactory(ICredits(address(credits)), new MockAssembler(statement), fee, 100, 10);
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
        vm.prank(who);
        return Batch(factory.create("Test", noFilter, reserve, 0, 14 days, ids));
    }

    function _full(uint256 reserve) internal returns (Batch b) {
        b = _open(alice, _range(1, 40), reserve);
        vm.prank(bob);
        factory.deposit(address(b), _range(51, 40));
    }

    // ---------------------------------------------------------------- open / deposit

    function test_OpenRequiresMinimum() public {
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(BatchFactory.TooFewToOpen.selector, 10));
        factory.create("x", noFilter, 0, 0, 14 days, _range(1, 9));
    }

    function test_OpenRejectsBadDuration() public {
        vm.startPrank(alice);
        vm.expectRevert(BatchFactory.BadDuration.selector);
        factory.create("x", noFilter, 0, 0, 1 days, _range(1, 10));
        vm.expectRevert(BatchFactory.BadDuration.selector);
        factory.create("x", noFilter, 0, 0, 91 days, _range(1, 10));
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
        b.initialize(bob, "x", noFilter, 0, 0, 1);
        Batch impl = Batch(factory.implementation());
        vm.expectRevert(Batch.AlreadyInitialized.selector);
        impl.initialize(bob, "x", noFilter, 0, 0, 1);
    }

    function test_Filter() public {
        Batch.Filter memory f;
        f.colors = keccak256("CMY"); // even ids only in the mock
        uint256[] memory evens = new uint256[](10);
        for (uint256 i; i < 10; ++i) evens[i] = 2 + 2 * i;
        vm.prank(alice);
        Batch b = Batch(factory.create("Evens", f, 0, 0, 14 days, evens));
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
        vm.expectRevert(abi.encodeWithSelector(Batch.WrongState.selector, Batch.State.Full));
        b.withdraw(_range(1, 1));
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

    function test_FillExtendsDeadline() public {
        vm.prank(alice);
        Batch b = Batch(factory.create("x", noFilter, 0, 0, 3 days, _range(1, 40)));
        skip(2 days);
        vm.prank(bob);
        factory.deposit(address(b), _range(51, 40));
        assertEq(b.deadline(), block.timestamp + 7 days);
    }

    function test_ExpiredLetsEveryoneWithdraw() public {
        Batch b = _full(0);
        vm.warp(b.deadline());
        assertEq(uint256(b.state()), uint256(Batch.State.Expired));
        vm.prank(bob);
        b.withdraw(_range(51, 40));
        assertEq(credits.balanceOf(bob), 50);
        vm.expectRevert();
        b.assemble();
    }

    // ---------------------------------------------------------------- assemble

    function test_AssembleBurnsInDepositOrder() public {
        Batch b = _full(0);
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
        vm.expectRevert(abi.encodeWithSelector(Batch.WrongState.selector, Batch.State.Open));
        b.assemble();
    }

    function test_AssembleRejectsAssemblerThatDoesNotBurn() public {
        BatchFactory bad =
            new BatchFactory(ICredits(address(credits)), new StealingAssembler(carol, statement), fee, 100, 10);
        vm.prank(alice);
        credits.setApprovalForAll(address(bad), true);
        vm.prank(bob);
        credits.setApprovalForAll(address(bad), true);
        vm.prank(alice);
        Batch b = Batch(bad.create("x", noFilter, 0, 0, 14 days, _range(1, 40)));
        vm.prank(bob);
        bad.deposit(address(b), _range(51, 40));
        vm.expectRevert(Batch.CreditsNotBurned.selector);
        b.assemble();
        assertEq(credits.ownerOf(1), address(b)); // rolled back
    }

    // ---------------------------------------------------------------- auction

    function test_ReserveThenLapses() public {
        Batch b = _full(2 ether);
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
        b.assemble();
        skip(365 days);
        vm.expectRevert(Batch.AuctionRunning.selector);
        b.settle();
    }

    // ---------------------------------------------------------------- fees

    function test_CreatorFeeCappedAt10Percent() public {
        vm.prank(alice);
        vm.expectRevert(Batch.CreatorFeeTooHigh.selector);
        factory.create("x", noFilter, 0, 1001, 14 days, _range(1, 10));
    }

    function test_ProtocolFeeCappedAt5Percent() public {
        MockAssembler asm = new MockAssembler(statement);
        vm.expectRevert(BatchFactory.ProtocolFeeTooHigh.selector);
        new BatchFactory(ICredits(address(credits)), asm, fee, 501, 10);
    }

    function test_CreatorAndProtocolSplit() public {
        vm.prank(alice);
        Batch b = Batch(factory.create("Fee", noFilter, 0, 200, 14 days, _range(1, 40))); // 2% creator
        vm.prank(bob);
        factory.deposit(address(b), _range(51, 40));
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
        amount = uint96(bound(amount, 1, 1_000_000 ether));
        uint256 a = bound(aliceShare, 30, 50); // bob holds 50
        creatorFee = uint16(bound(creatorFee, 0, 1000));
        vm.prank(alice);
        Batch b = Batch(factory.create("F", noFilter, 0, creatorFee, 14 days, _range(1, a)));
        vm.prank(bob);
        factory.deposit(address(b), _range(51, 80 - a));
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
        factory.create("Gas", noFilter, 0, 0, 14 days, _range(1, 40));
        emit log_named_uint("create with 40", g - gasleft());
    }
}
