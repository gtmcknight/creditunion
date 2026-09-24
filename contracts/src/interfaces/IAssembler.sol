// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

/// @notice Turns 80 Credits into one Statement.
/// @dev Run by a Batch through DELEGATECALL, so it acts as the Batch: the Batch owns the Credits and
///      receives the Statement. It must be stateless (no storage writes). The Batch checks afterwards
///      that the 80 Credits are gone and that it owns `statementId` on `statement`.
///      The mainnet adapter is written once Jack's Statement contract is published.
interface IAssembler {
    function assemble(address credits, uint256[] calldata ids)
        external
        returns (address statement, uint256 statementId);
}
