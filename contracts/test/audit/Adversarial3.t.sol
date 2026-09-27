// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {ratingsOf} from "../../script/RatingsOf.sol";
import {IERC721Receiver} from "@openzeppelin/contracts/token/ERC721/IERC721Receiver.sol";
import {Batch, IRatings} from "../../src/Batch.sol";
import {BatchFactory} from "../../src/BatchFactory.sol";
import {MockAssembler} from "../../src/mocks/MockAssembler.sol";
import {IAssembler} from "../../src/interfaces/IAssembler.sol";
import {ICredits} from "../../src/interfaces/ICredits.sol";
import {MockCredits} from "../../src/mocks/MockCredits.sol";
import {MockStatement} from "../../src/mocks/MockStatement.sol";
import {ready} from "../utils/Ready.sol";

/// @dev Credits that can safeMint straight into a batch (from == 0 in the hook). Real Credits are sealed and
///      used plain _mint; this models any future/test edition that does not.
contract SafeMintCredits is MockCredits {
    function safeMintTo(address to) external returns (uint256 id) {
        id = ++supply;
        seedOf[id] = bytes21(keccak256(abi.encode(id)));
        timestampOf[id] = uint64(id);
        _safeMint(to, id);
    }
}

/// @dev Honest adapter that first tries every state-changing entry point of the calling batch (and the
///      factory) from inside assemble(). Every attempt must revert; it counts the ones that did not.
contract ReentrantAssembler is IAssembler, IERC721Receiver {
    MockStatement immutable st;
    ICredits immutable credits;
    BatchFactory immutable factory;
    uint256 public leaked;

    constructor(MockStatement st_, BatchFactory f) {
        st = st_;
        credits = st_.credits();
        factory = f;
        credits.setApprovalForAll(address(st_), true);
        credits.setApprovalForAll(address(f), true);
    }

    receive() external payable {}

    function statement() external view returns (address) {
        return address(st);
    }

    function assemble(uint256[] calldata ids, uint8) external returns (uint256 id) {
        Batch b = Batch(msg.sender);
        uint256[] memory one = new uint256[](1);
        one[0] = ids[0];
        try b.bid{value: 1 ether}() { ++leaked; } catch {}
        try b.withdraw(one) { ++leaked; } catch {}
        try b.assemble() { ++leaked; } catch {}
        try b.depositFrom(address(this), one) { ++leaked; } catch {}
        try b.rescue(address(credits), ids[0]) { ++leaked; } catch {}
        try b.settle() { ++leaked; } catch {}
        // we are operator for the batch's Credits: move one to ourselves and try to re-deposit it via the factory
        credits.transferFrom(msg.sender, address(this), ids[0]);
        try factory.deposit(msg.sender, one) { ++leaked; } catch {}
        for (uint256 i = 1; i < ids.length; ++i) credits.transferFrom(msg.sender, address(this), ids[i]);
        id = st.make(ids);
        st.transferFrom(address(this), msg.sender, id);
    }

    function onERC721Received(address, address, uint256, bytes calldata) external pure returns (bytes4) {
        return this.onERC721Received.selector;
    }
}

/// @dev Burns correctly but hands the Statement to `thief`.
contract ThiefAssembler is IAssembler, IERC721Receiver {
    MockStatement immutable st;
    ICredits immutable credits;
    address immutable thief;

    constructor(MockStatement st_, address thief_) {
        st = st_;
        credits = st_.credits();
        thief = thief_;
        credits.setApprovalForAll(address(st_), true);
    }

    function statement() external view returns (address) {
        return address(st);
    }

    function assemble(uint256[] calldata ids, uint8) external returns (uint256 id) {
        for (uint256 i; i < ids.length; ++i) credits.transferFrom(msg.sender, address(this), ids[i]);
        id = st.make(ids);
        st.transferFrom(address(this), thief, id);
    }

    function onERC721Received(address, address, uint256, bytes calldata) external pure returns (bytes4) {
        return this.onERC721Received.selector;
    }
}

