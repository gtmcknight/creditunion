// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {IERC721} from "@openzeppelin/contracts/token/ERC721/IERC721.sol";
import {ICredits} from "./ICredits.sol";

/// @notice The parts of Jack Butcher's Statements contract the adapter uses.
interface IStatements is IERC721 {
    /// @notice Burns 80 Credits the caller owns (the caller must have approved Statements on Credits with
    ///         setApprovalForAll) into a new Statement, cell i = creditIds[i], drawn in `format` (its owner can
    ///         switch that later with setFormat). Mints to the caller with `_mint` (no receiver hook).
    function compose(uint256[80] calldata creditIds, uint8 format) external returns (uint256 statementId);

    /// @notice As compose, minting the new Statement to `to` (the Credits are still the caller's own).
    function compose(uint256[80] calldata creditIds, uint8 format, address to) external returns (uint256 statementId);

    /// @notice Formats are append-only: 0 Issued, 1 Consolidated, 2 Assessed, 3 Reconciled, 4 Accrued,
    ///         5 Amortized, 6 Liquidated, 7 Recorded, then whatever the owner adds until it seals the list.
    function formatCount() external view returns (uint256);

    function formatName(uint8 format) external view returns (string memory);

    function formatOf(uint256 statementId) external view returns (uint8);

    function composedFrom(uint256 statementId) external view returns (uint32[80] memory);

    function supply() external view returns (uint256);

    /// @notice The Credits contract it burns from.
    function credits() external view returns (ICredits);
}
