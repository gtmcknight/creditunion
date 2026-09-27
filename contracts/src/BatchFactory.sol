// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Clones} from "@openzeppelin/contracts/proxy/Clones.sol";
import {Batch} from "./Batch.sol";
import {ICredits} from "./interfaces/ICredits.sol";
import {IRatings} from "./Batch.sol";
import {IAssembler} from "./interfaces/IAssembler.sol";

/// @title BatchFactory
/// @notice Opens batches and moves Credits into them. Approve this contract once
///         (`Credits.setApprovalForAll(factory, true)`); it only ever moves Credits from
///         the caller into a batch it created. Everything is fixed at deploy, with one exception:
///
///         The assembler (the adapter for the Statement contract) may not exist yet when pooling opens.
///         The factory can deploy without one; batches then fill but never lock or burn, so every depositor
///         can always leave. The setter proposes an assembler once it exists; after ASSEMBLER_DELAY anyone
///         activates it, permanently. The delay is the notice: nothing locks until activation, and a full
///         batch then counts down Batch.LOCK_DELAY before it locks. The setter can replace a pending proposal
///         (restarting the delay) but has no other power, and none at all once an assembler is active.
///
///         The score table can move to a later rating methodology the same way: the fee recipient proposes a table
///         covering the same edition, anyone activates it after RATINGS_DELAY, and only batches opened afterwards
///         use it. Each batch keeps the table it opened with, so an open batch's rules never change.
contract BatchFactory {
    uint256 public constant MIN_DURATION = 3 days;
    uint256 public constant MAX_DURATION = 90 days;
    uint256 public constant MAX_PROTOCOL_FEE_BPS = 500; // hard ceiling, deploy or later: 5%
    uint256 public constant MAX_CREATOR_FEE_BPS = 1000; // 10%
    uint256 public constant ASSEMBLER_DELAY = 30 minutes; // notice before a proposed assembler can go live
    uint256 public constant RATINGS_DELAY = 30 minutes; // notice before a proposed score table can go live

    ICredits public immutable credits;
    address public immutable feeRecipient;
    /// @notice The one address that may propose an assembler. Irrelevant once one is active.
    address public immutable assemblerSetter;

    IAssembler public assembler;
    uint64 public assemblerActiveAt;
    IAssembler public pendingAssembler;
    uint64 public pendingUntil;
    /// @notice Protocol share of each Statement sale, in basis points. The fee recipient may change it within
    ///         MAX_PROTOCOL_FEE_BPS, but a batch fixes its split the moment it opens, so a change only ever
    ///         affects batches opened afterwards.
    uint256 public protocolFeeBps;
    /// @notice Creator share of each Statement sale, in basis points, the same for every batch opened while it
    ///         is set. Same rules as the protocol fee; capped at MAX_CREATOR_FEE_BPS.
    uint256 public creatorFeeBps;
    /// @notice The score table new batches open with, or zero if rating rules are unavailable on this deployment.
    IRatings public ratings;
    IRatings public pendingRatings;
    uint64 public pendingRatingsUntil;
    /// @dev Every table ever active, oldest first, so anyone can find each methodology's scores onchain.
    IRatings[] internal _ratingsHistory;
    /// @notice Credits the creator must put in to open a batch.
    uint256 public immutable minOpen;
    address public immutable implementation;

    address[] internal _batches;
    mapping(address => bool) public isBatch;

    event BatchCreated(address indexed batch, address indexed creator, string name, uint256 index);
    event AssemblerProposed(address indexed assembler, uint64 activatableAt);
    event AssemblerActivated(address indexed assembler);
    event FeesSet(uint256 protocolFeeBps, uint256 creatorFeeBps);
    event RatingsProposed(address indexed ratings, uint64 activatableAt);
    event RatingsActivated(address indexed ratings);

    error TooFewToOpen(uint256 min);
    error BadDuration();
    error NotBatch();
    error NoDepositor();
    error ProtocolFeeTooHigh();
    error CreatorFeeTooHigh();
    error NotFeeRecipient();
    error FeesChanged(uint256 protocolFeeBps, uint256 creatorFeeBps);
    error NoFeeRecipient();
    error NotSetter();
    error AssemblerFixed();
    error NothingPending();
    error TooEarly();
    error NoAssembler();
    error BadRatings();
    error RatingsChanged(address ratings);

    /// @param assembler_ The adapter, or zero to open pooling before it exists (then `setter_` proposes it).
    constructor(
        ICredits credits_,
        IRatings ratings_,
        IAssembler assembler_,
        address setter_,
        address feeRecipient_,
        uint256 protocolFeeBps_,
        uint256 creatorFeeBps_,
        uint256 minOpen_
    ) {
        if (address(ratings_) != address(0)) {
            ratings = ratings_;
            _ratingsHistory.push(ratings_);
            emit RatingsActivated(address(ratings_));
        }
        if (feeRecipient_ == address(0)) revert NoFeeRecipient();
        if (address(assembler_) == address(0) && setter_ == address(0)) revert NoAssembler();
        credits = credits_;
        _setFees(protocolFeeBps_, creatorFeeBps_);
        feeRecipient = feeRecipient_;
        minOpen = minOpen_;
        assemblerSetter = setter_;
        if (address(assembler_) != address(0)) {
            assembler = assembler_;
            assemblerActiveAt = uint64(block.timestamp);
        }
        implementation = address(new Batch());
    }

    // ---------------------------------------------------------------- fees

    /// @notice Change the fees for batches opened from now on. Open, full and auctioning batches keep the
    ///         split they opened with. Only the fee recipient; never above the caps.
    function setFees(uint256 protocolFeeBps_, uint256 creatorFeeBps_) external {
        if (msg.sender != feeRecipient) revert NotFeeRecipient();
        _setFees(protocolFeeBps_, creatorFeeBps_);
    }

    function _setFees(uint256 protocolFeeBps_, uint256 creatorFeeBps_) internal {
        if (protocolFeeBps_ > MAX_PROTOCOL_FEE_BPS) revert ProtocolFeeTooHigh();
        if (creatorFeeBps_ > MAX_CREATOR_FEE_BPS) revert CreatorFeeTooHigh();
        protocolFeeBps = protocolFeeBps_;
        creatorFeeBps = creatorFeeBps_;
        emit FeesSet(protocolFeeBps_, creatorFeeBps_);
    }

    // ---------------------------------------------------------------- assembler

    /// @notice Propose the assembler; it can be activated after ASSEMBLER_DELAY. Replaces any pending proposal.
    function proposeAssembler(IAssembler a) external {
        if (msg.sender != assemblerSetter) revert NotSetter();
        if (address(assembler) != address(0)) revert AssemblerFixed();
        if (address(a) == address(0)) revert NoAssembler();
        pendingAssembler = a;
        pendingUntil = uint64(block.timestamp + ASSEMBLER_DELAY);
        emit AssemblerProposed(address(a), pendingUntil);
    }

    /// @notice After ASSEMBLER_DELAY, anyone makes the pending assembler permanent.
    function activateAssembler() external {
        if (address(pendingAssembler) == address(0)) revert NothingPending();
        if (block.timestamp < pendingUntil) revert TooEarly();
        assembler = pendingAssembler;
        assemblerActiveAt = uint64(block.timestamp);
        delete pendingAssembler;
        delete pendingUntil;
        emit AssemblerActivated(address(assembler));
    }

    // ---------------------------------------------------------------- ratings

    /// @notice Propose a score table for batches opened from now on; it can be activated after RATINGS_DELAY.
    ///         Replaces any pending proposal. Only the fee recipient. The table must cover the same number of
    ///         Credits as the current one (any nonzero count if there is none).
    function proposeRatings(IRatings r) external {
        if (msg.sender != feeRecipient) revert NotFeeRecipient();
        if (address(r) == address(0)) revert BadRatings();
        uint256 n = r.count();
        if (n == 0 || (address(ratings) != address(0) && n != ratings.count())) revert BadRatings();
        pendingRatings = r;
        pendingRatingsUntil = uint64(block.timestamp + RATINGS_DELAY);
        emit RatingsProposed(address(r), pendingRatingsUntil);
    }

    /// @notice After RATINGS_DELAY, anyone makes the pending table the one new batches open with.
    function activateRatings() external {
        if (address(pendingRatings) == address(0)) revert NothingPending();
        if (block.timestamp < pendingRatingsUntil) revert TooEarly();
        IRatings r = pendingRatings;
        delete pendingRatings;
        delete pendingRatingsUntil;
        if (r == ratings) return; // re-proposing the current table withdraws a proposal
        ratings = r;
        _ratingsHistory.push(r);
        emit RatingsActivated(address(r));
    }

    /// @notice Every score table this factory has used, oldest first.
    function ratingsHistory() external view returns (IRatings[] memory) {
        return _ratingsHistory;
    }

    /// @notice Open a batch with at least `minOpen` of your Credits.
    /// @param filter Trait hashes (0 for any), payment window and number range (0 for unbounded).
    /// @param allowlist Up to 200 specific Credit numbers that alone may join; empty for no list.
    /// @param reserve Opening bid floor, dropped if no bid within 7 days of assembly. 0 for none.
    /// @param expectProtocolFeeBps The fees shown to you before opening; the call reverts if either has changed
    ///        since, so a fee change can never be slipped in front of an opening batch.
    /// @param expectRatings The score table shown to you before opening; same rule, for a table change.
    /// @dev The batch takes the factory's current protocol and creator fees and keeps them forever.
    /// @param arrangement How the 80 are ordered on the Statement (Batch.Arrangement).
    /// @param split How the sale is divided among the 80 positions (Batch.Split): equal, or early money earns more.
    /// @param duration Still validated and stored, no longer enforced: open batches don't expire, and a full one
    ///        follows Batch's countdown and burn window. Kept so the interface doesn't change.
    function create(
        string calldata name,
        Batch.Filter calldata filter,
        uint256[] calldata allowlist,
        uint256 reserve,
        Batch.Arrangement arrangement,
        Batch.Split split,
        uint256 duration,
        uint256[] calldata ids,
        uint256 expectProtocolFeeBps,
        uint256 expectCreatorFeeBps,
        IRatings expectRatings
    ) external returns (address batch) {
        if (protocolFeeBps != expectProtocolFeeBps || creatorFeeBps != expectCreatorFeeBps) {
            revert FeesChanged(protocolFeeBps, creatorFeeBps);
        }
        if (ratings != expectRatings) revert RatingsChanged(address(ratings));
        if (ids.length < minOpen) revert TooFewToOpen(minOpen);
        if (duration < MIN_DURATION || duration > MAX_DURATION) revert BadDuration();

        batch = Clones.clone(implementation);
        isBatch[batch] = true;
        _batches.push(batch);
        Batch(batch).initialize(
            msg.sender, name, filter, allowlist, reserve, protocolFeeBps, creatorFeeBps, arrangement, split, uint64(block.timestamp + duration), ratings
        );
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
