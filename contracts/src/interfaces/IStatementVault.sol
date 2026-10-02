// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

/// @notice What a token union expects of the contract that turns a Statement into tokens. That contract isn't built
///         yet; this is the shape TokenAdapter is written against, and the smallest one it needs.
interface IStatementVault {
    /// @notice The ERC-20 a Statement converts into.
    function token() external view returns (IERC20);

    /// @notice Takes `statementId` from the caller (approved on the Statements contract first) and pays the caller
    ///         its tokens in the same call. The adapter counts what actually arrived, not the return value.
    function deposit(uint256 statementId) external returns (uint256 amount);
}
