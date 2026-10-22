// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {ratingsOf} from "../script/RatingsOf.sol";
import {Batch, IRatings} from "../src/Batch.sol";
import {BatchFactory} from "../src/BatchFactory.sol";
import {Sweeper} from "../src/Sweeper.sol";
import {ICCController, ICCCore} from "../src/interfaces/ICCController.sol";
import {ICreditStrategy} from "../src/interfaces/ICreditStrategy.sol";
import {IFWAMarket} from "../src/interfaces/IFWAMarket.sol";
import {ICredits} from "../src/interfaces/ICredits.sol";
import {MockAssembler} from "../src/mocks/MockAssembler.sol";
import {MockCredits} from "../src/mocks/MockCredits.sol";
import {MockStatement} from "../src/mocks/MockStatement.sol";
import {
    AdvancedOrder, ConsiderationItem, ISeaport, ItemType, OfferItem, OrderParameters, OrderType
} from "../src/interfaces/ISeaport.sol";
import {MockSeaport} from "./audit/Adversarial2.t.sol";

/// @dev $CC's Core as far as a buyer sees it: it names the controller selling from its pile, and can name another.
contract MockCCCore {
    address public controller;

    function setController(address c) external {
        controller = c;
    }
}

/// @dev The $CC engine's sale as ControllerV1 + Core run it: Credits held in the pile, each with a price that can move
///      before the buy lands, the price charged at that moment, the Credit sent to the caller with plain transferFrom,
///      the rest of what was sent refunded, the sale cuts paid out to its artist. Modes for the ways it can go wrong.
contract MockCCController {
    MockCredits immutable credits;
    address immutable artist;
    bool public creditSaleOn = true;
    bool public keepCredit; // takes the ETH, keeps the Credit
    uint256 public bump; // added to every price at the moment of the buy (a price that rose since the quote)
    uint256 public pushBack; // ETH sent back to the buyer during the buy, on top of the refund
    mapping(uint256 => uint256) public price;
    mapping(uint256 => bool) public inPile;

    error CreditSaleOff();
    error NotForSale();
    error Underpaid();

    constructor(MockCredits c, address artist_) {
        credits = c;
        artist = artist_;
    }

    function stock(uint256 id, uint256 p) external {
        credits.transferFrom(msg.sender, address(this), id);
        inPile[id] = true;
        price[id] = p;
    }

    function setSale(bool on) external {
        creditSaleOn = on;
    }

    function setKeep(bool on) external {
        keepCredit = on;
    }

    function setBump(uint256 b) external {
        bump = b;
    }

    function setPushBack(uint256 p) external payable {
        pushBack = p;
    }

    function creditPrice(uint256 id) external view returns (uint256) {
        if (!inPile[id]) revert NotForSale();
        return price[id];
    }

    function buyCredit(uint256 id) external payable {
        if (!creditSaleOn) revert CreditSaleOff();
        if (!inPile[id]) revert NotForSale();
        uint256 p = price[id] + bump;
        if (msg.value < p) revert Underpaid();
        inPile[id] = false;
        if (!keepCredit) credits.transferFrom(address(this), msg.sender, id);
        (bool ok,) = artist.call{value: p}("");
        require(ok, "artist");
        if (msg.value > p) {
            (ok,) = msg.sender.call{value: msg.value - p}("");
            require(ok, "refund");
        }
        if (pushBack != 0) {
            (ok,) = msg.sender.call{value: pushBack}("");
            require(ok, "push");
        }
    }

    receive() external payable {}
}

