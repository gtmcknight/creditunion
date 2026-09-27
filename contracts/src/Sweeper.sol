// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {ReentrancyGuardTransient} from "@openzeppelin/contracts/utils/ReentrancyGuardTransient.sol";
import {BatchFactory} from "./BatchFactory.sol";
import {ICredits} from "./interfaces/ICredits.sol";
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
/// @notice One transaction: buy listed Credits on Seaport (OpenSea's exchange) and on FWA's marketplace, then
///         deposit them into a batch in the buyer's name. Pay the listings plus the fee; unused ETH comes back.
///         Nothing is held between transactions. No owner, no admin.
contract Sweeper is ReentrancyGuardTransient {
    uint256 public constant MAX_FEE_BPS = 500;

    /// @notice Fee on what the listings cost, in basis points. 
    /// @notice Fee on each buy-in, quoted before anyone signs. The fee recipient may change it within MAX_FEE_BPS.
    uint256 public feeBps;

    ISeaport public immutable seaport;
    /// @notice FWA's marketplace (FWAMarketplace). Zero where it isn't deployed; FWA buys then revert.
    IFWAMarket public immutable fwa;
    BatchFactory public immutable factory;
    ICredits public immutable credits;
    address public immutable feeRecipient;

    event Swept(address indexed buyer, address indexed batch, uint256 bought, uint256 spent, uint256 fee);

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

    /// @notice One FWA listing to buy, at the price it was quoted. A listing whose price changed has a new id,
    ///         so the old one reads as gone and is skipped.
    struct FWAListing {
        uint256 listingId;
        uint256 price;
    }

    event FeeSet(uint256 feeBps);

    constructor(ISeaport seaport_, BatchFactory factory_, uint256 feeBps_, IFWAMarket fwa_) {
        if (feeBps_ > MAX_FEE_BPS) revert FeeTooHigh();
        feeBps = feeBps_;
        emit FeeSet(feeBps_);
        seaport = seaport_;
        fwa = fwa_;
        factory = factory_;
        credits = factory_.credits();
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
        return _sweep(batch, orders, new FWAListing[](0), minBought, maxFeeBps);
    }

    /// @notice `sweep`, plus listings on FWA's marketplace. FWA listings are bought first, each at exactly its
    ///         quoted price; one that is gone, repriced or listed this block is skipped like a sold Seaport listing.
    /// @param fwaListings FWA listings of Credits, each with the price it was quoted at.
    function sweepWithFWA(
        address batch,
        AdvancedOrder[] calldata orders,
        FWAListing[] calldata fwaListings,
        uint256 minBought,
        uint256 maxFeeBps
    ) external payable nonReentrant returns (uint256[] memory ids) {
        return _sweep(batch, orders, fwaListings, minBought, maxFeeBps);
    }

    function _sweep(
        address batch,
        AdvancedOrder[] calldata orders,
        FWAListing[] memory fwaListings,
        uint256 minBought,
        uint256 maxFeeBps
    ) internal returns (uint256[] memory ids) {
        if (!factory.isBatch(batch)) revert NotBatch();
        if (feeBps > maxFeeBps) revert FeeChanged(feeBps);
        uint256 m = fwaListings.length;
        if (m != 0 && address(fwa) == address(0)) revert NoFWA();

        ids = new uint256[](orders.length + m);
        uint256 bought;
        // What the listings cost: FWA's exact prices (it takes exactly the price or reverts), then Seaport's own
        // record of what it paid out. Never a balance delta, so ETH pushed at this contract by a seller or royalty
        // wallet mid-call cannot distort it.
        uint256 spent;
        for (uint256 i; i < m; ++i) {
            uint256 price = fwaListings[i].price;
            if (price > msg.value - spent) revert Underpaid();
            (bool got, uint256 id) = _buyFWA(fwaListings[i].listingId, price, i);
            if (got) {
                ids[bought++] = id;
                spent += price;
            }
        }
        if (orders.length != 0) {
            uint256 paid;
            (bought, paid) = _buySeaport(orders, msg.value - spent, ids, bought);
            spent += paid;
        }
        uint256 left = msg.value - spent; // Seaport returned the rest to this contract

        if (bought < minBought || bought == 0) revert TooFewBought(bought);
        assembly {
            mstore(ids, bought)
        }

        uint256 fee = spent * feeBps / 10_000;
        if (left < fee) revert FeeNotCovered(fee);

        factory.depositFor(batch, ids, msg.sender); // reverts if the batch can't take them all
        emit Swept(msg.sender, batch, bought, spent, fee);

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

    /// @dev Seaport returns unused ETH here. No ERC721 receiver hook on purpose: Seaport delivers with
    ///      plain transferFrom, and a safeTransferFrom of a stray NFT here should fail, not strand it.
    receive() external payable {}

    function _send(address to, uint256 amount) internal returns (bool ok) {
        assembly {
            ok := call(gas(), to, amount, 0, 0, 0, 0)
        }
    }
}
