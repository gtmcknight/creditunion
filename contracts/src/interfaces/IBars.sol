// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

/// @notice A Bars edition as far as BarRouter uses it: each Bar holds the $BALANCE deposited at its mint, and melting
///         it burns the Bar and returns that $BALANCE to its owner.
interface IBars {
    /// @notice Mint one Bar to `to`, taking `amount` $BALANCE from the caller (who has approved the edition). An edition
    ///         priced by count reads the same word as how many Bars to mint, each holding its own fixed amount, and
    ///         returns the first id.
    function mint(address to, uint256 amount) external returns (uint256 id);

    /// @notice An edition priced by count: what the next `quantity` Bars take in all.
    function priceOf(uint256 quantity) external view returns (uint256);

    /// @notice Burn your Bar `id` and receive the $BALANCE inside it.
    function melt(uint256 id) external;

    function ownerOf(uint256 id) external view returns (address);
}
