// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

/// @notice Turns 80 Credits into one Statement on behalf of a Batch.
/// @dev Called (not delegatecalled) by a Batch that holds `ids` and has approved this contract as an
///      operator for its Credits for the duration of the call. The adapter pulls or burns the Credits as
///      the Statement contract requires and must finish with the Batch owning the returned Statement.
///      The Batch then checks that none of the 80 Credits still exist and that it owns `statement()`/id.
///      The mainnet adapter is written once Jack's Statement contract is published.
interface IAssembler {
    /// @notice The Statement contract this adapter mints from.
    function statement() external view returns (address);

    /// @param ids The 80 Credits in their final order. The Batch computes it (Batch.burnOrder()) for every
    ///        arrangement; the adapter must burn them in exactly this order and never reorder.
    /// @param arrangement Informational only. Batches always pass 0 (Batch.Arrangement.Deposit: pass through).
    /// @return statementId The Statement now owned by the calling Batch.
    function assemble(uint256[] calldata ids, uint8 arrangement) external returns (uint256 statementId);
}
