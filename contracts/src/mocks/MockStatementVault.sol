// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC721} from "@openzeppelin/contracts/token/ERC721/IERC721.sol";
import {IStatementVault} from "../interfaces/IStatementVault.sol";

/// NOT A REAL VAULT. A test stand-in for the Statement-to-token contract that isn't built yet: it keeps each
/// Statement and mints a fixed amount of its own test token for it.
contract MockStatementVault is IStatementVault, ERC20 {
    IERC721 public immutable statements;
    uint256 public perStatement;

    constructor(IERC721 statements_, uint256 perStatement_) ERC20("Statement Token", "STMT") {
        statements = statements_;
        perStatement = perStatement_;
    }

    function token() external view returns (IERC20) {
        return IERC20(address(this));
    }

    function deposit(uint256 statementId) external returns (uint256) {
        statements.transferFrom(msg.sender, address(this), statementId);
        _mint(msg.sender, perStatement);
        return perStatement;
    }

    /// @notice For tests: change what the next Statement pays.
    function setPerStatement(uint256 v) external {
        perStatement = v;
    }

    /// @notice For tests: a holder that refuses incoming tokens.
    mapping(address => bool) public blocked;

    function block_(address who, bool on) external {
        blocked[who] = on;
    }

    function _update(address from, address to, uint256 value) internal override {
        require(!blocked[to], "blocked");
        super._update(from, to, value);
    }
}
