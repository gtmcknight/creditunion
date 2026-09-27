// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {FormalBase} from "./FormalBase.sol";
import {IERC721} from "@openzeppelin/contracts/token/ERC721/IERC721.sol";
import {Wallet} from "./BatchAuctionFormal.t.sol";
import {FormalSeaport} from "./FormalSeaport.sol";
import {MockFWAMarket} from "../SweeperFWA.t.sol";
import {Batch} from "../../src/Batch.sol";
import {Sweeper} from "../../src/Sweeper.sol";
import {ICreditStrategy} from "../../src/interfaces/ICreditStrategy.sol";
import {IFWAMarket} from "../../src/interfaces/IFWAMarket.sol";
import {
    AdvancedOrder, ConsiderationItem, ISeaport, ItemType, OfferItem, OrderParameters, OrderType
} from "../../src/interfaces/ISeaport.sol";

/// @dev CreditStrategy's sale rule as the Sweeper relies on it: exact price, delivery to the caller, price
///      cleared once sold.
contract FormalStrategy {
    address public immutable collection;
    mapping(uint256 => uint256) public nftForSale;

    constructor(address c) {
        collection = c;
    }

    function offer(uint256 id, uint256 price) external {
        nftForSale[id] = price;
    }

    function sellTargetNFT(uint256 id) external payable {
        require(nftForSale[id] != 0 && msg.value == nftForSale[id], "price");
        delete nftForSale[id];
        IERC721(collection).transferFrom(address(this), msg.sender, id);
    }
}