contract SweeperCCTest is Test {
    MockCredits credits;
    BatchFactory factory;
    MockCCController cc;
    MockCCCore core;
    MockSeaport seaport;
    Sweeper sweeper;
    Batch batch;
    address fee = makeAddr("fee");
    address alice = makeAddr("alice");
    address bob = makeAddr("bob"); // stocks the engine's pile and lists on Seaport
    address carol = makeAddr("carol"); // buys
    address artist = makeAddr("artist");
    Batch.Filter noFilter;

    function setUp() public {
        credits = new MockCredits();
        factory = new BatchFactory(
            ICredits(address(credits)),
            IRatings(address(0)),
            new MockAssembler(new MockStatement(ICredits(address(credits)))),
            address(0),
            fee,
            100,
            0,
            10
        );
        cc = new MockCCController(credits, artist);
        core = new MockCCCore();
        core.setController(address(cc));
        seaport = new MockSeaport(credits);
        sweeper = new Sweeper(
            ISeaport(address(seaport)), factory, 100, IFWAMarket(address(0)), ICreditStrategy(address(0)), ICCCore(address(core))
        );
        credits.mint(alice, 10); // 1..10
        credits.mint(bob, 20); // 11..30
        vm.prank(alice);
        credits.setApprovalForAll(address(factory), true);
        vm.startPrank(bob);
        credits.setApprovalForAll(address(cc), true);
        credits.setApprovalForAll(address(seaport), true);
        cc.stock(11, 1 ether);
        cc.stock(12, 2 ether);
        cc.stock(13, 0.5 ether);
        vm.stopPrank();
        vm.deal(carol, 100 ether);
        uint256[] memory first = new uint256[](10);
        for (uint256 i; i < 10; ++i) first[i] = i + 1;
        vm.prank(alice);
        batch = Batch(
            factory.create("CC", noFilter, new uint256[](0), 0, Batch.Arrangement.Deposit, Batch.Split.Equal, 14 days, first, 100, 0, ratingsOf(address(factory)))
        );
    }

    function _cc(uint256 id, uint256 maxPrice) internal pure returns (Sweeper.CCListing memory) {
        return Sweeper.CCListing(id, maxPrice);
    }

    function _sweep(uint256 value, Sweeper.CCListing[] memory listings, uint256 minBought) internal returns (uint256[] memory) {
        vm.prank(carol);
        return sweeper.sweepEvery{value: value}(
            address(batch), new AdvancedOrder[](0), new Sweeper.FWAListing[](0), new Sweeper.StrategyListing[](0), listings, minBought, 100
        );
    }

    function test_CC_BuysAtItsPrice_DepositsForTheBuyer_FeeOnWhatItCost() public {
        Sweeper.CCListing[] memory l = new Sweeper.CCListing[](2);
        l[0] = _cc(11, 1.1 ether); // quoted with room: the engine charges 1 and refunds the rest
        l[1] = _cc(12, 2.2 ether);
        uint256 carolBefore = carol.balance;

        uint256[] memory ids = _sweep(5 ether, l, 2);

        assertEq(ids.length, 2);
        assertEq(ids[0], 11);
        assertEq(ids[1], 12);
        assertEq(batch.count(), 12);
        assertEq(batch.depositorOf(11), carol);
        assertEq(batch.depositorOf(12), carol);
        assertEq(artist.balance, 3 ether); // the engine was paid its price, not the room
        assertEq(fee.balance, 0.03 ether); // 1% of what the Credits cost
        assertEq(carolBefore - carol.balance, 3.03 ether);
        assertEq(address(sweeper).balance, 0);
    }

    function test_CC_PriceAboveMaxIsSkipped_LikeASoldListing() public {
        cc.setBump(0.2 ether); // every price rose since the quote
        Sweeper.CCListing[] memory l = new Sweeper.CCListing[](2);
        l[0] = _cc(11, 1.1 ether); // now 1.2: skipped
        l[1] = _cc(13, 1 ether); // now 0.7: bought
        uint256 carolBefore = carol.balance;

        uint256[] memory ids = _sweep(3 ether, l, 1);

        assertEq(ids.length, 1);
        assertEq(ids[0], 13);
        assertEq(credits.ownerOf(11), address(cc));
        assertEq(carolBefore - carol.balance, 0.707 ether);
        assertEq(address(sweeper).balance, 0);
    }

    function test_CC_ControllerSwapped_BuysFromTheNewOne() public {
        // $CC moves its pile's sale to a new controller (as it went V1 to V2): this Sweeper follows Core, unchanged.
        MockCCController next = new MockCCController(credits, artist);
        vm.startPrank(bob);
        credits.setApprovalForAll(address(next), true);
        next.stock(14, 1 ether);
        vm.stopPrank();
        core.setController(address(next));
        Sweeper.CCListing[] memory l = new Sweeper.CCListing[](1);
        l[0] = _cc(14, 1 ether);

        uint256[] memory ids = _sweep(2 ether, l, 1);

        assertEq(ids.length, 1);
        assertEq(batch.depositorOf(14), carol);
        assertEq(artist.balance, 1 ether);
        assertEq(address(sweeper).balance, 0);
    }

    function test_CC_OldControllerAfterASwap_IsSkipped() public {
        // A Credit the old controller still holds isn't for sale through Core's new one: skipped, nothing paid.
        core.setController(address(new MockCCController(credits, artist)));
        Sweeper.CCListing[] memory l = new Sweeper.CCListing[](1);
        l[0] = _cc(11, 1.1 ether);
        uint256 carolBefore = carol.balance;
        vm.expectRevert(abi.encodeWithSelector(Sweeper.TooFewBought.selector, 0));
        _sweep(2 ether, l, 1);
        assertEq(carol.balance, carolBefore);
    }

    function test_CC_NoControllerIsSkipped() public {
        core.setController(address(0));
        Sweeper.CCListing[] memory l = new Sweeper.CCListing[](2);
        l[0] = _cc(11, 1.1 ether);
        l[1] = _cc(13, 1 ether);
        vm.expectRevert(abi.encodeWithSelector(Sweeper.TooFewBought.selector, 0));
        _sweep(3 ether, l, 1);
    }

    function test_CC_TooFewWhenItsSkipped() public {
        cc.setBump(1 ether);
        Sweeper.CCListing[] memory l = new Sweeper.CCListing[](1);
        l[0] = _cc(11, 1 ether);
        vm.expectRevert(abi.encodeWithSelector(Sweeper.TooFewBought.selector, 0));
        _sweep(2 ether, l, 1);
    }

    function test_CC_SoldOrOutOfThePileIsSkipped() public {
        Sweeper.CCListing[] memory l = new Sweeper.CCListing[](2);
        l[0] = _cc(14, 1 ether); // never in the pile
        l[1] = _cc(13, 0.5 ether);
        uint256[] memory ids = _sweep(2 ether, l, 1);
        assertEq(ids.length, 1);
        assertEq(ids[0], 13);
    }

    function test_CC_SaleOffSkipsAll() public {
        cc.setSale(false);
        Sweeper.CCListing[] memory l = new Sweeper.CCListing[](1);
        l[0] = _cc(11, 1 ether);
        vm.expectRevert(abi.encodeWithSelector(Sweeper.TooFewBought.selector, 0));
        _sweep(2 ether, l, 1);
    }

    function test_CC_KeptCreditRevertsTheWholeSweep() public {
        cc.setKeep(true);
        Sweeper.CCListing[] memory l = new Sweeper.CCListing[](1);
        l[0] = _cc(11, 1 ether);
        vm.expectRevert(abi.encodeWithSelector(Sweeper.NotDelivered.selector, 11));
        _sweep(2 ether, l, 1);
    }

    function test_CC_MoreQuotedThanSentIsUnderpaid() public {
        Sweeper.CCListing[] memory l = new Sweeper.CCListing[](2);
        l[0] = _cc(11, 1 ether);
        l[1] = _cc(12, 2 ether);
        vm.expectRevert(Sweeper.Underpaid.selector);
        _sweep(2.5 ether, l, 1); // the second's most is more than what's left after the first
    }

    function test_CC_NoEngineConfigured_Reverts() public {
        Sweeper plain = new Sweeper(
            ISeaport(address(seaport)), factory, 100, IFWAMarket(address(0)), ICreditStrategy(address(0)), ICCCore(address(0))
        );
        Sweeper.CCListing[] memory l = new Sweeper.CCListing[](1);
        l[0] = _cc(11, 1 ether);
        vm.prank(carol);
        vm.expectRevert(Sweeper.NoCC.selector);
        plain.sweepEvery{value: 2 ether}(
            address(batch), new AdvancedOrder[](0), new Sweeper.FWAListing[](0), new Sweeper.StrategyListing[](0), l, 1, 100
        );
    }

    function test_CC_ETHPushedBackMidBuy_GoesToTheBuyerNotTheFee() public {
        vm.deal(address(cc), 1 ether);
        cc.setPushBack(0.3 ether); // the engine (or its artist) sends extra ETH back during the buy
        Sweeper.CCListing[] memory l = new Sweeper.CCListing[](1);
        l[0] = _cc(13, 0.5 ether);
        uint256 carolBefore = carol.balance;

        uint256[] memory ids = _sweep(1 ether, l, 1);

        assertEq(ids.length, 1);
        // Cost read as 0.2 (0.5 paid, 0.3 back): the fee is on 0.2 and carol gets the pushed 0.3 back.
        assertEq(fee.balance, 0.002 ether);
        assertEq(carolBefore - carol.balance, 0.202 ether);
        assertEq(address(sweeper).balance, 0);
    }

    function _orders(uint256 from, uint256 n, uint256 p) internal view returns (AdvancedOrder[] memory orders) {
        orders = new AdvancedOrder[](n);
        for (uint256 i; i < n; ++i) {
            OfferItem[] memory offer = new OfferItem[](1);
            offer[0] = OfferItem(ItemType.ERC721, address(credits), from + i, 1, 1);
            ConsiderationItem[] memory cons = new ConsiderationItem[](1);
            cons[0] = ConsiderationItem(ItemType.NATIVE, address(0), 0, p, p, payable(bob));
            orders[i].parameters =
                OrderParameters(bob, address(0), offer, cons, OrderType.FULL_OPEN, 0, type(uint256).max, 0, i, 0, 1);
            orders[i].numerator = 1;
            orders[i].denominator = 1;
        }
    }

    function test_Mixed_SeaportAndCCInOneTransaction() public {
        seaport.setFill(2);
        Sweeper.CCListing[] memory l = new Sweeper.CCListing[](1);
        l[0] = _cc(13, 0.6 ether); // costs 0.5
        uint256 carolBefore = carol.balance;
        vm.prank(carol);
        uint256[] memory ids = sweeper.sweepEvery{value: 3 ether}(
            address(batch), _orders(20, 2, 1 ether), new Sweeper.FWAListing[](0), new Sweeper.StrategyListing[](0), l, 3, 100
        );
        assertEq(ids.length, 3);
        assertEq(ids[0], 13); // the engine's first, then Seaport's
        assertEq(batch.depositorOf(13), carol);
        assertEq(batch.depositorOf(20), carol);
        assertEq(batch.depositorOf(21), carol);
        assertEq(fee.balance, 0.025 ether); // 1% of 2.5
        assertEq(carolBefore - carol.balance, 2.525 ether);
        assertEq(address(sweeper).balance, 0);
    }

    function test_BuyEvery_ToTheWallet_FromThePileAndSeaport() public {
        seaport.setFill(1);
        Sweeper.CCListing[] memory l = new Sweeper.CCListing[](1);
        l[0] = _cc(13, 0.6 ether); // costs 0.5
        uint256 carolBefore = carol.balance;
        vm.prank(carol);
        uint256[] memory ids = sweeper.buyEvery{value: 2 ether}(
            _orders(20, 1, 1 ether), new Sweeper.FWAListing[](0), new Sweeper.StrategyListing[](0), l, 2, 100
        );
        assertEq(ids.length, 2);
        assertEq(credits.ownerOf(13), carol);
        assertEq(credits.ownerOf(20), carol);
        assertEq(fee.balance, 0.015 ether); // 1% of 1.5
        assertEq(carolBefore - carol.balance, 1.515 ether);
        assertEq(address(sweeper).balance, 0);
    }

    function test_BuyEvery_SkippedPileCreditStaysWithTheEngine() public {
        cc.setBump(1 ether);
        seaport.setFill(1);
        Sweeper.CCListing[] memory l = new Sweeper.CCListing[](1);
        l[0] = _cc(13, 0.6 ether); // now 1.5: skipped
        vm.prank(carol);
        uint256[] memory ids = sweeper.buyEvery{value: 2 ether}(
            _orders(20, 1, 1 ether), new Sweeper.FWAListing[](0), new Sweeper.StrategyListing[](0), l, 1, 100
        );
        assertEq(ids.length, 1);
        assertEq(credits.ownerOf(13), address(cc));
        assertEq(credits.ownerOf(20), carol);
    }

    function test_SweepAll_StillWorksWithoutCC() public {
        seaport.setFill(1);
        vm.prank(carol);
        uint256[] memory ids = sweeper.sweepAll{value: 2 ether}(
            address(batch), _orders(20, 1, 1 ether), new Sweeper.FWAListing[](0), new Sweeper.StrategyListing[](0), 1, 100
        );
        assertEq(ids.length, 1);
        assertEq(batch.depositorOf(20), carol);
    }
}
