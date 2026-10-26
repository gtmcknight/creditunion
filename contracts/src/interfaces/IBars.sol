// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

/// @notice A Bars edition as far as BarRouter uses it: each Bar holds the $BALANCE deposited at its mint, and melting
///         it burns the Bar and returns that $BALANCE to its owner.
interface IBars {
    /// @notice Mint one Bar to `to`, taking `amount` $BALANCE from the caller (who has approved the edition).
    function mint(address to, uint256 amount) external returns (uint256 id);

    /// @notice Burn your Bar `id` and receive the $BALANCE inside it.
    function melt(uint256 id) external;

    function ownerOf(uint256 id) external view returns (address);
}