/// @dev Burns the batch's 80 and also mints a second Statement from its own 80, sending both to the batch.
contract DoubleAssembler is IAssembler, IERC721Receiver {
    MockStatement immutable st;
    ICredits immutable credits;

    constructor(MockStatement st_) {
        st = st_;
        credits = st_.credits();
        credits.setApprovalForAll(address(st_), true);
    }

    function statement() external view returns (address) {
        return address(st);
    }

    function assemble(uint256[] calldata ids, uint8) external returns (uint256 id) {
        for (uint256 i; i < ids.length; ++i) credits.transferFrom(msg.sender, address(this), ids[i]);
        id = st.make(ids);
        uint256[] memory mine = MockCredits(address(credits)).tokensOf(address(this));
        uint256 extra = st.make(mine);
        st.safeTransferFrom(address(this), msg.sender, extra); // hook path while _assembling
        st.transferFrom(address(this), msg.sender, id);
    }

    function onERC721Received(address, address, uint256, bytes calldata) external pure returns (bytes4) {
        return this.onERC721Received.selector;
    }
}

contract GasBurner {
    receive() external payable {
        while (true) {}
    }

    function bid(Batch b, uint256 v) external {
        b.bid{value: v}();
    }

    function pull(Batch b) external {
        b.withdrawOwed();
    }
}