/// @dev Three sellers, one Credit each: #2 on Seaport, #3 on FWA's marketplace, #4 held by CreditStrategy.
///      An open batch holds Alice's #1. A buyer sweeps into the batch.
contract SweeperFormal is FormalBase {
    Sweeper internal sweeper;
    FormalSeaport internal seaport;
    MockFWAMarket internal fwa;
    FormalStrategy internal strategy;
    Batch internal batch;
    address internal buyer;
    address internal seller;
    address internal fwaSeller;
    uint256 internal constant FEE_BPS = 200;

    function setUp() public {
        _world(true);
        seaport = new FormalSeaport();
        fwa = new MockFWAMarket();
        strategy = new FormalStrategy(address(credits));
        sweeper = new Sweeper(ISeaport(address(seaport)), factory, FEE_BPS, IFWAMarket(address(fwa)), ICreditStrategy(address(strategy)));
        buyer = address(new Wallet());
        seller = address(new Wallet());
        fwaSeller = address(new Wallet());
        credits.mint(ALICE, 1); // #1
        credits.mint(seller, 1); // #2
        credits.mint(fwaSeller, 1); // #3
        credits.mint(address(strategy), 1); // #4
        vm.prank(seller);
        credits.setApprovalForAll(address(seaport), true);
        batch = _open(ALICE, _ids(1, 1), Batch.Split.Equal);
    }

    function _order(uint256 price) internal view returns (AdvancedOrder[] memory o) {
        o = new AdvancedOrder[](1);
        OrderParameters memory p;
        p.offerer = seller;
        p.offer = new OfferItem[](1);
        p.offer[0] = OfferItem(ItemType.ERC721, address(credits), 2, 1, 1);
        p.consideration = new ConsiderationItem[](1);
        p.consideration[0] = ConsiderationItem(ItemType.NATIVE, address(0), 0, price, price, payable(seller));
        p.orderType = OrderType.FULL_OPEN;
        o[0].parameters = p;
        o[0].numerator = 1;
        o[0].denominator = 1;
    }

    /// Only the fee recipient changes the sweep fee, and never above 5%.
    function check_setFee_onlyRecipientAndCapped(address caller, uint256 bps) public {
        vm.prank(caller);
        try sweeper.setFee(bps) {
            assert(caller == FEE);
        } catch {}
        assert(sweeper.feeBps() <= 500);
    }

    /// A Seaport sweep holds nothing afterwards, charges exactly listing + fee, refunds the rest, and records the
    /// buyer (not the Sweeper) as depositor.
    function check_sweepExactAndHoldsNothing(uint256 price, uint256 value) public {
        vm.assume(price <= 1e30 && value <= 1e30);
        vm.deal(buyer, value);
        vm.prank(buyer);
        try sweeper.sweep{value: value}(address(batch), _order(price), 1, FEE_BPS) {
            uint256 fee = price * FEE_BPS / 10_000;
            assert(address(sweeper).balance == 0);
            assert(buyer.balance == value - price - fee);
            assert(seller.balance == price);
            assert(FEE.balance == fee);
            assert(batch.depositorOf(2) == buyer);
            assert(credits.ownerOf(2) == address(batch));
        } catch {
            assert(buyer.balance == value);
        }
    }

    /// Across all three markets in one sweep: the buyer pays exactly what the listings they got cost plus the
    /// fee, never more than they were quoted; a listing whose live price differs from the quote is skipped,
    /// never paid; every Credit bought is booked to the buyer; the Sweeper keeps nothing.
    function check_sweepAllExactAndHoldsNothing(
        uint96 fwaLive,
        uint256 fwaQuote,
        uint256 stratLive,
        uint256 stratQuote,
        uint256 seaPrice,
        uint256 value
    ) public {
        vm.assume(fwaQuote <= 1e30 && stratLive <= 1e30 && stratQuote <= 1e30 && seaPrice <= 1e30 && value <= 4e30);
        vm.startPrank(fwaSeller);
        credits.setApprovalForAll(address(fwa), true);
        uint256 listingId = fwa.list(address(credits), 3, fwaLive);
        vm.stopPrank();
        strategy.offer(4, stratLive);
        vm.roll(block.number + 1);

        Sweeper.FWAListing[] memory fl = new Sweeper.FWAListing[](1);
        fl[0] = Sweeper.FWAListing(listingId, fwaQuote);
        Sweeper.StrategyListing[] memory sl = new Sweeper.StrategyListing[](1);
        sl[0] = Sweeper.StrategyListing(4, stratQuote);

        vm.deal(buyer, value);
        vm.prank(buyer);
        try sweeper.sweepAll{value: value}(address(batch), _order(seaPrice), fl, sl, 1, FEE_BPS) {
            bool gotF = credits.ownerOf(3) == address(batch);
            bool gotS = credits.ownerOf(4) == address(batch);
            // bought only at the quoted price
            if (gotF) assert(fwaQuote == fwaLive);
            if (gotS) assert(stratQuote == stratLive && stratLive != 0);
            uint256 spent = seaPrice + (gotF ? fwaQuote : 0) + (gotS ? stratQuote : 0);
            uint256 fee = spent * FEE_BPS / 10_000;
            assert(address(sweeper).balance == 0);
            assert(buyer.balance == value - spent - fee);
            assert(FEE.balance == fee);
            assert(batch.depositorOf(2) == buyer);
            if (gotF) assert(batch.depositorOf(3) == buyer);
            if (gotS) assert(batch.depositorOf(4) == buyer);
            assert(credits.ownerOf(3) == address(batch) || credits.ownerOf(3) == address(fwa));
            assert(credits.ownerOf(4) == address(batch) || credits.ownerOf(4) == address(strategy));
        } catch {
            assert(buyer.balance == value);
        }
    }

    /// A raised fee never applies to a sweep quoted at the old rate.
    function check_feeRaiseNeverSlipsIn(uint256 quoted, uint256 price) public {
        vm.assume(price <= 1e30 && quoted < FEE_BPS);
        uint256 value = price * 2 + 1 ether;
        vm.deal(buyer, value);
        vm.prank(buyer);
        try sweeper.sweep{value: value}(address(batch), _order(price), 1, quoted) {
            assert(false);
        } catch {}
    }

    /// Sweeps only ever deposit into batches the factory made.
    function check_sweepOnlyIntoBatches(address target, uint256 price) public {
        vm.assume(!factory.isBatch(target) && price <= 1e30);
        vm.deal(buyer, price * 2);
        vm.prank(buyer);
        try sweeper.sweep{value: price * 2}(target, _order(price), 1, FEE_BPS) {
            assert(false);
        } catch {}
    }

    /// The Sweeper can't be pointed at a strategy that trades some other collection.
    function check_constructorRejectsOtherStrategy(address collection) public {
        FormalStrategy other = new FormalStrategy(collection);
        try new Sweeper(ISeaport(address(seaport)), factory, FEE_BPS, IFWAMarket(address(fwa)), ICreditStrategy(address(other))) {
            assert(collection == address(credits));
        } catch {}
    }
}
