// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test, stdError} from "forge-std/Test.sol";
import {Batch, IRatings} from "../../src/Batch.sol";
import {BatchFactory} from "../../src/BatchFactory.sol";
import {Sweeper} from "../../src/Sweeper.sol";
import {ICreditStrategy} from "../../src/interfaces/ICreditStrategy.sol";
import {IFWAMarket} from "../../src/interfaces/IFWAMarket.sol";
import {Ratings, DataStore} from "../../src/Ratings.sol";
import {RatingsDeploy} from "../../script/DeployRatings.s.sol";
import {MockAssembler} from "../../src/mocks/MockAssembler.sol";
import {ICredits} from "../../src/interfaces/ICredits.sol";
import {IAssembler} from "../../src/interfaces/IAssembler.sol";
import {MockCredits} from "../../src/mocks/MockCredits.sol";
import {MockStatement} from "../../src/mocks/MockStatement.sol";
import {ready} from "../utils/Ready.sol";
import {
    AdvancedOrder,
    ConsiderationItem,
    CriteriaResolver,
    Execution,
    FulfillmentComponent,
    ISeaport,
    ItemType,
    OfferItem,
    OrderParameters,
    OrderType,
    ReceivedItem
} from "../../src/interfaces/ISeaport.sol";

/// @dev Minimal Seaport stand-in: fills the first `fillCount` orders (ERC721 for ETH), skips the rest,
///      returns NATIVE executions for what it paid out and refunds the unspent msg.value to the caller.
contract MockSeaport {
    MockCredits immutable credits;
    uint256 public fillCount;

    constructor(MockCredits c) {
        credits = c;
    }

    function setFill(uint256 n) external {
        fillCount = n;
    }

    function fulfillAvailableAdvancedOrders(
        AdvancedOrder[] calldata orders,
        CriteriaResolver[] calldata,
        FulfillmentComponent[][] calldata,
        FulfillmentComponent[][] calldata,
        bytes32,
        address recipient,
        uint256
    ) external payable returns (bool[] memory available, Execution[] memory executions) {
        uint256 n = orders.length;
        available = new bool[](n);
        uint256 f = fillCount < n ? fillCount : n;
        executions = new Execution[](f * 2);
        uint256 spent;
        uint256 k;
        for (uint256 i; i < f; ++i) {
            available[i] = true;
            OfferItem calldata o = orders[i].parameters.offer[0];
            ConsiderationItem calldata c = orders[i].parameters.consideration[0];
            credits.transferFrom(orders[i].parameters.offerer, recipient, o.identifierOrCriteria);
            (bool ok,) = c.recipient.call{value: c.startAmount}("");
            require(ok, "pay");
            spent += c.startAmount;
            executions[k++] = Execution(
                ReceivedItem(ItemType.ERC721, o.token, o.identifierOrCriteria, 1, payable(recipient)),
                orders[i].parameters.offerer,
                bytes32(0)
            );
            executions[k++] = Execution(
                ReceivedItem(ItemType.NATIVE, address(0), 0, c.startAmount, c.recipient),
                orders[i].parameters.offerer,
                bytes32(0)
            );
        }
        require(msg.value >= spent, "insufficient");
        if (msg.value > spent) {
            (bool ok,) = msg.sender.call{value: msg.value - spent}("");
            require(ok, "refund");
        }
    }
}

