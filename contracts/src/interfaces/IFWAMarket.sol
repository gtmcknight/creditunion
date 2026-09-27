// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

/// @notice The parts of FWA's marketplace (FWAMarketplace, 0x2b01…bf25 on mainnet) the Sweeper uses.
///         Custodial, fixed-price, ETH-only ERC721 listings. A listing's id and price never change together:
///         a reprice deletes the old id and issues a new one.
interface IFWAMarket {
    struct Listing {
        address seller;
        uint64 createdBlock;
        address collection;
        uint96 price;
        uint256 tokenId;
        address royaltyRecipient;
        uint96 royaltyAmount;
    }

    /// @notice msg.value must equal the listing price exactly. Delivers with plain transferFrom to `recipient`.
    ///         Buyable only in a block after the one it was listed in. Fees come out of the seller's side.
    function buy(uint256 listingId, address recipient) external payable;

    /// @notice An empty struct (seller zero) once the listing is bought, cancelled or repriced.
    function getListing(uint256 listingId) external view returns (Listing memory);
}
