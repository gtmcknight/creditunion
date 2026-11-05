// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

/// @notice A Bars edition as far as BarRouter uses it: Bar #n holds n $BALANCE. Minting is open for one fixed window;
///         melting opens when it closes and burns the Bar, handing its owner everything in the Bar's vault: the deposit plus
///         anything others sent to it.
interface IBars {
    /// @notice Mint the next `quantity` Bars to `to`, taking what they hold from the caller (who has approved the
    ///         edition). Reverts unless the first is `expectedFirst` and they take at most `maxTotal`.
    function mint(address to, uint256 quantity, uint256 expectedFirst, uint256 maxTotal) external returns (uint256 first);

    /// @notice What the next `quantity` Bars take in all.
    function priceOf(uint256 quantity) external view returns (uint256);

    function minted() external view returns (uint256);

    /// @notice Whether melting is open: from the close of the mint window, forever.
    function isMeltOpen() external view returns (bool);

    /// @notice Burn your Bar `id` and receive everything in its vault.
    function melt(uint256 id) external;

    function ownerOf(uint256 id) external view returns (address);
}
