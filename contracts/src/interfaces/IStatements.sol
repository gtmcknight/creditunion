// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {IERC721} from "@openzeppelin/contracts/token/ERC721/IERC721.sol";

/// GUESS, NOT JACK'S INTERFACE. His Statement contract isn't published yet. This is the smallest shape the adapter
/// needs, so the adapter and its tests can be written now. When his contract ships, its real function replaces
/// `compose` here and in StatementAdapter._compose (see ADAPTER.md).
/// @notice Burns 80 Credits the caller holds and mints the caller one Statement drawn in `direction`
///         (0 Issued, 1 Consolidated, 2 Balance, 3 Reconciled).
interface IStatements is IERC721 {
    function compose(uint256[] calldata ids, uint8 direction) external returns (uint256 statementId);
}
