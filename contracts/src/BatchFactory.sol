// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Clones} from "@openzeppelin/contracts/proxy/Clones.sol";
import {Batch} from "./Batch.sol";
import {ICredits} from "./interfaces/ICredits.sol";
import {IAssembler} from "./interfaces/IAssembler.sol";

/// @title BatchFactory
/// @notice Opens batches and moves Credits into them. Approve this contract once
///         (`Credits.setApprovalForAll(factory, true)`); it only ever moves Credits from
///         the caller into a batch it created. Everything is fixed at deploy.
contract BatchFactory {
    uint256 public constant MIN_DURATION = 3 days;
    uint256 public constant MAX_DURATION = 90 days;
    uint256 public constant MAX_PROTOCOL_FEE_BPS = 500; // hard ceiling for any deploy: 5%

    ICredits public immutable credits;
    IAssembler public immutable assembler;
    address public immutable feeRecipient;
    /// @notice Protocol share of each Statement sale, in basis points. Fixed at deploy.
    uint256 public immutable protocolFeeBps;
    /// @notice Credits the creator must put in to open a batch.
    uint256 public immutable minOpen;
    address public immutable implementation;

    address[] internal _batches;
    mapping(address => bool) public isBatch;

    event BatchCreated(address indexed batch, address indexed creator, string name, uint256 index);

    error TooFewToOpen(uint256 min);
    error BadDuration();
    error NotBatch();
    error NoDepositor();
    error ProtocolFeeTooHigh();
    error NoFeeRecipient();

    constructor(
        ICredits credits_,
        IAssembler assembler_,
        address feeRecipient_,
        uint256 protocolFeeBps_,
        uint256 minOpen_
    ) {
        if (protocolFeeBps_ > MAX_PROTOCOL_FEE_BPS) revert ProtocolFeeTooHigh();
        if (feeRecipient_ == address(0)) revert NoFeeRecipient();
        credits = credits_;
        protocolFeeBps = protocolFeeBps_;
        assembler = assembler_;
        feeRecipient = feeRecipient_;
        minOpen = minOpen_;
        implementation = address(new Batch());
    }

    /// @notice Open a batch with at least `minOpen` of your Credits.
    /// @param filter keccak256 of each required trait value, or 0 for any.
    /// @param reserve Opening bid floor, dropped if no bid within 7 days of assembly. 0 for none.
    /// @param creatorFeeBps Your cut of the sale, 0–1000 (10%). Fixed forever; depositors see it before joining.
    /// @param duration Seconds until the deadline; a batch that fills always gets 7 more days to assemble.
    function create(
        string calldata name,
        Batch.Filter calldata filter,
        uint256 reserve,
        uint256 creatorFeeBps,
        uint256 duration,
        uint256[] calldata ids
    ) external returns (address batch) {
        if (ids.length < minOpen) revert TooFewToOpen(minOpen);
        if (duration < MIN_DURATION || duration > MAX_DURATION) revert BadDuration();

        batch = Clones.clone(implementation);
        isBatch[batch] = true;
        _batches.push(batch);
        Batch(batch).initialize(msg.sender, name, filter, reserve, creatorFeeBps, uint64(block.timestamp + duration));
        emit BatchCreated(batch, msg.sender, name, _batches.length - 1);

        _move(batch, ids, msg.sender);
    }

    /// @notice Add your Credits to a batch. Up to ~40 per call fits comfortably in a block.
    function deposit(address batch, uint256[] calldata ids) external {
        if (!isBatch[batch]) revert NotBatch();
        _move(batch, ids, msg.sender);
    }

    /// @notice Add your Credits to a batch on someone else's behalf: `to` becomes the depositor
    ///         (withdraw rights and payout). Used by the Sweeper to deposit Credits it just bought.
    function depositFor(address batch, uint256[] calldata ids, address to) external {
        if (!isBatch[batch]) revert NotBatch();
        // Contracts that can never withdraw or receive ETH would strand the share.
        if (to == address(0) || to == batch || to == address(this) || isBatch[to]) revert NoDepositor();
        _move(batch, ids, to);
    }

    /// @dev Credits always come from the caller; `to` is only who the batch records.
    function _move(address batch, uint256[] calldata ids, address to) internal {
        for (uint256 i; i < ids.length; ++i) {
            credits.transferFrom(msg.sender, batch, ids[i]);
        }
        Batch(batch).depositFrom(to, ids);
    }

    // ---------------------------------------------------------------- views

    function batchCount() external view returns (uint256) {
        return _batches.length;
    }

    /// @notice Batches newest first.
    function batches(uint256 offset, uint256 limit) external view returns (address[] memory out) {
        uint256 n = _batches.length;
        if (offset >= n) return out;
        uint256 end = offset + limit > n ? n : offset + limit;
        out = new address[](end - offset);
        for (uint256 i; i < out.length; ++i) out[i] = _batches[n - 1 - offset - i];
    }
}
