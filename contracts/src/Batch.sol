// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {IERC721} from "@openzeppelin/contracts/token/ERC721/IERC721.sol";
import {IERC721Receiver} from "@openzeppelin/contracts/token/ERC721/IERC721Receiver.sol";
import {ReentrancyGuardTransient} from "@openzeppelin/contracts/utils/ReentrancyGuardTransient.sol";
import {ICredits, ICreditArt} from "./interfaces/ICredits.sol";
import {IAssembler} from "./interfaces/IAssembler.sol";

interface IBatchFactory {
    function credits() external view returns (ICredits);
    function assembler() external view returns (IAssembler);
    function assemblerActiveAt() external view returns (uint64);
    function exitWindowOpen() external view returns (bool);
    function pendingUntil() external view returns (uint64);
    function feeRecipient() external view returns (address);
    function protocolFeeBps() external view returns (uint256);
}

/// @title Batch
/// @notice Eighty Credits pooled into one Statement.
///
///         Open      Anyone deposits Credits that pass the batch's filter. Depositors withdraw theirs at any time.
///         Full      The 80th Credit locks the batch. Anyone can assemble the Statement until the deadline,
///                   once the factory has an active assembler. While one is only proposed, every batch
///                   (full ones too) can be withdrawn from: the exit window.
///         Expired   Deadline passed before assembly. Every depositor withdraws their Credits.
///         Auction   The batch holds the Statement. The 24-hour clock starts with the first bid.
///         Settled   The Statement went to the winner. Protocol fee and the creator's fee (fixed when the
///                   batch opened), then each deposited Credit claims 1/80 of the rest.
///
///         No owner, no admin, no upgrades. Every rule is in this file. The one external dependency
///         besides Credits is the assembler fixed in the factory: it is called, never delegatecalled,
///         with a temporary operator approval, and its work is verified before the batch moves on.
contract Batch is IERC721Receiver, ReentrancyGuardTransient {
    uint256 public constant SIZE = 80;
    uint256 public constant MAX_CREATOR_FEE_BPS = 1000; // 10%
    uint256 public constant FILL_GRACE = 7 days; // a batch that fills always has at least this long to assemble
    uint256 public constant RESERVE_WINDOW = 7 days; // with no bid by then, the reserve no longer applies
    uint256 public constant AUCTION_LENGTH = 24 hours;
    uint256 public constant EXTENSION = 15 minutes;
    uint256 public constant MIN_RAISE_BPS = 500; // 5%
    uint256 public constant MIN_RAISE = 0.01 ether;
    uint256 public constant REFUND_GAS = 50_000;
    uint256 public constant MAX_NAME = 64;
    uint256 public constant CREATOR_ORDER_GRACE = 1 days; // then anyone burns in deposit order

    /// @notice How the 80 are ordered on the Statement. Fixed when the batch opens; shown before depositing.
    ///         Deposit: as deposited. MintTime / Number: sorted by the adapter. Creator: the creator supplies
    ///         the order at burn time, within CREATOR_ORDER_GRACE of filling; after that, deposit order.
    enum Arrangement {
        Deposit,
        MintTime,
        Number,
        Creator
    }

    enum State {
        Open,
        Full,
        Expired,
        Auction,
        Settled
    }

    /// @notice keccak256 of a required trait value, or 0 for any. Values are CreditArt.describe strings.
    struct Filter {
        bytes32 colors;
        bytes32 print;
        bytes32 weight;
        bytes32 eights;
    }

    struct Summary {
        State state;
        Arrangement arrangement;
        bool canAssemble; // an assembler is active
        bool exitWindow; // a proposed assembler is pending: withdrawals open even when Full
        uint64 exitWindowUntil;
        string name;
        address creator;
        uint256 count;
        uint64 deadline;
        uint64 filledAt;
        uint64 assembledAt;
        uint64 auctionEnd;
        uint256 reserve;
        uint256 minBid;
        uint256 creatorFeeBps;
        uint256 protocolFeeBps;
        Filter filter;
        address statement;
        uint256 statementId;
        address highBidder;
        uint256 highBid;
        uint256 payoutPerShare;
    }

    IBatchFactory public factory;
    ICredits public credits;
    ICreditArt public art;
    address public creator;
    string public name;
    Filter internal _filter;
    uint256 public reserve;
    uint256 public creatorFeeBps;
    Arrangement public arrangement;
    uint64 public deadline;
    uint64 public filledAt;
    uint64 public assembledAt;
    uint64 public auctionEnd;

    uint256[] internal _ids; // deposit order = the order passed to the Statement
    mapping(uint256 id => address) public depositorOf;
    mapping(address => uint256) public sharesOf;

    address public statement;
    uint256 public statementId;
    address public highBidder;
    uint256 public highBid;
    bool public settled;
    bool public statementUnclaimed; // settle() could not push the Statement to the winner; they pull it
    uint256 public payoutPerShare;
    mapping(address => bool) public claimed;
    mapping(address => uint256) public owed; // ETH whose push failed; pull with withdrawOwed

    bool private _assembling;

    event Deposited(address indexed from, uint256 indexed id, uint256 count);
    event Withdrawn(address indexed to, uint256 indexed id, uint256 count);
    event Filled(uint64 deadline);
    event Assembled(address indexed caller, address statement, uint256 statementId, uint256[] order);
    event Bid(address indexed bidder, uint256 amount, uint64 auctionEnd);
    event Settled(address indexed winner, uint256 amount, uint256 protocolFee, uint256 creatorFee, uint256 payoutPerShare);
    event Claimed(address indexed depositor, uint256 amount);
    event Owed(address indexed to, uint256 amount);
    event StatementUnclaimed(address indexed winner);
    event Rescued(address indexed token, uint256 indexed id, address to);

    error AlreadyInitialized();
    error NotFactory();
    error WrongState(State state);
    error NameTooLong();
    error CreatorFeeTooHigh();
    error NotDepositor(uint256 id);
    error NotHeld(uint256 id);
    error AlreadyDeposited(uint256 id);
    error Excluded(uint256 id);
    error WrongToken();
    error CreditsNotBurned();
    error StatementNotReceived();
    error BidTooLow(uint256 min);
    error AuctionOver();
    error AuctionRunning();
    error NothingToClaim();
    error PaymentFailed();
    error NotStray();
    error NotWinner();
    error AssemblerNotReady();
    error NotCreator();
    error CreatorsTurn();
    error BadOrder();

    // ---------------------------------------------------------------- setup

    /// @dev Locks the implementation; only clones are initialized.
    constructor() {
        factory = IBatchFactory(address(1));
    }

    function initialize(
        address creator_,
        string calldata name_,
        Filter calldata filter_,
        uint256 reserve_,
        uint256 creatorFeeBps_,
        Arrangement arrangement_,
        uint64 deadline_
    ) external {
        if (address(factory) != address(0)) revert AlreadyInitialized();
        if (bytes(name_).length > MAX_NAME) revert NameTooLong();
        if (creatorFeeBps_ > MAX_CREATOR_FEE_BPS) revert CreatorFeeTooHigh();
        factory = IBatchFactory(msg.sender);
        credits = factory.credits();
        art = credits.art();
        creator = creator_;
        name = name_;
        _filter = filter_;
        reserve = reserve_;
        creatorFeeBps = creatorFeeBps_;
        arrangement = arrangement_;
        deadline = deadline_;
    }

    // ---------------------------------------------------------------- state

    function state() public view returns (State) {
        if (statement != address(0)) return settled ? State.Settled : State.Auction;
        if (block.timestamp >= effectiveDeadline()) return State.Expired;
        return _ids.length == SIZE ? State.Full : State.Open;
    }

    /// @notice The deadline, extended so a batch that filled before the assembler was active always has
    ///         FILL_GRACE from activation to burn.
    function effectiveDeadline() public view returns (uint256 dl) {
        dl = deadline;
        if (_ids.length == SIZE) {
            uint256 active = factory.assemblerActiveAt();
            if (active != 0 && dl < active + FILL_GRACE) dl = active + FILL_GRACE;
        }
    }

    function _require(State s) internal view {
        State now_ = state();
        if (now_ != s) revert WrongState(now_);
    }

    // ---------------------------------------------------------------- deposit / withdraw

    /// @notice Records Credits the factory has just moved here, on behalf of `from`.
    function depositFrom(address from, uint256[] calldata ids) external nonReentrant {
        if (msg.sender != address(factory)) revert NotFactory();
        for (uint256 i; i < ids.length; ++i) {
            if (credits.ownerOf(ids[i]) != address(this)) revert NotHeld(ids[i]);
            _add(from, ids[i]);
        }
    }

    /// @notice Deposit one Credit with `Credits.safeTransferFrom(you, batch, id)`, no approval needed.
    ///         `data` may hold an abi-encoded address to record as the depositor instead of `from`
    ///         (for escrows and marketplaces delivering on someone's behalf). Also accepts the
    ///         Statement while assembling. Plain `transferFrom` fires no hook: use `rescue` for those.
    function onERC721Received(address, address from, uint256 id, bytes calldata data)
        external
        override
        returns (bytes4)
    {
        if (_assembling) return this.onERC721Received.selector;
        if (msg.sender != address(credits)) revert WrongToken();
        if (data.length == 32) {
            address to = abi.decode(data, (address));
            if (to != address(0)) from = to;
        }
        _add(from, id);
        return this.onERC721Received.selector;
    }

    function _add(address from, uint256 id) internal {
        _require(State.Open);
        if (depositorOf[id] != address(0)) revert AlreadyDeposited(id);
        if (!passes(id)) revert Excluded(id);
        _ids.push(id);
        depositorOf[id] = from;
        ++sharesOf[from];
        emit Deposited(from, id, _ids.length);
        if (_ids.length == SIZE) {
            filledAt = uint64(block.timestamp);
            uint64 floor = uint64(block.timestamp + FILL_GRACE);
            if (deadline < floor) deadline = floor;
            emit Filled(deadline);
        }
    }

    /// @notice Take your Credits back. Allowed while Open (under 80), after the deadline if never assembled,
    ///         and from any unassembled batch while the factory's exit window is open.
    function withdraw(uint256[] calldata ids) external nonReentrant {
        State s = state();
        bool exit = s == State.Full && factory.exitWindowOpen();
        if (s != State.Open && s != State.Expired && !exit) revert WrongState(s);
        // Book everything first, then move tokens.
        for (uint256 i; i < ids.length; ++i) {
            uint256 id = ids[i];
            if (depositorOf[id] != msg.sender) revert NotDepositor(id);
            delete depositorOf[id];
            --sharesOf[msg.sender];
            _remove(id);
            emit Withdrawn(msg.sender, id, _ids.length);
        }
        for (uint256 i; i < ids.length; ++i) credits.transferFrom(address(this), msg.sender, ids[i]);
    }

    /// @dev Keeps deposit order for the rest.
    function _remove(uint256 id) internal {
        uint256 n = _ids.length;
        uint256 i;
        while (_ids[i] != id) ++i;
        for (; i + 1 < n; ++i) _ids[i] = _ids[i + 1];
        _ids.pop();
    }

    /// @notice Whether a Credit meets this batch's trait filter. Reads Jack's own art contract.
    function passes(uint256 id) public view returns (bool) {
        Filter memory f = _filter;
        if (f.colors == 0 && f.print == 0 && f.weight == 0 && f.eights == 0) return true;
        ICreditArt.Read memory r = art.describe(credits.seedOf(id), credits.timestampOf(id));
        return (f.colors == 0 || f.colors == keccak256(bytes(r.colors)))
            && (f.print == 0 || f.print == keccak256(bytes(r.register)))
            && (f.weight == 0 || f.weight == keccak256(bytes(r.weight)))
            && (f.eights == 0 || f.eights == keccak256(bytes(r.eightsLabel)));
    }

    // ---------------------------------------------------------------- assemble

    /// @notice Burn the 80 into a Statement with the batch's arrangement. Anyone can call once Full; the
    ///         caller pays gas. With the Creator arrangement, only after the creator's grace has passed.
    function assemble() external nonReentrant {
        _require(State.Full);
        if (arrangement == Arrangement.Creator && block.timestamp < filledAt + CREATOR_ORDER_GRACE) {
            revert CreatorsTurn();
        }
        _assemble(_ids, arrangement == Arrangement.Creator ? Arrangement.Deposit : arrangement);
    }

    /// @notice Creator arrangement only: the creator burns with a hand-made order (a permutation of the 80).
    function assembleOrdered(uint256[] calldata order) external nonReentrant {
        _require(State.Full);
        if (arrangement != Arrangement.Creator) revert BadOrder();
        if (msg.sender != creator) revert NotCreator();
        if (order.length != SIZE) revert BadOrder();
        for (uint256 i; i < SIZE; ++i) {
            if (depositorOf[order[i]] == address(0)) revert BadOrder();
            for (uint256 j; j < i; ++j) {
                if (order[j] == order[i]) revert BadOrder();
            }
        }
        _assemble(order, Arrangement.Creator);
    }

    /// @dev The assembler is fixed in the factory. It is approved as an operator for this batch's
    ///      Credits only for the duration of the call, and its work is checked afterwards: none of the 80
    ///      Credits may still exist, and this batch must own the Statement the adapter says it minted.
    ///      Its storage is its own; nothing it does can reach this contract's state.
    function _assemble(uint256[] memory ids, Arrangement how) internal {
        IAssembler asm = factory.assembler();
        if (address(asm) == address(0)) revert AssemblerNotReady();
        address st = asm.statement();
        if (st == address(0) || st == address(credits)) revert StatementNotReceived();

        _assembling = true;
        credits.setApprovalForAll(address(asm), true);
        uint256 sid = asm.assemble(ids, uint8(how));
        credits.setApprovalForAll(address(asm), false);
        _assembling = false;

        for (uint256 i; i < SIZE; ++i) {
            try credits.ownerOf(ids[i]) returns (address) {
                revert CreditsNotBurned();
            } catch {}
        }
        if (IERC721(st).ownerOf(sid) != address(this)) revert StatementNotReceived();

        statement = st;
        statementId = sid;
        assembledAt = uint64(block.timestamp);
        emit Assembled(msg.sender, st, sid, ids);
    }

    // ---------------------------------------------------------------- auction

    /// @notice Smallest bid accepted right now.
    function minBid() public view returns (uint256) {
        if (highBid == 0) {
            if (block.timestamp < assembledAt + RESERVE_WINDOW && reserve > 0) return reserve;
            return 1;
        }
        uint256 raise = highBid * MIN_RAISE_BPS / 10_000;
        return highBid + (raise > MIN_RAISE ? raise : MIN_RAISE);
    }

    function bid() external payable nonReentrant {
        _require(State.Auction);
        if (highBid != 0 && block.timestamp >= auctionEnd) revert AuctionOver();
        uint256 min = minBid();
        if (msg.value < min) revert BidTooLow(min);

        address prevBidder = highBidder;
        uint256 prevBid = highBid;
        highBidder = msg.sender;
        highBid = msg.value;

        if (prevBid == 0) {
            auctionEnd = uint64(block.timestamp + AUCTION_LENGTH);
        } else if (auctionEnd - block.timestamp < EXTENSION) {
            auctionEnd = uint64(block.timestamp + EXTENSION);
        }
        emit Bid(msg.sender, msg.value, auctionEnd);

        if (prevBid != 0) _push(prevBidder, prevBid);
    }

    /// @notice After the clock runs out, anyone sends the Statement to the winner and books the split.
    function settle() external nonReentrant {
        _require(State.Auction);
        if (highBid == 0 || block.timestamp < auctionEnd) revert AuctionRunning();
        settled = true;

        uint256 creatorFee = highBid * creatorFeeBps / 10_000;
        uint256 fee = highBid * factory.protocolFeeBps() / 10_000;
        uint256 per = (highBid - fee - creatorFee) / SIZE;
        payoutPerShare = per;
        fee = highBid - creatorFee - per * SIZE; // rounding dust goes with the protocol fee
        emit Settled(highBidder, highBid, fee, creatorFee, per);

        // A Statement contract that refuses the transfer must not trap the sale: the winner pulls instead.
        try IERC721(statement).transferFrom(address(this), highBidder, statementId) {}
        catch {
            statementUnclaimed = true;
            emit StatementUnclaimed(highBidder);
        }
        _push(factory.feeRecipient(), fee);
        if (creatorFee > 0) _push(creator, creatorFee);
    }

    /// @notice Winner's fallback when settle() could not deliver the Statement.
    function claimStatement(address to) external nonReentrant {
        if (!statementUnclaimed || msg.sender != highBidder) revert NotWinner();
        statementUnclaimed = false;
        IERC721(statement).transferFrom(address(this), to, statementId);
    }

    // ---------------------------------------------------------------- payouts

    function claimable(address depositor) public view returns (uint256) {
        if (!settled || claimed[depositor]) return 0;
        return sharesOf[depositor] * payoutPerShare;
    }

    /// @notice Pays a depositor their share. Anyone can call it for anyone.
    function claim(address depositor) external nonReentrant {
        uint256 amount = claimable(depositor);
        if (amount == 0) revert NothingToClaim();
        claimed[depositor] = true;
        emit Claimed(depositor, amount);
        if (!_send(depositor, amount, gasleft())) revert PaymentFailed();
    }

    /// @notice Collect a refund or fee whose automatic payment failed.
    function withdrawOwed() external nonReentrant {
        uint256 amount = owed[msg.sender];
        if (amount == 0) revert NothingToClaim();
        owed[msg.sender] = 0;
        if (!_send(msg.sender, amount, gasleft())) revert PaymentFailed();
    }

    /// @notice Forward a token this batch holds but never recorded (a Credit sent with plain `transferFrom`,
    ///         or any other NFT) to the fee recipient as lost-and-found. Cannot touch pooled Credits or
    ///         the Statement. Anyone can call it.
    function rescue(address token, uint256 id) external nonReentrant {
        if (token == address(credits) && depositorOf[id] != address(0)) revert NotStray();
        if (token == statement && id == statementId) revert NotStray();
        address to = factory.feeRecipient();
        IERC721(token).transferFrom(address(this), to, id);
        emit Rescued(token, id, to);
    }

    /// @dev Gas-capped so a receiver that reverts or burns gas cannot block bids; failures become `owed`.
    function _push(address to, uint256 amount) internal {
        if (!_send(to, amount, REFUND_GAS)) {
            owed[to] += amount;
            emit Owed(to, amount);
        }
    }

    /// @dev Plain ETH send that never copies return data (no return-bomb).
    function _send(address to, uint256 amount, uint256 gasLimit) internal returns (bool ok) {
        assembly {
            ok := call(gasLimit, to, amount, 0, 0, 0, 0)
        }
    }

    // ---------------------------------------------------------------- views

    function ids() external view returns (uint256[] memory) {
        return _ids;
    }

    function count() external view returns (uint256) {
        return _ids.length;
    }

    function filter() external view returns (Filter memory) {
        return _filter;
    }

    /// @notice Ids and depositors in deposit order.
    function slots() external view returns (uint256[] memory ids_, address[] memory depositors) {
        ids_ = _ids;
        depositors = new address[](ids_.length);
        for (uint256 i; i < ids_.length; ++i) depositors[i] = depositorOf[ids_[i]];
    }

    function summary() external view returns (Summary memory s) {
        s.state = state();
        s.arrangement = arrangement;
        s.canAssemble = address(factory.assembler()) != address(0);
        s.exitWindow = factory.exitWindowOpen();
        s.exitWindowUntil = factory.pendingUntil();
        s.name = name;
        s.creator = creator;
        s.count = _ids.length;
        s.deadline = uint64(effectiveDeadline());
        s.filledAt = filledAt;
        s.assembledAt = assembledAt;
        s.auctionEnd = auctionEnd;
        s.reserve = reserve;
        s.minBid = statement != address(0) && !settled ? minBid() : 0;
        s.creatorFeeBps = creatorFeeBps;
        s.protocolFeeBps = factory.protocolFeeBps();
        s.filter = _filter;
        s.statement = statement;
        s.statementId = statementId;
        s.highBidder = highBidder;
        s.highBid = highBid;
        s.payoutPerShare = payoutPerShare;
    }
}