contract Adversarial2Test is Test {
    MockCredits credits;
    MockStatement statement;
    BatchFactory factory;
    address fee = makeAddr("fee");
    address alice = makeAddr("alice");
    address bob = makeAddr("bob");
    address carol = makeAddr("carol");
    Batch.Filter noFilter;
    uint256[] none;

    function setUp() public {
        credits = new MockCredits();
        statement = new MockStatement(ICredits(address(credits)));
        factory = new BatchFactory(
            ICredits(address(credits)), IRatings(address(0)), new MockAssembler(statement), address(0), fee, 100, 0, 10
        );
        credits.mint(alice, 40); // 1..40
        credits.mint(alice, 10); // 41..50
        credits.mint(bob, 40); // 51..90
        credits.mint(bob, 10); // 91..100
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

    // ---------------------------------------------------------------- 1. fee snapshot

    /// A fee change after a batch opened never reaches it: settle() pays the split it opened with.
    function test_FeeSnapshotSurvivesSetFees() public {
        vm.prank(alice);
        Batch b = Batch(factory.create("S", noFilter, none, 0, Batch.Arrangement.Deposit, Batch.Split.Equal, 14 days, _range(1, 40), 100, 0));
        assertEq(b.protocolFeeBps(), 100);
        assertEq(b.creatorFeeBps(), 0);

        vm.prank(fee);
        factory.setFees(500, 1000); // raise both to the caps
        vm.prank(bob);
        factory.deposit(address(b), _range(51, 40));
        ready(b);
        b.assemble();
        vm.prank(carol);
        b.bid{value: 10 ether}();
        skip(1 days);
        uint256 feeBefore = fee.balance;
        uint256 aliceBefore = alice.balance;
        b.settle();
        assertEq(fee.balance - feeBefore, 0.1 ether, "protocol fee must be the 1% snapshot");
        assertEq(alice.balance - aliceBefore, 0, "creator fee must be the 0% snapshot");
        assertEq(b.payoutPerShare(), 9.9 ether / 80);
    }

    /// Low: create() has no fee bound. The fee recipient can front-run a create() with setFees so the batch
    /// opens at the caps (5% / 10%) and the creator's share can be zeroed, regardless of what the creator saw.
    function test_SetFeesFrontRunsCreate() public {
        // creator saw 1% / 0% ...
        assertEq(factory.protocolFeeBps(), 100);
        // ... fee recipient front-runs
        vm.prank(fee);
        factory.setFees(500, 1000);
        // Fixed: the creator states the fees they saw, and the open reverts instead of taking the new ones.
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(BatchFactory.FeesChanged.selector, 500, 1000));
        factory.create("F", noFilter, none, 0, Batch.Arrangement.Deposit, Batch.Split.Equal, 14 days, _range(1, 40), 100, 0);
        vm.prank(fee);
        factory.setFees(100, 0); // restored: opens as seen
        vm.prank(alice);
        Batch b = Batch(factory.create("F", noFilter, none, 0, Batch.Arrangement.Deposit, Batch.Split.Equal, 14 days, _range(1, 40), 100, 0));
        assertEq(b.protocolFeeBps(), 100);
        assertEq(b.creatorFeeBps(), 0);
    }

    /// The implementation and every clone refuse a second initialize; the factory pointer is fixed.
    function test_NoReinitialize() public {
        vm.prank(alice);
        Batch b = Batch(factory.create("I", noFilter, none, 0, Batch.Arrangement.Deposit, Batch.Split.Equal, 14 days, _range(1, 40), 100, 0));
        vm.expectRevert(Batch.AlreadyInitialized.selector);
        b.initialize(alice, "x", noFilter, none, 0, 0, 0, Batch.Arrangement.Deposit, Batch.Split.Equal, uint64(block.timestamp + 3 days));
        Batch impl = Batch(factory.implementation());
        vm.expectRevert(Batch.AlreadyInitialized.selector);
        impl.initialize(alice, "x", noFilter, none, 0, 0, 0, Batch.Arrangement.Deposit, Batch.Split.Equal, uint64(block.timestamp + 3 days));
    }

    // ---------------------------------------------------------------- 1b. sweep fee between quote and sweep

    function _orders(uint256 n) internal view returns (AdvancedOrder[] memory orders) {
        orders = new AdvancedOrder[](n);
        for (uint256 i; i < n; ++i) {
            OfferItem[] memory offer = new OfferItem[](1);
            offer[0] = OfferItem(ItemType.ERC721, address(credits), 51 + i, 1, 1);
            ConsiderationItem[] memory cons = new ConsiderationItem[](1);
            cons[0] = ConsiderationItem(ItemType.NATIVE, address(0), 0, 1 ether, 1 ether, payable(bob));
            orders[i].parameters = OrderParameters(
                bob, address(0), offer, cons, OrderType.FULL_OPEN, 0, type(uint256).max, 0, i, 0, 1
            );
            orders[i].numerator = 1;
            orders[i].denominator = 1;
        }
    }

    /// When every quoted listing fills, a raised fee makes the sweep revert (the AUDIT.md claim holds).
    function test_SweepFeeRaise_AllFill_Reverts() public {
        MockSeaport seaport = new MockSeaport(credits);
        Sweeper sweeper = new Sweeper(ISeaport(address(seaport)), factory, 100, IFWAMarket(address(0)), ICreditStrategy(address(0)));
        vm.prank(bob);
        credits.setApprovalForAll(address(seaport), true);
        vm.prank(alice);
        Batch b = Batch(factory.create("W", noFilter, none, 0, Batch.Arrangement.Deposit, Batch.Split.Equal, 14 days, _range(1, 10), 100, 0));

        uint256 q = sweeper.quote(10 ether); // 10.1
        vm.prank(fee);
        sweeper.setFee(500);
        seaport.setFill(10);
        vm.prank(carol);
        vm.expectRevert(abi.encodeWithSelector(Sweeper.FeeChanged.selector, 500));
        sweeper.sweep{value: q}(address(b), _orders(10), 1, 100); // carol was quoted 1%
    }

    /// Fixed: a raise after the quote reverts on partial fills too (before, the unspent ETH of sold-out
    /// listings silently covered the new rate). The buyer passes the rate they were quoted.
    function test_SweepFeeRaise_PartialFill_Reverts() public {
        MockSeaport seaport = new MockSeaport(credits);
        Sweeper sweeper = new Sweeper(ISeaport(address(seaport)), factory, 100, IFWAMarket(address(0)), ICreditStrategy(address(0)));
        vm.prank(bob);
        credits.setApprovalForAll(address(seaport), true);
        vm.prank(alice);
        Batch b = Batch(factory.create("W", noFilter, none, 0, Batch.Arrangement.Deposit, Batch.Split.Equal, 14 days, _range(1, 10), 100, 0));

        uint256 q = sweeper.quote(10 ether); // carol agreed to 1%: 0.1 ETH on 10 listings
        vm.prank(fee);
        sweeper.setFee(500);
        seaport.setFill(5); // 5 of 10 were already sold
        uint256 feeBefore = fee.balance;
        vm.prank(carol);
        vm.expectRevert(abi.encodeWithSelector(Sweeper.FeeChanged.selector, 500));
        sweeper.sweep{value: q}(address(b), _orders(10), 1, 100);
        // at the quoted rate it goes through and charges 1% of what filled
        vm.prank(fee);
        sweeper.setFee(100);
        vm.prank(carol);
        sweeper.sweep{value: q}(address(b), _orders(10), 1, 100);
        assertEq(fee.balance - feeBefore, 0.05 ether);
        assertEq(b.count(), 15);
    }

    // ---------------------------------------------------------------- 2. Ratings

    /// The init code returns exactly 0x00 || data as runtime.
    function test_DataStoreInitCode() public {
        bytes memory data = hex"deadbeef0102";
        address at = DataStore.write(data);
        assertEq(at.code, abi.encodePacked(hex"00", data));
        address e = DataStore.write("");
        assertEq(e.code, hex"00");
    }

    function _expected(uint256 id) internal pure returns (uint16) {
        return uint16(id % 60000 + 1);
    }

    /// Offset math and LE decode at every chunk boundary, with a synthetic table where score(id) is a
    /// known function of id (adjacent ids differ, so any off-by-one or byte swap is caught).
    function test_ScoreOfBoundaries() public {
        uint256 n = 122154;
        bytes memory data = new bytes(n * 2);
        for (uint256 i; i < n; ++i) {
            uint16 v = _expected(i + 1);
            data[2 * i] = bytes1(uint8(v));
            data[2 * i + 1] = bytes1(uint8(v >> 8));
        }
        Ratings r = RatingsDeploy.deploy(data);
        assertEq(r.count(), n);
        assertEq(r.chunks().length, 11);
        uint256[14] memory ids = [uint256(1), 2, 11999, 12000, 12001, 12002, 23999, 24000, 24001, 60000, 120000, 120001, 122153, 122154];
        for (uint256 i; i < ids.length; ++i) {
            assertEq(r.scoreOf(ids[i]), _expected(ids[i]), vm.toString(ids[i]));
        }
        assertEq(r.scoreOf(0), 0);
        assertEq(r.scoreOf(122155), 0);
        assertEq(r.scoreOf(type(uint256).max), 0);
        // last chunk is 2154 ids
        assertEq(r.chunks()[10].code.length, 2154 * 2 + 1);
        assertEq(r.chunks()[0].code.length, 24001);
    }

    /// The constructor checks each chunk's length but not that the last one holds <= PER_CHUNK ids, nor
    /// that count <= chunks * PER_CHUNK. A 12,287-id single chunk (24,575 bytes, still under EIP-170) is
    /// accepted and scoreOf panics past id 12,000 (deploy-time only; the script never produces this).
    /// Fixed: the chunk count must be exactly ceil(count / PER_CHUNK), so no id in range can miss a chunk.
    function test_ConstructorRejectsOversizedLastChunk() public {
        uint256 n = 12287;
        bytes memory data = new bytes(n * 2);
        address[] memory chunks = new address[](1);
        chunks[0] = DataStore.write(data);
        vm.expectRevert(Ratings.BadCount.selector);
        new Ratings(chunks, n);
        vm.expectRevert(Ratings.BadCount.selector);
        new Ratings(new address[](0), 5);
        vm.expectRevert(Ratings.BadCount.selector);
        new Ratings(chunks, 0);
    }

    /// The constructor rejects wrong lengths, EOAs and empty addresses.
    function test_ConstructorRejectsBadLengths() public {
        address[] memory chunks = new address[](1);
        chunks[0] = DataStore.write(new bytes(8)); // 4 ids
        vm.expectRevert(abi.encodeWithSelector(Ratings.BadChunk.selector, 0));
        new Ratings(chunks, 5);
        vm.expectRevert(abi.encodeWithSelector(Ratings.BadChunk.selector, 0));
        new Ratings(chunks, 3);
        vm.expectRevert(Ratings.BadCount.selector); // zero ids is refused before any chunk is read
        new Ratings(chunks, 0);
        chunks[0] = alice; // EOA
        vm.expectRevert(abi.encodeWithSelector(Ratings.BadChunk.selector, 0));
        new Ratings(chunks, 4);
        address[] memory two = new address[](2);
        two[0] = DataStore.write(new bytes(8));
        two[1] = DataStore.write(new bytes(2));
        vm.expectRevert(abi.encodeWithSelector(Ratings.BadChunk.selector, 0)); // first must be full
        new Ratings(two, 12001);
    }

    /// Info: the first byte is never validated (it is never read either), so a chunk with a live runtime
    /// of the right length is accepted. Only the deployer chooses chunks; post-Cancun code cannot change
    /// after its creation tx, so this is a deploy-time trust question, not a runtime attack.
    function test_ConstructorAcceptsLiveRuntimeChunk() public {
        bytes memory data = new bytes(8);
        bytes memory code = abi.encodePacked(hex"600B5981380380925939F3", hex"FE", data); // INVALID, then 8 bytes
        address at;
        assembly {
            at := create(0, add(code, 32), mload(code))
        }
        assertEq(at.code.length, 9);
        assertEq(at.code[0], bytes1(0xFE));
        address[] memory chunks = new address[](1);
        chunks[0] = at;
        Ratings r = new Ratings(chunks, 4);
        assertEq(r.scoreOf(1), 0);
    }

    // ---------------------------------------------------------------- 3. score rules in passes()

    function _ratedFactory() internal returns (BatchFactory f2, Ratings r) {
        // ids 1..4 score 1000, 5000, 8000, 5500; everything else unknown (0)
        bytes memory data = abi.encodePacked(bytes2(0xE803), bytes2(0x8813), bytes2(0x401F), bytes2(0x7C15));
        r = RatingsDeploy.deploy(data);
        f2 = new BatchFactory(
            ICredits(address(credits)), IRatings(address(r)), new MockAssembler(statement), address(0), fee, 100, 0, 1
        );
        vm.prank(alice);
        credits.setApprovalForAll(address(f2), true);
    }

    /// Every entry point that records a Credit runs passes(): factory deposit, depositFor, and the
    /// safeTransferFrom hook (with and without a beneficiary in data).
    function test_ScoreRuleOnEveryEntryPoint() public {
        (BatchFactory f2,) = _ratedFactory();
        Batch.Filter memory f;
        f.minScore = 4000;
        vm.prank(alice);
        Batch b = Batch(f2.create("R", f, none, 0, Batch.Arrangement.Deposit, Batch.Split.Equal, 14 days, _one(2), 100, 0));

        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(Batch.Excluded.selector, 1));
        f2.deposit(address(b), _one(1));
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(Batch.Excluded.selector, 1));
        f2.depositFor(address(b), _one(1), carol);
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(Batch.Excluded.selector, 1));
        credits.safeTransferFrom(alice, address(b), 1);
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(Batch.Excluded.selector, 1));
        credits.safeTransferFrom(alice, address(b), 1, abi.encode(carol));
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(Batch.Excluded.selector, 5)); // unknown id scores 0
        credits.safeTransferFrom(alice, address(b), 5);
        // create() itself with an excluded seed
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(Batch.Excluded.selector, 1));
        f2.create("R", f, none, 0, Batch.Arrangement.Deposit, Batch.Split.Equal, 14 days, _one(1), 100, 0);
        // a plain transferFrom is a stray, never recorded, and rescue() forwards it
        vm.prank(alice);
        credits.transferFrom(alice, address(b), 1);
        assertEq(b.depositorOf(1), address(0));
        b.rescue(address(credits), 1);
        assertEq(credits.ownerOf(1), fee);
        assertEq(b.count(), 1);
    }

    /// Info: a maxScore-only rule admits unknown ids, since they score 0 <= max. Harmless when the table
    /// covers the whole sealed edition (it does: 122,154 ids, min score 800) but worth knowing.
    /// Fixed: an id the table does not know (score 0) never satisfies a rating rule, even max-only.
    function test_MaxScoreOnlyRejectsUnknownIds() public {
        (BatchFactory f2,) = _ratedFactory();
        Batch.Filter memory f;
        f.maxScore = 6000;
        vm.prank(alice);
        Batch b = Batch(f2.create("M", f, none, 0, Batch.Arrangement.Deposit, Batch.Split.Equal, 14 days, _one(2), 100, 0));
        assertFalse(b.passes(5)); // unknown
        assertFalse(b.passes(200)); // unknown
        assertFalse(b.passes(3)); // 8000 > 6000
        assertTrue(b.passes(2));
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(Batch.Excluded.selector, 5));
        f2.deposit(address(b), _one(5));
    }

    /// BadFilter rules: min > max; any score rule on a factory without a table.
    function test_BadFilterRules() public {
        (BatchFactory f2,) = _ratedFactory();
        Batch.Filter memory f;
        f.minScore = 5000;
        f.maxScore = 4000;
        vm.prank(alice);
        vm.expectRevert(Batch.BadFilter.selector);
        f2.create("B", f, none, 0, Batch.Arrangement.Deposit, Batch.Split.Equal, 14 days, _one(2), 100, 0);
        f.maxScore = 0;
        vm.prank(alice);
        vm.expectRevert(Batch.BadFilter.selector);
        factory.create("B", f, none, 0, Batch.Arrangement.Deposit, Batch.Split.Equal, 14 days, _range(1, 10), 100, 0); // no table
        f.minScore = 0;
        f.maxScore = 1;
        vm.prank(alice);
        vm.expectRevert(Batch.BadFilter.selector);
        factory.create("B", f, none, 0, Batch.Arrangement.Deposit, Batch.Split.Equal, 14 days, _range(1, 10), 100, 0);
    }

    // ---------------------------------------------------------------- 4. feeRecipient powers

    /// The fee recipient has exactly: setFees (capped), Sweeper.setFee (capped), and receives protocol
    /// fees / strays. It cannot touch an open batch, its snapshot, the assembler, or pooled Credits.
    function test_FeeRecipientCannotTouchPooledCredits() public {
        vm.prank(alice);
        Batch b = Batch(factory.create("P", noFilter, none, 0, Batch.Arrangement.Deposit, Batch.Split.Equal, 14 days, _range(1, 40), 100, 0));
        vm.startPrank(fee);
        vm.expectRevert(abi.encodeWithSelector(Batch.NotStray.selector));
        b.rescue(address(credits), 1);
        vm.expectRevert(Batch.NotFactory.selector);
        b.depositFrom(fee, _one(41));
        vm.expectRevert(BatchFactory.ProtocolFeeTooHigh.selector);
        factory.setFees(501, 0);
        vm.expectRevert(BatchFactory.CreatorFeeTooHigh.selector);
        factory.setFees(0, 1001);
        IAssembler cur = factory.assembler();
        vm.expectRevert(BatchFactory.NotSetter.selector);
        factory.proposeAssembler(cur);
        vm.stopPrank();
        vm.prank(alice);
        vm.expectRevert(BatchFactory.NotFeeRecipient.selector);
        factory.setFees(0, 0);
    }
}
