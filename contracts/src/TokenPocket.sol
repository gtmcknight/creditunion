// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC721Receiver} from "@openzeppelin/contracts/token/ERC721/IERC721Receiver.sol";
import {IStatements} from "./interfaces/IStatements.sol";
import {IStatementVault} from "./interfaces/IStatementVault.sol";

/// @title TokenPocket
/// @notice One per converted token union, cloned by TokenAdapter at the burn: the union's Statement is minted here,
///         converts here, and its tokens wait here until each member is paid. The token can carry its Statement's
///         colors (a palette per holding wallet that mixes as tokens move), so every union gets its own wallet: no
///         other union's tokens ever pass through this one. Tokens sent here before the conversion are passed on first
///         (`convert`), so they can't tint it either.
///         Only the adapter can move anything. No owner, no admin, no upgrades.
contract TokenPocket is IERC721Receiver {
    address public immutable adapter;
    IStatements public immutable statements;
    IStatementVault public immutable vault;
    IERC20 public immutable token;

    error NotAdapter();

    constructor(IStatements statements_, IStatementVault vault_, IERC20 token_) {
        adapter = msg.sender;
        statements = statements_;
        vault = vault_;
        token = token_;
    }

    /// @notice Surrenders this pocket's Statement to the vault, for exactly what it quotes, and returns the tokens that
    ///         arrived for it. Tokens someone sent here first (to tint the union's colors with their own) go to `stray`
    ///         before the vault pays, so the pocket is empty when its own tokens arrive and takes their colors whole.
    function convert(uint256 statementId, address stray) external returns (uint256 amount) {
        if (msg.sender != adapter) revert NotAdapter();
        uint256 held = token.balanceOf(address(this));
        if (held != 0) {
            // Best effort: a token that refuses leaves them here, and the union's colors carry theirs.
            (bool ok,) = address(token).call(abi.encodeCall(IERC20.transfer, (stray, held)));
            ok;
        }
        uint256 before = token.balanceOf(address(this));
        statements.approve(address(vault), statementId);
        vault.withdraw(statementId, vault.quote(statementId));
        amount = token.balanceOf(address(this)) - before;
    }

    /// @notice Sends `amount` of the token to `to`. False when the token refuses or answers oddly: the adapter then
    ///         leaves it for a later claim.
    function pay(address to, uint256 amount) external returns (bool ok) {
        if (msg.sender != adapter) revert NotAdapter();
        bytes memory ret;
        (ok, ret) = address(token).call(abi.encodeCall(IERC20.transfer, (to, amount)));
        if (ok && ret.length != 0) ok = ret.length >= 32 && uint256(bytes32(ret)) == 1;
    }

    /// @dev The Statement arrives by safe mint. Anything else that arrives this way is let in too: refusing an NFT
    ///      minted into a holder's wallet (the token's artwork, say) must never block a conversion.
    function onERC721Received(address, address, uint256, bytes calldata) external pure returns (bytes4) {
        return this.onERC721Received.selector;
    }
}
