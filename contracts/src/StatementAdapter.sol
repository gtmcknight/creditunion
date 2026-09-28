// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {IERC721Receiver} from "@openzeppelin/contracts/token/ERC721/IERC721Receiver.sol";
import {Batch} from "./Batch.sol";
import {IAssembler} from "./interfaces/IAssembler.sol";
import {ICredits} from "./interfaces/ICredits.sol";
import {IStatements} from "./interfaces/IStatements.sol";

/// @notice The factory's register of its Credit Unions.
interface IUnions {
    function isBatch(address) external view returns (bool);
}

// True only once `_compose` is written against Jack's published contract and has passed the mainnet fork test.
// The deploy script refuses mainnet while it's false.
bool constant ADAPTER_READY = false;

/// DRAFT, NOT LIVE. Written before Jack's Statement contract is published. Everything here is final except
/// `_compose`, the one call into his contract, which follows our guess of it (IStatements). It gets finished
/// against his real contract, tested on a mainnet fork, reviewed, and only then proposed to the factory
/// (ADAPTER.md, RUNBOOK.md). Until an adapter is switched on, no Credit Union can lock or burn.
/// @title StatementAdapter
/// @notice Turns a full Credit Union's 80 Credits into one Statement, drawn in the direction its creator chose.
///         During its burn hour the union calls `assemble` with the 80 in their final order, having approved this
///         contract as an operator for that one call. The adapter takes the 80 in (a union can approve only the
///         adapter, not Jack's contract), has Jack's contract burn them and mint the Statement, and hands the
///         Statement to the union. The union then checks that all 80 are gone and that it owns the Statement.
///         No owner, no admin, no upgrades.
contract StatementAdapter is IAssembler, IERC721Receiver {
    /// @notice ADAPTER_READY, readable on chain.
    bool public constant READY = ADAPTER_READY;

    /// @notice How the Statement lays out its 80 Credits (Jack's four directions).
    enum Direction {
        Issued,
        Consolidated,
        Balance,
        Reconciled
    }

    ICredits public immutable credits;
    IStatements public immutable statements;
    IUnions public immutable factory;

    /// @notice Each union's direction: Issued until its creator chooses another.
    mapping(address union => Direction) public directionOf;

    event DirectionChosen(address indexed union, Direction direction);

    error NotAUnion();
    error NotTheCreator();
    error DirectionFixed(Batch.Phase phase);
    error NotAStatement();

    constructor(ICredits credits_, IStatements statements_, IUnions factory_) {
        credits = credits_;
        statements = statements_;
        factory = factory_;
        credits_.setApprovalForAll(address(statements_), true); // Jack's contract burns the Credits we hold
    }

    function statement() external view returns (address) {
        return address(statements);
    }

    /// @notice The union's creator picks its direction while every member can still leave: while it fills, while
    ///         it waits for burning to open, or after a burn hour lapses unused. From the countdown on it's fixed,
    ///         so nobody gets locked into a direction they didn't see.
    function chooseDirection(address union, Direction d) external {
        if (!factory.isBatch(union)) revert NotAUnion();
        if (msg.sender != Batch(union).creator()) revert NotTheCreator();
        Batch.Phase p = Batch(union).phase();
        if (p != Batch.Phase.Open && p != Batch.Phase.Waiting && p != Batch.Phase.Expired) revert DirectionFixed(p);
        directionOf[union] = d;
        emit DirectionChosen(union, d);
    }

    /// @inheritdoc IAssembler
    /// @dev Only the factory's unions. Takes the 80 in the order given (Batch.burnOrder()) and never reorders.
    function assemble(uint256[] calldata ids, uint8) external returns (uint256 statementId) {
        if (!factory.isBatch(msg.sender)) revert NotAUnion();
        for (uint256 i; i < ids.length; ++i) credits.transferFrom(msg.sender, address(this), ids[i]);
        statementId = _compose(ids, directionOf[msg.sender]);
        statements.transferFrom(address(this), msg.sender, statementId);
    }

    /// @dev PLACEHOLDER. The one call into Jack's contract, written against our guess of it (IStatements). When his
    ///      contract is published, this is what changes: its function, how it takes the direction, and anything
    ///      else it needs (a payment, an approval). Nothing else in this contract should.
    function _compose(uint256[] calldata ids, Direction d) internal returns (uint256) {
        return statements.compose(ids, uint8(d));
    }

    /// @dev Accepts a Statement minted to it with safeMint and nothing else, so nothing gets stuck here.
    function onERC721Received(address, address, uint256, bytes calldata) external view returns (bytes4) {
        if (msg.sender != address(statements)) revert NotAStatement();
        return this.onERC721Received.selector;
    }
}
