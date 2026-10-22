// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

/// @notice The $CC engine's Core (cc.artcoins.art): it holds the pile and names the controller that sells from it. The
///         controller has been swapped before (ControllerV1 0x222C… to ControllerV2 0xCD64… by 2026-10-22), so a buyer
///         asks Core for it at the moment of each buy instead of keeping one.
interface ICCCore {
    function controller() external view returns (address);
}

/// @notice The $CC engine's sale (cc.artcoins.art, ControllerV1 and V2 alike): it sells the Credits its pile holds, each at a price
///         that moves block to block. `buyCredit` charges the price at that moment, sends the Credit to the caller
///         with plain transferFrom, and refunds the rest of what was sent. It reverts while the sale is off or paused,
///         for a Credit not in the pile, or when what was sent is under the price.
interface ICCController {
    function creditSaleOn() external view returns (bool);
    function creditPrice(uint256 id) external view returns (uint256);
    function buyCredit(uint256 id) external payable;
}
