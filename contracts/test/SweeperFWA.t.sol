// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {Batch, IRatings} from "../src/Batch.sol";
import {BatchFactory} from "../src/BatchFactory.sol";
import {Sweeper} from "../src/Sweeper.sol";
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

/// @dev FWAMarketplace's listing rules that the Sweeper relies on: custodial, exact price, buyable only after the
///      listing block, a reprice issues a new id, fees come out of the seller's side, delivery by transferFrom.
contract MockFWAMarket {
    uint256 public nextListingId = 1;
    bool public withdrawOnly;
    mapping(uint256 => IFWAMarket.Listing) internal _listings;

    function list(address collection, uint256 tokenId, uint96 price) external returns (uint256 id) {
        MockCredits(collection).transferFrom(msg.sender, address(this), tokenId);
        id = nextListingId++;
        _listings[id] = IFWAMarket.Listing(msg.sender, uint64(block.number), collection, price, tokenId, address(0), 0);
    }

    function reprice(uint256 id, uint96 price) external returns (uint256 newId) {
        IFWAMarket.Listing memory l = _listings[id];
        require(l.seller == msg.sender, "seller");
        delete _listings[id];
        newId = nextListingId++;
        l.price = price;
        l.createdBlock = uint64(block.number);
        _listings[newId] = l;
    }

    function setWithdrawOnly(bool on) external {
        withdrawOnly = on;
    }

    function getListing(uint256 id) external view returns (IFWAMarket.Listing memory) {
        return _listings[id];
    }

    function buy(uint256 id, address recipient) external payable {
        require(!withdrawOnly, "WithdrawOnlyModeActive");
        IFWAMarket.Listing memory l = _listings[id];
        require(l.seller != address(0), "InvalidOrder");
        require(block.number > l.createdBlock, "NotMature");
        require(msg.value == l.price, "IncorrectPayment");
        delete _listings[id];
        MockCredits(l.collection).transferFrom(address(this), recipient, l.tokenId);
        uint256 fee = msg.value / 200;
        (bool ok,) = l.seller.call{value: msg.value - fee}("");
        require(ok, "pay");
    }
}

