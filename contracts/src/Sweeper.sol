// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {ReentrancyGuardTransient} from "@openzeppelin/contracts/utils/ReentrancyGuardTransient.sol";
import {BatchFactory} from "./BatchFactory.sol";
import {ICredits} from "./interfaces/ICredits.sol";
import {ICCController, ICCCore} from "./interfaces/ICCController.sol";
import {ICreditStrategy} from "./interfaces/ICreditStrategy.sol";
import {IFWAMarket} from "./interfaces/IFWAMarket.sol";
import {
    AdvancedOrder,
    CriteriaResolver,
    Execution,
    FulfillmentComponent,
    ISeaport,
    ItemType,
    OfferItem
} from "./interfaces/ISeaport.sol";

/// @title Sweeper
/// @notice One transaction: buy listed Credits on Seaport (OpenSea's exchange), FWA's marketplace, from
///         CreditStrategy and from the $CC engine's pile, then deposit them into a batch in the buyer's name (or send
///         them to the buyer's wallet). Pay the listings plus the fee; unused ETH comes back.
///         Nothing is held between transactions. No owner, no admin.
contract Sweeper is ReentrancyGuardTransient {
    uint256 public constant MAX_FEE_BPS = 500;

    /// @notice Fee on what the listings cost, in basis points. 
    /// @notice Fee on each buy-in, quoted before anyone signs. The fee recipient may change it within MAX_FEE_BPS.
    uint256 public feeBps;

    ISeaport public immutable seaport;
    /// @notice FWA's marketplace (FWAMarketplace). Zero where it isn't deployed; FWA buys then revert.
    IFWAMarket public immutable fwa;
    /// @notice CreditStrategy (nftstrategy.fun), which sells the Credits it holds. Zero where it isn't deployed;
    ///         strategy buys then revert.
    ICreditStrategy public immutable strategy;
    /// @notice The $CC engine's Core, whose controller of the moment sells the Credits its pile holds (read at each
    ///         buy, so a controller swap on their side doesn't strand this one). Zero where it isn't deployed; $CC buys
    ///         then revert.
    ICCCore public immutable cc;
    BatchFactory public immutable factory;
    ICredits public immutable credits;
    address public immutable feeRecipient;

    event Swept(address indexed buyer, address indexed batch, uint256 bought, uint256 spent, uint256 fee);
    event Bought(address indexed buyer, uint256 bought, uint256 spent, uint256 fee);

    error NotBatch();
    error NotACredit(uint256 orderIndex);
    error TooFewBought(uint256 bought);
    error FeeNotCovered(uint256 fee);
    error PaymentFailed();
    error FeeTooHigh();
    error FeeChanged(uint256 feeBps);
    error NotFeeRecipient();
    error NoFWA();
    error NotAFWACredit(uint256 fwaIndex);
    error Underpaid();
    error NotDelivered(uint256 id);
    error NoStrategy();
    error NotACreditStrategy();
    error NoCC();

    /// @notice One FWA listing to buy, at the price it was quoted. A listing whose price changed has a new id,
    ///         so the old one reads as gone and is skipped.
    struct FWAListing {
        uint256 listingId;
        uint256 price;
    }

    /// @notice One Credit CreditStrategy holds, at the price it was quoted. A Credit sold or repriced since is skipped.
    struct StrategyListing {
        uint256 tokenId;
        uint256 price;
    }

    /// @notice One Credit the $CC engine's pile holds, and the most to pay for it: its price moves block to block, so
    ///         it is bought at the price then and the rest comes back. One sold, out of the pile, with the sale off,
    ///         or priced above `maxPrice` by then is skipped.
    struct CCListing {
        uint256 tokenId;
        uint256 maxPrice;
    }

    event FeeSet(uint256 feeBps);

    constructor(
        ISeaport seaport_,
        BatchFactory factory_,
        uint256 feeBps_,
        IFWAMarket fwa_,
        ICreditStrategy strategy_,
        ICCCore cc_
    ) {
        if (feeBps_ > MAX_FEE_BPS) revert FeeTooHigh();
        feeBps = feeBps_;
        emit FeeSet(feeBps_);
        seaport = seaport_;
        fwa = fwa_;
        factory = factory_;
        credits = factory_.credits();
        if (address(strategy_) != address(0) && strategy_.collection() != address(credits)) revert NotACreditStrategy();
        strategy = strategy_;
        cc = cc_;
        feeRecipient = factory_.feeRecipient();
        credits.setApprovalForAll(address(factory_), true);
    }

    /// @notice Change the buy-in fee, never above MAX_FEE_BPS. Every quote and sweep reads the current value.
    function setFee(uint256 feeBps_) external {
        if (msg.sender != feeRecipient) revert NotFeeRecipient();
        if (feeBps_ > MAX_FEE_BPS) revert FeeTooHigh();
        feeBps = feeBps_;
        emit FeeSet(feeBps_);
    }

    /// @param orders Seaport listings, each selling exactly one Credit for ETH (as returned by OpenSea).
    /// @param minBought Revert unless at least this many listings were still available.
    /// @param maxFeeBps The fee rate you were quoted; reverts if it has been raised since, so a fee change can
    ///        never apply to a purchase signed under the old rate (partial fills included).
    /// @return ids The Credits bought and deposited, in order.
    function sweep(address batch, AdvancedOrder[] calldata orders, uint256 minBought, uint256 maxFeeBps)
        external
        payable
        nonReentrant
        returns (uint256[] memory ids)
    {
        return _sweep(batch, orders, new FWAListing[](0), new StrategyListing[](0), new CCListing[](0), minBought, maxFeeBps);
    }

    /// @notice `sweep`, plus listings on FWA's marketplace and Credits CreditStrategy holds. Those are bought first,
    ///         each at exactly its quoted price; one that is gone, repriced or (on FWA) listed this block is skipped
    ///         like a sold Seaport listing.
    /// @param fwaListings FWA listings of Credits, each with the price it was quoted at.
    /// @param strategyListings Credits CreditStrategy holds, each with the price it was quoted at.
    function sweepAll(
        address batch,
        AdvancedOrder[] calldata orders,
        FWAListing[] calldata fwaListings,
        StrategyListing[] calldata strategyListings,
        uint256 minBought,
        uint256 maxFeeBps
    ) external payable nonReentrant returns (uint256[] memory ids) {
        return _sweep(batch, orders, fwaListings, strategyListings, new CCListing[](0), minBought, maxFeeBps);
    }

    /// @notice `sweepAll`, plus Credits the $CC engine's pile holds, each bought at its price then if that is at most
    ///         its `maxPrice` (one sold, out of the pile, with the sale off or priced higher is skipped like a sold
    ///         Seaport listing). Bought after FWA and CreditStrategy, before Seaport.
    /// @param ccListings Credits the $CC engine holds, each with the most to pay for it.
    function sweepEvery(
        address batch,
        AdvancedOrder[] calldata orders,
        FWAListing[] calldata fwaListings,
        StrategyListing[] calldata strategyListings,
        CCListing[] calldata ccListings,
        uint256 minBought,
        uint256 maxFeeBps
    ) external payable nonReentrant returns (uint256[] memory ids) {
        return _sweep(batch, orders, fwaListings, strategyListings, ccListings, minBought, maxFeeBps);
    }

    /// @notice `sweepAll`, without the batch: every Credit bought goes straight to your wallet. Same listings, same
    ///         skipping, same fee; unused ETH comes back.
    /// @dev Delivered with plain transferFrom, like Seaport, FWA and CreditStrategy themselves: a contract wallet
    ///      that can't handle ERC721s would hold them all the same.
    /// @return ids The Credits bought and sent to you, in order.
    function buy(
        AdvancedOrder[] calldata orders,
        FWAListing[] calldata fwaListings,
        StrategyListing[] calldata strategyListings,
        uint256 minBought,
        uint256 maxFeeBps
    ) external payable nonReentrant returns (uint256[] memory ids) {
        return _buyToWallet(orders, fwaListings, strategyListings, new CCListing[](0), minBought, maxFeeBps);
    }

    /// @notice `buy`, plus Credits the $CC engine's pile holds (as in `sweepEvery`): every Credit bought goes straight
    ///         to your wallet.
    /// @return ids The Credits bought and sent to you, in order.
    function buyEvery(
        AdvancedOrder[] calldata orders,
        FWAListing[] calldata fwaListings,
        StrategyListing[] calldata strategyListings,
        CCListing[] calldata ccListings,
        uint256 minBought,
        uint256 maxFeeBps
    ) external payable nonReentrant returns (uint256[] memory ids) {
        return _buyToWallet(orders, fwaListings, strategyListings, ccListings, minBought, maxFeeBps);
    }

    function _buyToWallet(
        AdvancedOrder[] calldata orders,
        FWAListing[] memory fwaListings,
        StrategyListing[] memory strategyListings,
        CCListing[] memory ccListings,
        uint256 minBought,
        uint256 maxFeeBps
    ) internal returns (uint256[] memory ids) {
        uint256 spent;
        uint256 fee;
        uint256 left;
        (ids, spent, fee, left) = _buyAll(orders, fwaListings, strategyListings, ccListings, minBought, maxFeeBps);
        uint256 n = ids.length;
        for (uint256 i; i < n; ++i) {
            credits.transferFrom(address(this), msg.sender, ids[i]);
        }
        emit Bought(msg.sender, n, spent, fee);
        _settle(fee, left);
    }

    function _sweep(
        address batch,
        AdvancedOrder[] calldata orders,
        FWAListing[] memory fwaListings,
        StrategyListing[] memory strategyListings,
        CCListing[] memory ccListings,
        uint256 minBought,
        uint256 maxFeeBps
    ) internal returns (uint256[] memory ids) {
        if (!factory.isBatch(batch)) revert NotBatch();
        uint256 spent;
        uint256 fee;
        uint256 left;
        (ids, spent, fee, left) = _buyAll(orders, fwaListings, strategyListings, ccListings, minBought, maxFeeBps);
        factory.depositFor(batch, ids, msg.sender); // reverts if the batch can't take them all
        emit Swept(msg.sender, batch, ids.length, spent, fee);
        _settle(fee, left);
    }

    /// @dev Buys everything still available into this contract: FWA, CreditStrategy, $CC, then Seaport. Reverts
    ///      unless at least `minBought` (and at least one) came through and what is left covers the fee.
    /// @return ids What was bought, in order.
    /// @return spent What the listings cost.
    /// @return fee What is owed on `spent`.
    /// @return left msg.value minus `spent`, still in this contract.
    function _buyAll(
        AdvancedOrder[] calldata orders,
        FWAListing[] memory fwaListings,
        StrategyListing[] memory strategyListings,
        CCListing[] memory ccListings,
        uint256 minBought,
        uint256 maxFeeBps
    ) internal returns (uint256[] memory ids, uint256 spent, uint256 fee, uint256 left) {
        if (feeBps > maxFeeBps) revert FeeChanged(feeBps);
        uint256 m = fwaListings.length;
        uint256 s = strategyListings.length;
        uint256 c = ccListings.length;
        if (m != 0 && address(fwa) == address(0)) revert NoFWA();
        if (s != 0 && address(strategy) == address(0)) revert NoStrategy();
        if (c != 0 && address(cc) == address(0)) revert NoCC();

        ids = new uint256[](orders.length + m + s + c);
        uint256 bought;
        // What the listings cost: FWA's and the strategy's exact prices (each takes exactly the price or reverts), then Seaport's own
        // record of what it paid out. Never a balance delta, so ETH pushed at this contract by a seller or royalty
        // wallet mid-call cannot distort it.
        for (uint256 i; i < m; ++i) {
            uint256 price = fwaListings[i].price;
            if (price > msg.value - spent) revert Underpaid();
            (bool got, uint256 id) = _buyFWA(fwaListings[i].listingId, price, i);
            if (got) {
                ids[bought++] = id;
                spent += price;
            }
        }
        for (uint256 i; i < s; ++i) {
            StrategyListing memory l = strategyListings[i];
            if (l.price > msg.value - spent) revert Underpaid();
            if (_buyStrategy(l.tokenId, l.price)) {
                ids[bought++] = l.tokenId;
                spent += l.price;
            }
        }
        for (uint256 i; i < c; ++i) {
            CCListing memory l = ccListings[i];
            if (l.maxPrice > msg.value - spent) revert Underpaid();
            (bool got, uint256 paid) = _buyCC(l.tokenId, l.maxPrice);
            if (got) {
                ids[bought++] = l.tokenId;
                spent += paid;
            }
        }
        if (orders.length != 0) {
            uint256 paid;
            (bought, paid) = _buySeaport(orders, msg.value - spent, ids, bought);
            spent += paid;
        }
        left = msg.value - spent; // Seaport returned the rest to this contract

        if (bought < minBought || bought == 0) revert TooFewBought(bought);
        assembly {
            mstore(ids, bought)
        }

        fee = spent * feeBps / 10_000;
        if (left < fee) revert FeeNotCovered(fee);
    }

    /// @dev Pays the fee, then returns the rest of `left` to the buyer.
    function _settle(uint256 fee, uint256 left) internal {
        if (fee > 0 && !_send(feeRecipient, fee)) revert PaymentFailed();
        if (left > fee && !_send(msg.sender, left - fee)) revert PaymentFailed();
    }

    /// @dev One FWA listing, to this contract. Skipped (false) if it is gone, repriced (new id, so the quoted id is
    ///      gone), not yet buyable (listed this block), or the market refuses it (e.g. its withdraw-only mode). A
    ///      live listing of anything but a Credit reverts the whole sweep: the caller asked for something else.
    function _buyFWA(uint256 listingId, uint256 price, uint256 i) internal returns (bool, uint256) {
        IFWAMarket.Listing memory l = fwa.getListing(listingId);
        if (l.seller == address(0)) return (false, 0);
        if (l.collection != address(credits)) revert NotAFWACredit(i);
        if (l.price != price || block.number <= l.createdBlock) return (false, 0);
        try fwa.buy{value: price}(listingId, address(this)) {}
        catch {
            return (false, 0);
        }
        if (credits.ownerOf(l.tokenId) != address(this)) revert NotDelivered(l.tokenId);
        return (true, l.tokenId);
    }

    /// @dev One Credit from CreditStrategy, to this contract. Skipped (false) if it is sold, repriced, or the
    ///      strategy refuses the sale.
    function _buyStrategy(uint256 id, uint256 price) internal returns (bool) {
        if (price == 0 || strategy.nftForSale(id) != price) return false;
        try strategy.sellTargetNFT{value: price}(id) {}
        catch {
            return false;
        }
        if (credits.ownerOf(id) != address(this)) revert NotDelivered(id);
        return true;
    }

    /// @dev One Credit from the $CC engine, to this contract, at its price now if that is at most `maxPrice`; the engine
    ///      refunds the rest of `maxPrice` here within the call. Skipped (false) if it is sold, out of the pile, the
    ///      sale is off or paused, or the price is above `maxPrice`. What it cost is this contract's balance before less
    ///      after: within the call only the engine's refund comes back (its sale cuts go to its artist and operator).
    function _buyCC(uint256 id, uint256 maxPrice) internal returns (bool, uint256 paid) {
        if (maxPrice == 0) return (false, 0);
        // Core's controller now; none (or Core unreadable) skips it like a sold one. A controller that keeps the ETH and
        // not the Credit fails the delivery check below and reverts the whole buy.
        address seller;
        try cc.controller() returns (address c) {
            seller = c;
        } catch {
            return (false, 0);
        }
        if (seller == address(0)) return (false, 0);
        uint256 before = address(this).balance;
        try ICCController(seller).buyCredit{value: maxPrice}(id) {}
        catch {
            return (false, 0);
        }
        uint256 after_ = address(this).balance;
        paid = before > after_ ? before - after_ : 0;
        if (credits.ownerOf(id) != address(this)) revert NotDelivered(id);
        return (true, paid);
    }

    /// @dev Seaport's partial-fill path with `value`; appends what filled to `ids` from `bought` on.
    function _buySeaport(AdvancedOrder[] calldata orders, uint256 value, uint256[] memory ids, uint256 bought)
        internal
        returns (uint256, uint256 spent)
    {
        uint256 n = orders.length;
        // One offer fulfillment per order; one consideration fulfillment per consideration item.
        FulfillmentComponent[][] memory offerF = new FulfillmentComponent[][](n);
        uint256 nc;
        for (uint256 i; i < n; ++i) {
            OfferItem[] calldata offer = orders[i].parameters.offer;
            if (
                offer.length != 1 || offer[0].itemType != ItemType.ERC721 || offer[0].token != address(credits)
            ) revert NotACredit(i);
            offerF[i] = new FulfillmentComponent[](1);
            offerF[i][0] = FulfillmentComponent(i, 0);
            nc += orders[i].parameters.consideration.length;
        }
        FulfillmentComponent[][] memory considF = new FulfillmentComponent[][](nc);
        uint256 k;
        for (uint256 i; i < n; ++i) {
            uint256 m = orders[i].parameters.consideration.length;
            for (uint256 j; j < m; ++j) {
                considF[k] = new FulfillmentComponent[](1);
                considF[k++][0] = FulfillmentComponent(i, j);
            }
        }

        (bool[] memory available, Execution[] memory executions) = seaport.fulfillAvailableAdvancedOrders{
            value: value
        }(orders, new CriteriaResolver[](0), offerF, considF, bytes32(0), address(this), n);

        for (uint256 i; i < executions.length; ++i) {
            if (executions[i].item.itemType == ItemType.NATIVE) spent += executions[i].item.amount;
        }
        for (uint256 i; i < n; ++i) {
            if (available[i]) ids[bought++] = orders[i].parameters.offer[0].identifierOrCriteria;
        }
        return (bought, spent);
    }

    /// @notice What to send for listings totalling `listingsTotal`.
    function quote(uint256 listingsTotal) external view returns (uint256) {
        return listingsTotal + listingsTotal * feeBps / 10_000;
    }

    /// @dev Seaport and the $CC engine return unused ETH here. No ERC721 receiver hook on purpose: every source
    ///      delivers with plain transferFrom, and a safeTransferFrom of a stray NFT here should fail, not strand it.
    receive() external payable {}

    function _send(address to, uint256 amount) internal returns (bool ok) {
        assembly {
            ok := call(gas(), to, amount, 0, 0, 0, 0)
        }
    }
}
