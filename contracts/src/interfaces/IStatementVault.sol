// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

/// @notice The contract a token union's Statement converts in. It is the ERC-20 itself: a Statement's owner approves
///         it for that one Statement and calls `withdraw`, and receives `quote` of the token in the same call. Its
///         tokens may be unable to move for a while after launch (only its own payouts can), so a union's payouts
///         can fail until then and wait for a later `distribute` or `claim`.
interface IStatementVault {
    /// @notice What surrendering `statementId` pays now, in the token's base units. Reverts once it is surrendered.
    function quote(uint256 statementId) external view returns (uint256 amount);

    /// @notice Surrenders `statementId`, which the caller owns and has approved this contract for, and pays the caller
    ///         its tokens in the same call. Reverts unless the payout equals `expectedAmount`.
    function withdraw(uint256 statementId, uint256 expectedAmount) external returns (uint256 amount);
}
