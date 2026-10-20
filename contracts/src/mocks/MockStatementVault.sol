// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {IERC721} from "@openzeppelin/contracts/token/ERC721/IERC721.sol";
import {IStatementVault} from "../interfaces/IStatementVault.sol";

/// @notice What the test token calls on a hooked holder when it receives (see MockStatementVault.hook).
interface ITokenReceiver {
    function onTokens(uint256 amount) external;
}

/// NOT A REAL VAULT. A test stand-in for the converter, in the same shape: it is the token, a Statement's owner
/// approves it for that Statement and calls `withdraw` for what `quote` says (a set amount here), and it can hold every
/// transfer but its own payouts until a block, as a launch lock would. Like the real one, it takes Statements only once
/// it's `ready` and its launch retirement is done (`totalRetired` reaches `launchRetirement`); both hold from the start
/// unless a test says otherwise.
contract MockStatementVault is IStatementVault, ERC20 {
    IERC721 public immutable statements;
    uint256 public perStatement;
    /// @notice Before this block nothing moves but this contract's own payouts (0: never locked).
    uint64 public transfersOpenBlock;
    mapping(uint256 statementId => bool) public withdrawn;
    bool public ready = true;
    uint256 public launchRetirement;
    uint256 public totalRetired;

    error AlreadyWithdrawn();
    error RendererNotRegistered();
    error LaunchSupplyNotFinalized();
    error NotStatementOwner();
    error ScoreChanged(uint256 actual);
    error TransfersLocked(uint64 opensAt);

    constructor(IERC721 statements_, uint256 perStatement_) ERC20("Statement Token", "STMT") {
        statements = statements_;
        perStatement = perStatement_;
    }

    function quote(uint256 statementId) public view returns (uint256) {
        if (withdrawn[statementId]) revert AlreadyWithdrawn();
        return perStatement;
    }

    function withdraw(uint256 statementId, uint256 expectedAmount) external returns (uint256 amount) {
        if (!ready) revert RendererNotRegistered();
        if (totalRetired < launchRetirement) revert LaunchSupplyNotFinalized();
        if (statements.ownerOf(statementId) != msg.sender) revert NotStatementOwner();
        amount = quote(statementId);
        if (amount != expectedAmount) revert ScoreChanged(amount);
        withdrawn[statementId] = true;
        statements.transferFrom(msg.sender, address(this), statementId);
        _mint(msg.sender, amount);
    }

    /// @notice For tests: change what the next Statement pays.
    function setPerStatement(uint256 v) external {
        perStatement = v;
    }

    /// @notice For tests: the launch gate (renderer registered; how much of the launch retirement is done).
    function setGate(bool ready_, uint256 retirement, uint256 retired) external {
        (ready, launchRetirement, totalRetired) = (ready_, retirement, retired);
    }

    /// @notice For tests: lock transfers until block `b`, as a launch would.
    function setTransfersOpenBlock(uint64 b) external {
        transfersOpenBlock = b;
    }

    /// @notice For tests: a holder that refuses incoming tokens.
    mapping(address => bool) public blocked;

    function block_(address who, bool on) external {
        blocked[who] = on;
    }

    /// @notice For tests: the one holder the token calls on every receipt, as a token that mints the receiver
    ///         something with safeMint would. One slot, so every other transfer costs what it did.
    address public hooked;

    function hook(address who) external {
        hooked = who;
    }

    function _update(address from, address to, uint256 value) internal override {
        require(!blocked[to], "blocked");
        if (from != address(0) && block.number < transfersOpenBlock) revert TransfersLocked(transfersOpenBlock);
        super._update(from, to, value);
        if (to == hooked && to != address(0)) ITokenReceiver(to).onTokens(value);
    }
}