contract Adversarial3Test is Test {
    MockCredits credits;
    MockStatement statement;
    BatchFactory factory;
    address fee = makeAddr("fee");
    address alice = makeAddr("alice");
    address bob = makeAddr("bob");
    address carol = makeAddr("carol");
    address setter = makeAddr("setter");
    Batch.Filter noFilter;

    function setUp() public {
        credits = new MockCredits();
        statement = new MockStatement(ICredits(address(credits)));
        factory = new BatchFactory(
            ICredits(address(credits)), IRatings(address(0)), new MockAssembler(statement), address(0), fee, 100, 0, 10
        );
        credits.mint(alice, 50); // 1..50
        credits.mint(bob, 50); // 51..100
        credits.mint(carol, 100); // 101..200
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

    function _one(uint256 id) internal pure returns (uint256[] memory a) {
        a = new uint256[](1);
        a[0] = id;
    }

    function _open(BatchFactory f, address who, Batch.Arrangement how, uint256[] memory ids) internal returns (Batch) {
        vm.prank(who);
        return Batch(f.create("A3", noFilter, new uint256[](0), 0, how, Batch.Split.Equal, 14 days, ids, 100, 0, ratingsOf(address(f))));
    }

    function _open(address who, uint256[] memory ids) internal returns (Batch) {
        return _open(factory, who, Batch.Arrangement.Deposit, ids);
    }

    /// alice 1..40, bob 51..90
    function _full(BatchFactory f, Batch.Arrangement how) internal returns (Batch b) {
        b = _open(f, alice, how, _range(1, 40));
        vm.prank(bob);
        f.deposit(address(b), _range(51, 40));
    }

    function _full() internal returns (Batch) {
        return _full(factory, Batch.Arrangement.Deposit);
    }

    function _approveAll(BatchFactory f) internal {
        for (uint256 i; i < 3; ++i) {
            vm.prank([alice, bob, carol][i]);
            credits.setApprovalForAll(address(f), true);
        }
    }

    // =============================================================== CONFIRMED

    /// Fixed: the hook applies the factory's sink rule, so a share can never be recorded for this batch, the
    /// factory or another batch (none of which could withdraw or take ETH).
    function test_HookRejectsSinkBeneficiaries() public {
        Batch b = _open(alice, _range(1, 39));
        Batch other = _open(carol, _range(101, 10));
        bytes memory err = abi.encodeWithSelector(Batch.NoDepositor.selector);
        vm.prank(alice);
        vm.expectRevert(err);
        credits.safeTransferFrom(alice, address(b), 40, abi.encode(address(b)));
        vm.prank(bob);
        vm.expectRevert(err);
        credits.safeTransferFrom(bob, address(b), 51, abi.encode(address(factory)));
        vm.prank(bob);
        vm.expectRevert(err);
        credits.safeTransferFrom(bob, address(b), 52, abi.encode(address(other)));
        assertEq(credits.ownerOf(40), alice);
        assertEq(b.count(), 39);
        // a real beneficiary still works
        vm.prank(bob);
        credits.safeTransferFrom(bob, address(b), 51, abi.encode(carol));
        assertEq(b.depositorOf(51), carol);
    }

    /// Fixed: a mint hook (from == 0, no beneficiary) is refused, so _ids can never list a Credit nobody
    /// deposited.
    function test_MintIntoBatchRefused() public {
        SafeMintCredits c = new SafeMintCredits();
        MockStatement s = new MockStatement(ICredits(address(c)));
        BatchFactory f = new BatchFactory(
            ICredits(address(c)), IRatings(address(0)), new MockAssembler(s), address(0), fee, 100, 0, 0
        );
        vm.prank(alice);
        Batch b = Batch(f.create("M", noFilter, new uint256[](0), 0, Batch.Arrangement.Deposit, Batch.Split.Equal, 14 days, new uint256[](0), 100, 0, ratingsOf(address(f))));
        vm.expectRevert(Batch.NoDepositor.selector);
        c.safeMintTo(address(b));
        assertEq(b.count(), 0);
    }

    function test_WithdrawDuplicatesAndForeignIdsRevert() public {
        Batch b = _open(alice, _range(1, 10));
        uint256[] memory dup = new uint256[](2);
        dup[0] = 1;
        dup[1] = 1;
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(Batch.NotDepositor.selector, 1));
        b.withdraw(dup);
        // never deposited, not held
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(Batch.NotDepositor.selector, 41));
        b.withdraw(_one(41));
        // stray (plain transferFrom) is not withdrawable by its sender
        vm.prank(bob);
        credits.transferFrom(bob, address(b), 60);
        vm.prank(bob);
        vm.expectRevert(abi.encodeWithSelector(Batch.NotDepositor.selector, 60));
        b.withdraw(_one(60));
        // empty withdraw reverts (R5-3: it used to reset filledAt from anyone during the exit window)
        vm.prank(bob);
        vm.expectRevert(Batch.NothingToClaim.selector);
        b.withdraw(new uint256[](0));
        assertEq(b.count(), 10);
        assertEq(b.sharesOf(alice), 10);
    }

    function test_OverfillAndEmptyDepositsRejectedOrNoop() public {
        Batch b = _open(alice, _range(1, 40));
        vm.prank(bob);
        vm.expectRevert(abi.encodeWithSelector(Batch.WrongState.selector, Batch.State.Full));
        factory.deposit(address(b), _range(51, 41)); // 81st reverts, whole call reverts
        assertEq(b.count(), 40);
        vm.prank(bob);
        factory.deposit(address(b), _range(51, 40));
        assertEq(uint256(b.state()), uint256(Batch.State.Full));
        // empty deposits on a full batch are no-ops (no state check runs)
        vm.prank(carol);
        factory.deposit(address(b), new uint256[](0));
        vm.prank(carol);
        factory.depositFor(address(b), new uint256[](0), bob);
        assertEq(b.count(), 80);
        // create with >80 or with duplicates reverts
        vm.prank(carol);
        vm.expectRevert();
        factory.create("x", noFilter, new uint256[](0), 0, Batch.Arrangement.Deposit, Batch.Split.Equal, 14 days, _range(101, 81), 100, 0, ratingsOf(address(factory)));
        uint256[] memory dup = new uint256[](2);
        dup[0] = 101;
        dup[1] = 101;
        vm.prank(carol);
        vm.expectRevert();
        factory.create("x", noFilter, new uint256[](0), 0, Batch.Arrangement.Deposit, Batch.Split.Equal, 14 days, dup, 100, 0, ratingsOf(address(factory)));
        // hook with data that is not 32 bytes credits `from`; 32 bytes of zero credits `from`
        Batch b3 = _open(alice, _range(41, 10));
        vm.prank(carol);
        credits.safeTransferFrom(carol, address(b3), 101, hex"1234");
        assertEq(b3.depositorOf(101), carol);
    }

    /// No active assembler: a full batch never locks, a leave reopens it and the refill restamps filledAt
    /// (still no countdown until activation).
    function test_NoAssemblerFullBatchWithdrawThenRefill() public {
        BatchFactory f = new BatchFactory(
            ICredits(address(credits)), IRatings(address(0)), IAssembler(address(0)), setter, fee, 100, 0, 10
        );
        _approveAll(f);
        Batch b = _full(f, Batch.Arrangement.Deposit);
        uint64 filled = b.filledAt();
        assertEq(b.lockAt(), 0);
        MockAssembler pending = new MockAssembler(statement);
        vm.prank(setter);
        f.proposeAssembler(pending);
        skip(1 days);
        vm.prank(bob);
        b.withdraw(_one(51));
        assertEq(uint256(b.state()), uint256(Batch.State.Open));
        assertEq(b.filledAt(), 0);
        assertEq(b.sharesOf(bob), 39);
        assertEq(credits.ownerOf(51), bob);
        vm.prank(carol);
        f.deposit(address(b), _one(101));
        assertEq(uint256(b.state()), uint256(Batch.State.Full));
        assertEq(b.filledAt(), block.timestamp);
        assertGt(b.filledAt(), filled);
        assertEq(b.lockAt(), 0, "still no countdown: the assembler is only proposed");
        assertEq(b.ids().length, 80);
        assertEq(b.ids()[79], 101);
    }

    function test_AssemblerCannotReenterOrRedepositPooledCredits() public {
        ReentrantAssembler asm = new ReentrantAssembler(statement, factory);
        vm.deal(address(asm), 10 ether);
        BatchFactory f = new BatchFactory(ICredits(address(credits)), IRatings(address(0)), asm, address(0), fee, 100, 0, 10);
        _approveAll(f);
        Batch b = _full(f, Batch.Arrangement.Deposit);
        ready(b);
        b.assemble();
        assertEq(asm.leaked(), 0, "some reentrant call succeeded");
        assertEq(uint256(b.state()), uint256(Batch.State.Auction));
        assertEq(b.count(), 80);
        assertEq(b.sharesOf(alice) + b.sharesOf(bob), 80);
        assertEq(address(b).balance, 0);
        assertFalse(credits.isApprovedForAll(address(b), address(asm)));
    }

    function test_AssemblerMintingElsewhereOrTwiceIsHandled() public {
        BatchFactory f = new BatchFactory(
            ICredits(address(credits)), IRatings(address(0)), new ThiefAssembler(statement, carol), address(0), fee, 100, 0, 10
        );
        _approveAll(f);
        Batch b = _full(f, Batch.Arrangement.Deposit);
        ready(b);
        vm.expectRevert(Batch.StatementNotReceived.selector);
        b.assemble();
        assertEq(credits.ownerOf(1), address(b));
    }

    function test_AssemblerMintingTwiceLeavesSecondAsStray() public {
        DoubleAssembler d = new DoubleAssembler(statement);
        for (uint256 i = 101; i < 181; ++i) {
            vm.prank(carol);
            credits.transferFrom(carol, address(d), i);
        }
        BatchFactory f2 = new BatchFactory(ICredits(address(credits)), IRatings(address(0)), d, address(0), fee, 100, 0, 10);
        _approveAll(f2);
        Batch b2 = _full(f2, Batch.Arrangement.Deposit);
        ready(b2);
        b2.assemble();
        assertEq(b2.statementId(), 1);
        assertEq(statement.ownerOf(1), address(b2));
        assertEq(statement.ownerOf(2), address(b2));
        vm.expectRevert(Batch.NotStray.selector);
        b2.rescue(address(statement), 1);
        b2.rescue(address(statement), 2); // the extra one is lost-and-found
        assertEq(statement.ownerOf(2), fee);
    }

    function test_AuctionBoundaries() public {
        Batch b = _full();
        vm.prank(carol);
        vm.expectRevert(abi.encodeWithSelector(Batch.WrongState.selector, Batch.State.Full));
        b.bid{value: 1 ether}();
        ready(b);
        b.assemble();
        vm.expectRevert(Batch.AuctionRunning.selector);
        b.settle(); // no bid yet
        vm.expectRevert(Batch.NothingToClaim.selector);
        b.claim(alice); // before settle
        vm.expectRevert(Batch.NotWinner.selector);
        b.claimStatement(alice);

        uint256 min = b.minBid();
        assertEq(min, 0.01 ether); // no reserve: the MIN_RAISE floor
        vm.prank(carol);
        vm.expectRevert(abi.encodeWithSelector(Batch.BidTooLow.selector, 0.01 ether));
        b.bid{value: 0.01 ether - 1}();
        vm.prank(carol);
        b.bid{value: 0.01 ether}();
        uint64 end = b.auctionEnd();
        assertEq(end, block.timestamp + 24 hours);
        assertEq(b.minBid(), 0.02 ether); // MIN_RAISE dominates
        vm.prank(carol);
        vm.expectRevert(abi.encodeWithSelector(Batch.BidTooLow.selector, 0.02 ether));
        b.bid{value: 0.02 ether - 1}();
        // self-outbid: refund goes back to self, net cost is the delta
        uint256 before = carol.balance;
        vm.prank(carol);
        b.bid{value: 0.02 ether}();
        assertEq(before - carol.balance, 0.01 ether);
        assertEq(b.highBidder(), carol);
        // 5% dominates for large bids
        vm.prank(bob);
        b.bid{value: 10 ether}();
        assertEq(b.minBid(), 10.5 ether);
        assertEq(b.auctionEnd(), end, "early bid must not move the end");
        // anti-snipe: bid at end - 1s extends to now + 15m; end only ever moves forward
        vm.warp(end - 1);
        vm.prank(alice);
        b.bid{value: 11 ether}();
        assertEq(b.auctionEnd(), end - 1 + 15 minutes);
        // bid at exactly auctionEnd is over; settle at exactly auctionEnd is allowed
        vm.warp(b.auctionEnd());
        vm.prank(bob);
        vm.expectRevert(Batch.AuctionOver.selector);
        b.bid{value: 12 ether}();
        b.settle();
        vm.expectRevert(abi.encodeWithSelector(Batch.WrongState.selector, Batch.State.Settled));
        b.settle();
        vm.expectRevert(abi.encodeWithSelector(Batch.WrongState.selector, Batch.State.Settled));
        b.bid{value: 12 ether}();
        assertEq(statement.ownerOf(1), alice);
        vm.expectRevert(Batch.NothingToClaim.selector);
        b.claim(carol); // 0 shares
        vm.prank(bob);
        vm.expectRevert(Batch.NotWinner.selector);
        b.claimStatement(bob);
        // ETH conservation
        b.claim(alice);
        b.claim(bob);
        assertEq(address(b).balance, 0);
        assertEq(fee.balance, 11 ether - b.payoutPerShare() * 80);
    }

    function test_GasBurningBidderRefundBecomesOwedAndBalanceIsExact() public {
        Batch b = _full();
        ready(b);
        b.assemble();
        GasBurner g = new GasBurner();
        vm.deal(address(g), 10 ether);
        g.bid(b, 1 ether);
        vm.prank(carol);
        b.bid{value: 2 ether}(); // refund to g fails at 50k gas -> owed
        assertEq(b.owed(address(g)), 1 ether);
        vm.expectRevert(Batch.PaymentFailed.selector);
        g.pull(b); // still cannot receive; the batch keeps it, nobody else can take it
        skip(1 days);
        b.settle();
        b.claim(alice);
        b.claim(bob);
        assertEq(address(b).balance, 1 ether, "exactly the owed refund remains");
        vm.expectRevert(Batch.NothingToClaim.selector);
        b.withdrawOwed();
    }

    function test_ReserveOnlyForSevenDays() public {
        vm.prank(alice);
        Batch b = Batch(factory.create("R", noFilter, new uint256[](0), 5 ether, Batch.Arrangement.Deposit, Batch.Split.Equal, 14 days, _range(1, 40), 100, 0, ratingsOf(address(factory))));
        vm.prank(bob);
        factory.deposit(address(b), _range(51, 40));
        ready(b);
        b.assemble();
        assertEq(b.minBid(), 5 ether);
        vm.warp(b.assembledAt() + 7 days - 1);
        assertEq(b.minBid(), 5 ether);
        vm.warp(b.assembledAt() + 7 days);
        assertEq(b.minBid(), b.MIN_RAISE()); // 0.01 ETH floor once the reserve lapses, never dust
        vm.prank(carol);
        vm.expectRevert(abi.encodeWithSelector(Batch.BidTooLow.selector, b.MIN_RAISE()));
        b.bid{value: 1}();
        vm.prank(carol);
        b.bid{value: 0.01 ether}();
        skip(1 days);
        b.settle();
        assertGt(b.payoutPerShare(), 0);
    }

    function test_FactoryIsolation() public {
        BatchFactory f2 = new BatchFactory(
            ICredits(address(credits)), IRatings(address(0)), new MockAssembler(statement), address(0), fee, 100, 0, 10
        );
        _approveAll(f2);
        Batch b2 = _open(f2, alice, Batch.Arrangement.Deposit, _range(1, 10));
        vm.prank(bob);
        vm.expectRevert(BatchFactory.NotBatch.selector);
        factory.deposit(address(b2), _one(51));
        vm.prank(bob);
        vm.expectRevert(BatchFactory.NotBatch.selector);
        factory.depositFor(address(b2), _one(51), bob);
        vm.expectRevert(Batch.NotFactory.selector);
        b2.depositFrom(bob, _one(51));
        // minOpen boundary and durations
        vm.prank(carol);
        vm.expectRevert(abi.encodeWithSelector(BatchFactory.TooFewToOpen.selector, 10));
        factory.create("x", noFilter, new uint256[](0), 0, Batch.Arrangement.Deposit, Batch.Split.Equal, 14 days, _range(101, 9), 100, 0, ratingsOf(address(factory)));
        vm.prank(carol);
        vm.expectRevert(BatchFactory.BadDuration.selector);
        factory.create("x", noFilter, new uint256[](0), 0, Batch.Arrangement.Deposit, Batch.Split.Equal, 3 days - 1, _range(101, 10), 100, 0, ratingsOf(address(factory)));
        vm.prank(carol);
        vm.expectRevert(BatchFactory.BadDuration.selector);
        factory.create("x", noFilter, new uint256[](0), 0, Batch.Arrangement.Deposit, Batch.Split.Equal, 90 days + 1, _range(101, 10), 100, 0, ratingsOf(address(factory)));
        vm.prank(carol);
        factory.create("x", noFilter, new uint256[](0), 0, Batch.Arrangement.Deposit, Batch.Split.Equal, 90 days, _range(101, 10), 100, 0, ratingsOf(address(factory)));
    }

    // test_UnlockEdges covered the retired 7-day lock; the new edges are in test/Lock.t.sol.
}