contract SweeperFWATest is Test {
    MockCredits credits;
    MockCredits other;
    BatchFactory factory;
    MockFWAMarket market;
    MockSeaport seaport;
    Sweeper sweeper;
    Batch batch;
    address fee = makeAddr("fee");
    address alice = makeAddr("alice");
    address bob = makeAddr("bob"); // sells on both markets
    address carol = makeAddr("carol"); // buys
    Batch.Filter noFilter;

    function setUp() public {
        credits = new MockCredits();
        other = new MockCredits();
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
        market = new MockFWAMarket();
        seaport = new MockSeaport(credits);
        sweeper = new Sweeper(ISeaport(address(seaport)), factory, 100, IFWAMarket(address(market)), ICreditStrategy(address(0)));
        credits.mint(alice, 10); // 1..10
        credits.mint(bob, 20); // 11..30
        other.mint(bob, 1);
        vm.prank(alice);
        credits.setApprovalForAll(address(factory), true);
        vm.startPrank(bob);
        credits.setApprovalForAll(address(market), true);
        credits.setApprovalForAll(address(seaport), true);
        other.setApprovalForAll(address(market), true);
        vm.stopPrank();
        vm.deal(carol, 100 ether);
        uint256[] memory first = new uint256[](10);
        for (uint256 i; i < 10; ++i) first[i] = i + 1;
        vm.prank(alice);
        batch = Batch(
            factory.create("FWA", noFilter, new uint256[](0), 0, Batch.Arrangement.Deposit, Batch.Split.Equal, 14 days, first, 100, 0)
        );
    }

    function _list(uint256 tokenId, uint96 price) internal returns (uint256 id) {
        vm.prank(bob);
        id = market.list(address(credits), tokenId, price);
    }

    function _fwa(uint256 id, uint256 price) internal pure returns (Sweeper.FWAListing memory) {
        return Sweeper.FWAListing(id, price);
    }

    function _orders(uint256 from, uint256 n, uint256 price) internal view returns (AdvancedOrder[] memory orders) {
        orders = new AdvancedOrder[](n);
        for (uint256 i; i < n; ++i) {
            OfferItem[] memory offer = new OfferItem[](1);
            offer[0] = OfferItem(ItemType.ERC721, address(credits), from + i, 1, 1);
            ConsiderationItem[] memory cons = new ConsiderationItem[](1);
            cons[0] = ConsiderationItem(ItemType.NATIVE, address(0), 0, price, price, payable(bob));
            orders[i].parameters =
                OrderParameters(bob, address(0), offer, cons, OrderType.FULL_OPEN, 0, type(uint256).max, 0, i, 0, 1);
            orders[i].numerator = 1;
            orders[i].denominator = 1;
        }
    }

    function test_FWAOnly_BuysDepositsChargesFeeRefundsRest() public {
        uint256 a = _list(11, 1 ether);
        uint256 b = _list(12, 2 ether);
        vm.roll(block.number + 1);
        Sweeper.FWAListing[] memory fwa = new Sweeper.FWAListing[](2);
        fwa[0] = _fwa(a, 1 ether);
        fwa[1] = _fwa(b, 2 ether);
        uint256 bobBefore = bob.balance;
        uint256 carolBefore = carol.balance;

        vm.prank(carol);
        uint256[] memory ids =
            sweeper.sweepAll{value: 5 ether}(address(batch), new AdvancedOrder[](0), fwa, new Sweeper.StrategyListing[](0), 2, 100);

        assertEq(ids.length, 2);
        assertEq(ids[0], 11);
        assertEq(ids[1], 12);
        assertEq(batch.count(), 12);
        assertEq(batch.depositorOf(11), carol);
        assertEq(batch.depositorOf(12), carol);
        assertEq(fee.balance, 0.03 ether); // 1% of 3 ETH
        assertEq(carolBefore - carol.balance, 3.03 ether); // the rest came back
        assertEq(bob.balance - bobBefore, 3 ether - 0.015 ether); // FWA's fee is the seller's
        assertEq(address(sweeper).balance, 0);
    }

    function test_Mixed_OpenSeaAndFWAInOneTransaction() public {
        uint256 a = _list(20, 0.5 ether);
        vm.roll(block.number + 1);
        seaport.setFill(2);
        Sweeper.FWAListing[] memory fwa = new Sweeper.FWAListing[](1);
        fwa[0] = _fwa(a, 0.5 ether);
        uint256 value = sweeper.quote(2.5 ether);

        vm.prank(carol);
        uint256[] memory ids = sweeper.sweepAll{value: value}(address(batch), _orders(11, 2, 1 ether), fwa, new Sweeper.StrategyListing[](0), 3, 100);

        assertEq(ids.length, 3);
        assertEq(ids[0], 20); // FWA first, then Seaport in order
        assertEq(ids[1], 11);
        assertEq(ids[2], 12);
        assertEq(batch.count(), 13);
        assertEq(fee.balance, 0.025 ether);
        assertEq(address(sweeper).balance, 0);
        assertEq(credits.ownerOf(20), address(batch));
    }

    /// Gone, repriced (the quoted id is gone) and listed-this-block listings are skipped, and their ETH comes back.
    function test_SkipsGoneRepricedAndImmature() public {
        uint256 a = _list(11, 1 ether);
        uint256 b = _list(12, 1 ether);
        uint256 c = _list(13, 1 ether);
        vm.roll(block.number + 1);
        vm.prank(bob);
        market.reprice(b, 0.9 ether); // new id, fresh block: the old id reads as gone
        uint256 d = _list(14, 1 ether); // listed this block: not buyable yet
        Sweeper.FWAListing[] memory fwa = new Sweeper.FWAListing[](4);
        fwa[0] = _fwa(a, 1 ether);
        fwa[1] = _fwa(b, 1 ether);
        fwa[2] = _fwa(c, 1 ether);
        fwa[3] = _fwa(d, 1 ether);
        uint256 carolBefore = carol.balance;
        uint256 value = sweeper.quote(4 ether);

        vm.prank(carol);
        uint256[] memory ids = sweeper.sweepAll{value: value}(
            address(batch), new AdvancedOrder[](0), fwa, new Sweeper.StrategyListing[](0), 1, 100
        );
        assertEq(ids.length, 2);
        assertEq(ids[0], 11);
        assertEq(ids[1], 13);
        assertEq(carolBefore - carol.balance, sweeper.quote(2 ether));
        assertEq(credits.ownerOf(14), address(market));
    }

    /// A stale quote whose price no longer matches is skipped, never paid at a different price.
    function test_PriceMismatchSkipped() public {
        uint256 a = _list(11, 1 ether);
        vm.roll(block.number + 1);
        Sweeper.FWAListing[] memory fwa = new Sweeper.FWAListing[](1);
        fwa[0] = _fwa(a, 2 ether);
        vm.prank(carol);
        vm.expectRevert(abi.encodeWithSelector(Sweeper.TooFewBought.selector, 0));
        sweeper.sweepAll{value: 3 ether}(address(batch), new AdvancedOrder[](0), fwa, new Sweeper.StrategyListing[](0), 1, 100);
    }

    function test_MinBoughtCountsBothMarkets() public {
        uint256 a = _list(20, 1 ether);
        vm.roll(block.number + 1);
        seaport.setFill(1); // one of two Seaport listings already sold
        Sweeper.FWAListing[] memory fwa = new Sweeper.FWAListing[](1);
        fwa[0] = _fwa(a, 1 ether);
        vm.prank(carol);
        vm.expectRevert(abi.encodeWithSelector(Sweeper.TooFewBought.selector, 2));
        sweeper.sweepAll{value: 4 ether}(address(batch), _orders(11, 2, 1 ether), fwa, new Sweeper.StrategyListing[](0), 3, 100);
        vm.prank(carol);
        uint256[] memory ids = sweeper.sweepAll{value: 4 ether}(address(batch), _orders(11, 2, 1 ether), fwa, new Sweeper.StrategyListing[](0), 2, 100);
        assertEq(ids.length, 2);
    }

    function test_NotACreditReverts() public {
        vm.prank(bob);
        uint256 a = market.list(address(other), 1, 1 ether);
        vm.roll(block.number + 1);
        Sweeper.FWAListing[] memory fwa = new Sweeper.FWAListing[](1);
        fwa[0] = _fwa(a, 1 ether);
        vm.prank(carol);
        vm.expectRevert(abi.encodeWithSelector(Sweeper.NotAFWACredit.selector, 0));
        sweeper.sweepAll{value: 2 ether}(address(batch), new AdvancedOrder[](0), fwa, new Sweeper.StrategyListing[](0), 1, 100);
    }

    function test_UnderpaidReverts() public {
        uint256 a = _list(11, 1 ether);
        uint256 b = _list(12, 1 ether);
        vm.roll(block.number + 1);
        Sweeper.FWAListing[] memory fwa = new Sweeper.FWAListing[](2);
        fwa[0] = _fwa(a, 1 ether);
        fwa[1] = _fwa(b, 1 ether);
        vm.prank(carol);
        vm.expectRevert(Sweeper.Underpaid.selector);
        sweeper.sweepAll{value: 1.5 ether}(address(batch), new AdvancedOrder[](0), fwa, new Sweeper.StrategyListing[](0), 1, 100);
    }

    /// The market refusing a buy (its withdraw-only switch) skips the listing instead of reverting everything.
    function test_MarketRefusalSkipped() public {
        uint256 a = _list(20, 1 ether);
        vm.roll(block.number + 1);
        market.setWithdrawOnly(true);
        seaport.setFill(1);
        Sweeper.FWAListing[] memory fwa = new Sweeper.FWAListing[](1);
        fwa[0] = _fwa(a, 1 ether);
        vm.prank(carol);
        uint256[] memory ids = sweeper.sweepAll{value: 3 ether}(address(batch), _orders(11, 1, 1 ether), fwa, new Sweeper.StrategyListing[](0), 1, 100);
        assertEq(ids.length, 1);
        assertEq(ids[0], 11);
        assertEq(credits.ownerOf(20), address(market));
        assertEq(address(sweeper).balance, 0);
    }

    function test_FeeRaiseReverts() public {
        uint256 a = _list(11, 1 ether);
        vm.roll(block.number + 1);
        vm.prank(fee);
        sweeper.setFee(300);
        Sweeper.FWAListing[] memory fwa = new Sweeper.FWAListing[](1);
        fwa[0] = _fwa(a, 1 ether);
        vm.prank(carol);
        vm.expectRevert(abi.encodeWithSelector(Sweeper.FeeChanged.selector, 300));
        sweeper.sweepAll{value: 2 ether}(address(batch), new AdvancedOrder[](0), fwa, new Sweeper.StrategyListing[](0), 1, 100);
    }

    function test_NoMarketConfiguredReverts() public {
        Sweeper plain = new Sweeper(ISeaport(address(seaport)), factory, 100, IFWAMarket(address(0)), ICreditStrategy(address(0)));
        Sweeper.FWAListing[] memory fwa = new Sweeper.FWAListing[](1);
        fwa[0] = _fwa(1, 1 ether);
        vm.prank(carol);
        vm.expectRevert(Sweeper.NoFWA.selector);
        plain.sweepAll{value: 2 ether}(address(batch), new AdvancedOrder[](0), fwa, new Sweeper.StrategyListing[](0), 1, 100);
    }

    /// The old entry point is unchanged: Seaport only.
    function test_PlainSweepStillWorks() public {
        seaport.setFill(2);
        uint256 value = sweeper.quote(2 ether);
        vm.prank(carol);
        uint256[] memory ids = sweeper.sweep{value: value}(address(batch), _orders(11, 2, 1 ether), 2, 100);
        assertEq(ids.length, 2);
        assertEq(batch.count(), 12);
    }
}
