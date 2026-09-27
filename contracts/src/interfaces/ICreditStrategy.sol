// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

/// @notice The parts of CreditStrategy (nftstrategy.fun, 0x8e60…53d6 on mainnet) the Sweeper uses. The strategy
///         buys floor Credits and holds them for sale at a markup, straight from its own contract (not Seaport).
interface ICreditStrategy {
    /// @notice The NFT collection the strategy trades.
    function collection() external view returns (address);

    /// @notice The price of a Credit the strategy holds for sale; zero once it is sold (or never held).
    function nftForSale(uint256 tokenId) external view returns (uint256);

    /// @notice Buy a held Credit. msg.value must equal nftForSale exactly (more or less reverts). Delivers to
    ///         msg.sender with plain transferFrom.
    function sellTargetNFT(uint256 tokenId) external payable;
}
