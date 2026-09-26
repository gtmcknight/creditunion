// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {IERC721} from "@openzeppelin/contracts/token/ERC721/IERC721.sol";
import {IERC721Receiver} from "@openzeppelin/contracts/token/ERC721/IERC721Receiver.sol";
import {ReentrancyGuardTransient} from "@openzeppelin/contracts/utils/ReentrancyGuardTransient.sol";
import {ICredits, ICreditArt} from "./interfaces/ICredits.sol";
import {IAssembler} from "./interfaces/IAssembler.sol";

interface IRatings {
    function scoreOf(uint256 id) external view returns (uint16);
}

interface IBatchFactory {
    function credits() external view returns (ICredits);
    function ratings() external view returns (IRatings);
    function assembler() external view returns (IAssembler);
    function assemblerActiveAt() external view returns (uint64);
    function feeRecipient() external view returns (address);
    function isBatch(address) external view returns (bool);
}

/// @title Batch
/// @notice 80 Credits pooled into one Statement: a credit union.
///
///         Open      Anyone deposits Credits that pass the batch's filter. Depositors withdraw theirs at any time.
///                   An open batch never expires: it stays open until it holds 80.
///         Full      80 held. See `phase()` for the lock:
///                   Waiting    no active assembler yet (none set, or proposed and still in its 30-minute delay):
///                              never locked, depositors withdraw freely.
///                   Countdown  from max(filledAt, assembler activation) until lockAt = that + LOCK_DELAY
///                              (5 minutes): last chance to leave. Leaving drops it under 80; refilling starts
///                              a new countdown.
///                   Burnable   from lockAt for BURN_WINDOW (1 hour): withdrawals revert and anyone can
///                              assemble. This is the only time a burn can happen, and it always follows at
///                              least 5 minutes of notice in which everyone could leave.
///                   Expired    nobody burned in the window: withdrawals work again, assemble does not.
///                              Anyone may call restartCountdown() to give it a fresh 5-minute notice and
///                              window, the same effect as one depositor leaving and rejoining.
///         Expired   No longer entered. Kept so the enum's values (and every client decoding them) don't shift.
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
    uint256 public constant MAX_PROTOCOL_FEE_BPS = 500; // 5%
    uint256 public constant LOCK_DELAY = 5 minutes; // notice between a full batch's countdown start and its lock
    uint256 public constant BURN_WINDOW = 1 hours; // how long it stays locked and burnable
    uint256 public constant RESERVE_WINDOW = 7 days; // with no bid by then, the reserve no longer applies
    uint256 public constant AUCTION_LENGTH = 24 hours;
    uint256 public constant EXTENSION = 15 minutes;
    uint256 public constant MIN_RAISE_BPS = 500; // 5%
    uint256 public constant MIN_RAISE = 0.01 ether;
    uint256 public constant REFUND_GAS = 50_000;
    uint256 public constant MAX_NAME = 64;
    uint256 public constant MAX_ALLOWLIST = 200;

    /// @notice How the 80 are ordered on the Statement. Fixed when the batch opens; shown before depositing.
    ///         Deposit: as deposited. Number / NumberDesc: by Credit number, low to high / high to low.
    ///         Layout: as painted, each slot holding a Credit of its palette. The Batch computes the order
    ///         itself (`burnOrder()`), so anyone can check it and burn at once.
    ///         Retired (values kept so the others don't shift; new batches can't choose them): Creator
    ///         (hand-arranged after filling) and MintTime (Credit numbers follow payment time on mainnet, so it
    ///         was Number under another name).
    enum Arrangement {
        Deposit,
        MintTime,
        Number,
        Creator,
        Layout, // the sheet follows a layout painted when the batch was designed (Filter.layout0/1, layoutTrait)
        NumberDesc
    }

    /// @notice How the depositors' share of the sale is divided among the 80 positions (deposit order).
    ///         Equal: 1/80 each. Early: a straight line from 1.5 shares at position 1 to 0.5 at position 80,
    ///         so the first money in, which carried the most coordination risk, earns the most. Withdrawing
    ///         forfeits the position (everyone behind moves up) and re-depositing joins at the back.
    enum Split {
        Equal,
        Early
    }

    /// @dev Early weights in integer units: position i (0-based) gets 237 - 2i units; they sum to 80 × 158.
    uint256 internal constant EARLY_UNITS = 12_640;
    uint256 internal constant EARLY_MID = 158; // units of one equal share, for display

    enum State {
        Open,
        Full,
        Expired,
        Auction,
        Settled
    }

    /// @notice Where a batch is in its lock cycle (see the contract notes). Open: under 80. Assembled: the
    ///         Statement exists (State Auction or Settled).
    enum Phase {
        Open,
        Waiting,
        Countdown,
        Burnable,
        Expired,
        Assembled
    }

    /// @notice Who may join. Trait fields are sets, one bit per accepted value, 0 for any:
    ///         palettes: bit (C=1 | M=2 | Y=4 | K=8) of the plate combination, so CMY is bit 7;
    ///         prints: bit 0 Registered, 1 Nudge, 2 Slip, 3 Skew, 4 Drift, 5 Loose;
    ///         weights: bit 0 even, 1 lean, 2 sparse, 3 extreme; eights: bit n for n eights.
    ///         Ranges are inclusive; 0 means unbounded. An explicit allowlist is set separately at creation.
    struct Filter {
        uint16 palettes;
        uint8 prints;
        uint8 weights;
        uint32 eights;
        uint64 paidFrom; // Credits paid for at or after this time
        uint64 paidTo; // ...and at or before this one
        uint256 idFrom; // Credit numbers from...
        uint256 idTo; // ...to
        uint16 minScore; // official rating ×10 (80.00 → 800), 0 = any
        uint16 maxScore; // 0 = any
        // A palette layout for the 8×10 sheet: 4 bits per slot in deposit order (slots 0–63 in layout0,
        // 64–79 in layout1), 0 = any palette, 1–15 = the CMYK mask that slot must show. Both zero = no layout.
        uint256 layout0;
        uint64 layout1;
        // Jack's "Bits" trait: marks set across the Credit's active plates (0–256). 0 = unbounded on that side.
        uint16 bitsFrom;
        uint16 bitsTo;
        // Which trait the layout paints (layout batches only; 0 otherwise). Each slot value is 1 + that trait's
        // value, 0 = any: 0 Colors (the CMYK mask itself, 1–15), 1 Eights (eights + 1, 1–6), 2 Print (1–6,
        // Registered … Loose), 3 Weight (1–4, even … extreme), 4 Plates (number of inks, 1–4).
        uint8 layoutTrait;
    }

    struct Summary {
        State state;
        Arrangement arrangement;
        bool canAssemble; // an assembler is active
        Phase phase;
        uint64 lockAt; // when a full batch locks and becomes burnable; 0 when not counting down
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
        uint256 allowlistSize;
        address statement;
        uint256 statementId;
        address highBidder;
        uint256 highBid;
        uint256 payoutPerShare;
        Split split;
    }

    IBatchFactory public factory;
    ICredits public credits;
    ICreditArt public art;
    address public creator;
    string public name;
    Filter internal _filter;
    // Layout bookkeeping: how many slots want each trait value, how many Credits of each are in, how many
    // "any" slots exist, and how many Credits are already spilling into them. The batch stays fillable as
    // long as overflow ≤ anySlots (then every painted slot can be matched and the rest take the any slots).
    uint8[16] internal _slots;
    uint8[16] internal _have;
    uint8 internal anySlots;
    uint8 internal overflow;
    /// @notice A deposited Credit's value of the painted trait, as the slots encode it (layout batches only).
    mapping(uint256 => uint8) public keyOf;
    /// @notice When non-empty, only these Credits may join.
    uint256 public allowlistSize;
    mapping(uint256 id => bool) public allowed;
    uint256 public reserve;
    /// @notice The split this batch opened with. Later changes on the factory never reach it.
    uint256 public creatorFeeBps;
    uint256 public protocolFeeBps;
    Arrangement public arrangement;
    Split public split;
    uint64 public deadline; // set at creation; no longer enforced (open batches don't expire)
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
    /// @notice Wei per unit of the split (a unit is one share when Equal, 1/158 of a share when Early).
    uint256 public payoutPerUnit;
    mapping(address => bool) public claimed;
    mapping(address => uint256) public owed; // ETH whose push failed; pull with withdrawOwed

    bool private _assembling;

    event Deposited(address indexed from, uint256 indexed id, uint256 count);
    event Withdrawn(address indexed to, uint256 indexed id, uint256 count);
    event Filled(uint64 lockAt); // lockAt is 0 while no assembler is active
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
    error WrongPhase(Phase phase);
    error NameTooLong();
    error AllowlistTooLong();
    error BadFilter();
    error CreatorFeeTooHigh();
    error ProtocolFeeTooHigh();
    error NotDepositor(uint256 id);
    error NotHeld(uint256 id);
    error AlreadyDeposited(uint256 id);
    error Excluded(uint256 id);
    error WrongToken();
    error NoDepositor();
    error CreditsNotBurned();
    error StatementNotReceived();
    error BidTooLow(uint256 min);
    error AuctionOver();
    error AuctionRunning();
    error NothingToClaim();
    error PaymentFailed();
    error NotStray();
    error NotWinner();
    error ArrangementRetired();
    error BadOrder();
    error NoSlot(uint256 id);
    error LayoutMismatch(uint256 slot);
    error ReserveTooLow();

    // ---------------------------------------------------------------- setup

    /// @dev Locks the implementation; only clones are initialized.
    constructor() {
        factory = IBatchFactory(address(1));
    }

    function initialize(
        address creator_,
        string calldata name_,
        Filter calldata filter_,
        uint256[] calldata allowlist_,
        uint256 reserve_,
        uint256 protocolFeeBps_,
        uint256 creatorFeeBps_,
        Arrangement arrangement_,
        Split split_,
        uint64 deadline_
    ) external {
        if (address(factory) != address(0)) revert AlreadyInitialized();
        if (bytes(name_).length > MAX_NAME) revert NameTooLong();
        if (allowlist_.length > MAX_ALLOWLIST) revert AllowlistTooLong();
        if (filter_.paidTo != 0 && filter_.paidFrom > filter_.paidTo) revert BadFilter();
        if (filter_.idTo != 0 && filter_.idFrom > filter_.idTo) revert BadFilter();
        if (filter_.maxScore != 0 && filter_.minScore > filter_.maxScore) revert BadFilter();
        if (filter_.bitsTo != 0 && filter_.bitsFrom > filter_.bitsTo) revert BadFilter();
        // Filters that can never admit 80: an id range narrower than 80 (inclusive; id 0 counted, so this
        // never refuses a range some real Credits fill), more marks than any Credit has (4 inks × 64), or
        // palettes = {mask 0} (every Credit has at least one ink). The allowlist is checked below, deduped.
        if (filter_.idTo != 0 && filter_.idTo - filter_.idFrom + 1 < SIZE) revert BadFilter();
        if (filter_.bitsFrom > 256 || filter_.palettes == 1) revert BadFilter();
        if ((filter_.minScore != 0 || filter_.maxScore != 0) && address(IBatchFactory(msg.sender).ratings()) == address(0)) {
            revert BadFilter();
        }
        if (arrangement_ == Arrangement.Creator || arrangement_ == Arrangement.MintTime) revert ArrangementRetired();
        // A reserve under the 0.01 ETH floor would lower it (minBid returns the reserve while it stands).
        if (reserve_ != 0 && reserve_ < MIN_RAISE) revert ReserveTooLow();
        bool hasLayout = filter_.layout0 != 0 || filter_.layout1 != 0;
        if (hasLayout != (arrangement_ == Arrangement.Layout)) revert BadFilter();
        if (!hasLayout && filter_.layoutTrait != 0) revert BadFilter();
        if (hasLayout) {
            Filter memory lf = filter_;
            uint256 top = _topKey(lf.layoutTrait); // reverts on an unknown trait
            uint256 ok = _filterKeys(lf); // slot values the filter lets in
            for (uint256 i; i < SIZE; ++i) {
                uint256 p = _slot(lf, i);
                // A value no Credit has, or one the filter keeps out: the slot could never fill.
                if (p > top || (p != 0 && (ok >> p) & 1 == 0)) revert BadFilter();
                if (p == 0) ++anySlots;
                else ++_slots[p];
            }
        }
        for (uint256 i; i < allowlist_.length; ++i) {
            if (!allowed[allowlist_[i]]) {
                allowed[allowlist_[i]] = true;
                ++allowlistSize;
            }
        }
        if (allowlistSize != 0 && allowlistSize < SIZE) revert BadFilter();
        if (creatorFeeBps_ > MAX_CREATOR_FEE_BPS) revert CreatorFeeTooHigh();
        if (protocolFeeBps_ > MAX_PROTOCOL_FEE_BPS) revert ProtocolFeeTooHigh();
        factory = IBatchFactory(msg.sender);
        credits = factory.credits();
        art = credits.art();
        creator = creator_;
        name = name_;
        _filter = filter_;
        reserve = reserve_;
        creatorFeeBps = creatorFeeBps_;
        protocolFeeBps = protocolFeeBps_;
        arrangement = arrangement_;
        split = split_;
        deadline = deadline_;
    }

    // ---------------------------------------------------------------- state

    function state() public view returns (State) {
        if (statement != address(0)) return settled ? State.Settled : State.Auction;
        return _ids.length == SIZE ? State.Full : State.Open;
    }

    /// @notice When a full, unassembled batch locks and becomes burnable: LOCK_DELAY after it filled or after the
    ///         assembler went live, whichever is later. 0 when under 80, assembled, or no assembler is active.
    function lockAt() public view returns (uint256) {
        if (_ids.length != SIZE || statement != address(0)) return 0;
        uint256 active = factory.assemblerActiveAt();
        if (active == 0) return 0;
        return (active > filledAt ? active : filledAt) + LOCK_DELAY;
    }

    /// @notice When the burn window closes and the batch unlocks again; 0 when lockAt() is 0.
    function burnDeadline() public view returns (uint256) {
        uint256 at = lockAt();
        return at == 0 ? 0 : at + BURN_WINDOW;
    }

    function phase() public view returns (Phase) {
        if (statement != address(0)) return Phase.Assembled;
        if (_ids.length != SIZE) return Phase.Open;
        uint256 at = lockAt();
        if (at == 0) return Phase.Waiting;
        if (block.timestamp < at) return Phase.Countdown;
        if (block.timestamp < at + BURN_WINDOW) return Phase.Burnable;
        return Phase.Expired;
    }

    /// @notice After a burn window lapses unused, start a new 5-minute countdown (then a new window). Anyone may
    ///         call it; a depositor could get the same by leaving and rejoining. Credits stay withdrawable
    ///         through the countdown, so this never locks anyone in without notice.
    function restartCountdown() external {
        Phase p = phase();
        if (p != Phase.Expired) revert WrongPhase(p);
        filledAt = uint64(block.timestamp);
        emit Filled(uint64(lockAt()));
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
        // Same rule as the factory's depositFor: a depositor that can never withdraw or take ETH would strand
        // the share (this batch, the factory, another batch), and a mint hook has no depositor at all.
        if (from == address(0) || from == address(this) || from == address(factory) || factory.isBatch(from)) {
            revert NoDepositor();
        }
        _add(from, id);
        return this.onERC721Received.selector;
    }

    function _add(address from, uint256 id) internal {
        _require(State.Open);
        if (depositorOf[id] != address(0)) revert AlreadyDeposited(id);
        if (!passes(id)) revert Excluded(id);
        if (arrangement == Arrangement.Layout) {
            uint256 p = _keyOf(id);
            if (_have[p] >= _slots[p]) {
                if (overflow >= anySlots) revert NoSlot(id); // no painted slot left for this value, no any slot free
                ++overflow;
            }
            ++_have[p];
            keyOf[id] = uint8(p);
        }
        _ids.push(id);
        depositorOf[id] = from;
        ++sharesOf[from];
        emit Deposited(from, id, _ids.length);
        if (_ids.length == SIZE) {
            // Every fill starts a countdown. A leave-and-rejoin can restart it, but each restart gives everyone
            // LOCK_DELAY to leave and the lock that follows lasts BURN_WINDOW, during which anyone can burn.
            filledAt = uint64(block.timestamp);
            emit Filled(uint64(lockAt()));
        }
    }

    /// @notice Take your Credits back. Allowed at any time before assembly except in the burn window
    ///         (phase Burnable: from lockAt() for BURN_WINDOW). Leaving a full batch stops its countdown.
    function withdraw(uint256[] calldata ids) external nonReentrant {
        if (ids.length == 0) revert NothingToClaim(); // an empty call would still reset filledAt below
        Phase p = phase();
        if (p == Phase.Burnable || p == Phase.Assembled) revert WrongPhase(p);
        filledAt = 0; // under 80 from here; the next fill starts a new countdown
        // Book everything first, then move tokens.
        for (uint256 i; i < ids.length; ++i) {
            uint256 id = ids[i];
            if (depositorOf[id] != msg.sender) revert NotDepositor(id);
            delete depositorOf[id];
            --sharesOf[msg.sender];
            if (arrangement == Arrangement.Layout) {
                uint256 p = keyOf[id];
                if (_have[p] > _slots[p]) --overflow;
                --_have[p];
                delete keyOf[id];
            }
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

    /// @notice Whether a Credit may join: allowlist, number range, payment window, then traits (read from
    ///         Jack's own art contract).
    function passes(uint256 id) public view returns (bool) {
        if (allowlistSize != 0 && !allowed[id]) return false;
        Filter memory f = _filter;
        if (id < f.idFrom || (f.idTo != 0 && id > f.idTo)) return false;
        if (f.paidFrom != 0 || f.paidTo != 0) {
            uint64 t = credits.timestampOf(id);
            if (t < f.paidFrom || (f.paidTo != 0 && t > f.paidTo)) return false;
        }
        if (f.minScore != 0 || f.maxScore != 0) {
            uint16 sc = factory.ratings().scoreOf(id);
            // 0 means "not in the table" (real scores start at 80.0): never admitted by a rating rule.
            if (sc == 0 || sc < f.minScore || (f.maxScore != 0 && sc > f.maxScore)) return false;
        }
        if (f.palettes == 0 && f.prints == 0 && f.weights == 0 && f.eights == 0 && f.bitsFrom == 0 && f.bitsTo == 0) return true;
        ICreditArt.Read memory r = art.describe(credits.seedOf(id), credits.timestampOf(id));
        if (f.palettes != 0 && f.palettes & (1 << _paletteMask(r.colors)) == 0) return false;
        if (f.prints != 0 && f.prints & (1 << _index(r.register, PRINTS)) == 0) return false;
        if (f.weights != 0 && f.weights & (1 << _index(r.weight, WEIGHTS)) == 0) return false;
        if (f.eights != 0 && (r.eights > 31 || f.eights & (1 << r.eights) == 0)) return false;
        if (r.marks < f.bitsFrom || (f.bitsTo != 0 && r.marks > f.bitsTo)) return false;
        return true;
    }

    string internal constant PRINTS = "Registered|Nudge|Slip|Skew|Drift|Loose";
    string internal constant WEIGHTS = "even|lean|sparse|extreme";

    /// @dev C=1, M=2, Y=4, K=8 from the describe() letters.
    function _paletteMask(string memory colors) internal pure returns (uint256 m) {
        bytes memory b = bytes(colors);
        for (uint256 i; i < b.length; ++i) {
            if (b[i] == "C") m |= 1;
            else if (b[i] == "M") m |= 2;
            else if (b[i] == "Y") m |= 4;
            else if (b[i] == "K") m |= 8;
        }
    }

    /// @dev The painted trait's value for `id`, as slots encode it (see Filter.layoutTrait). Every Credit has
    ///      exactly one value of each trait, which is what keeps the slot books simple and a batch completable.
    function _keyOf(uint256 id) internal view returns (uint256) {
        ICreditArt.Read memory r = art.describe(credits.seedOf(id), credits.timestampOf(id));
        uint8 t = _filter.layoutTrait;
        if (t == 0) return _paletteMask(r.colors);
        if (t == 1) return r.eights < 14 ? r.eights + 1 : 15;
        if (t == 2) return _index(r.register, PRINTS) + 1;
        if (t == 3) return _index(r.weight, WEIGHTS) + 1;
        return bytes(r.colors).length; // Plates: 1–4 inks
    }

    /// @dev The highest slot value a trait can take.
    function _topKey(uint8 trait) internal pure returns (uint256) {
        if (trait == 0) return 15;
        if (trait == 1) return 6; // the edition tops out at 5 eights
        if (trait == 2) return 6;
        if (trait == 3 || trait == 4) return 4;
        revert BadFilter();
    }

    /// @dev Bit `p` set = slot value `p` of the painted trait can pass the filter's trait rules and Bits range
    ///      (see passes()).
    function _filterKeys(Filter memory f) internal pure returns (uint256) {
        return _traitKeys(f) & _bitsKeys(f);
    }

    function _traitKeys(Filter memory f) internal pure returns (uint256) {
        uint8 t = f.layoutTrait;
        if (t == 0) return f.palettes == 0 ? type(uint256).max : f.palettes;
        if (t == 1) return f.eights == 0 ? type(uint256).max : uint256(f.eights) << 1;
        if (t == 2) return f.prints == 0 ? type(uint256).max : uint256(f.prints) << 1;
        if (t == 3) return f.weights == 0 ? type(uint256).max : uint256(f.weights) << 1;
        // Plates: an ink count passes if some allowed palette has that many inks.
        if (f.palettes == 0) return type(uint256).max;
        uint256 ok;
        for (uint256 m = 1; m < 16; ++m) {
            if (f.palettes & (1 << m) != 0) ok |= 1 << _inks(m);
        }
        return ok;
    }

    /// @dev Slot values the Bits range leaves possible. CreditArt: n inks (1-4, every mask occurs) give
    ///      capacity 64n and any mark count from 0 to 64n. A Colors mask or Plates count with n inks therefore
    ///      spans 0..64n marks. Weight compares marks*256 with capacity in nested bands: even 30n..34n marks
    ///      (120-136/256), lean 28n..36n (112-144), sparse 24n..40n (96-160), extreme 0..64n, each minus the band
    ///      inside it. Over n = 1..4 that puts even at 30..136, lean 28..144, sparse 24..160, extreme 0..256, with
    ///      gaps between inks (no lean Credit has 37..55 marks). A value is dropped only when no ink count leaves
    ///      a mark count in [bitsFrom, bitsTo]; exact, so no fillable layout is refused. Eights and Print don't
    ///      bound marks.
    function _bitsKeys(Filter memory f) internal pure returns (uint256 ok) {
        uint256 lo = f.bitsFrom;
        uint256 hi = f.bitsTo == 0 ? 256 : f.bitsTo;
        uint8 t = f.layoutTrait;
        if (t == 1 || t == 2 || (lo == 0 && hi == 256)) return type(uint256).max;
        if (t == 3) {
            for (uint256 v = 1; v <= 4; ++v) {
                for (uint256 n = 1; n <= 4; ++n) {
                    (uint256 a, uint256 b) = _band(v, n);
                    bool hit;
                    if (v == 1) {
                        hit = _meets(lo, hi, a, b);
                    } else {
                        (uint256 ia, uint256 ib) = _band(v - 1, n); // the lighter band inside, which wins
                        hit = _meets(lo, hi, a, ia - 1) || _meets(lo, hi, ib + 1, b);
                    }
                    if (hit) {
                        ok |= 1 << v;
                        break;
                    }
                }
            }
            return ok;
        }
        // Colors (mask v) or Plates (v inks): marks 0..64n, so only the lower bound can rule a value out.
        for (uint256 v = 1; v < 16; ++v) {
            if (64 * (t == 0 ? _inks(v) : v) >= lo) ok |= 1 << v;
        }
    }

    /// @dev Marks band of weight `v` (1 even .. 4 extreme) for `n` inks, before removing the inner bands.
    function _band(uint256 v, uint256 n) internal pure returns (uint256, uint256) {
        if (v == 1) return (30 * n, 34 * n);
        if (v == 2) return (28 * n, 36 * n);
        if (v == 3) return (24 * n, 40 * n);
        return (0, 64 * n);
    }

    /// @dev [a, b] and [lo, hi] overlap.
    function _meets(uint256 lo, uint256 hi, uint256 a, uint256 b) internal pure returns (bool) {
        return a <= hi && b >= lo;
    }

    function _inks(uint256 m) internal pure returns (uint256) {
        return (m & 1) + (m >> 1 & 1) + (m >> 2 & 1) + (m >> 3);
    }

    /// @dev Value wanted at layout slot `i` (0 = any).
    function _slot(Filter memory f, uint256 i) internal pure returns (uint256) {
        return i < 64 ? (f.layout0 >> (4 * i)) & 15 : (f.layout1 >> (4 * (i - 64))) & 15;
    }

    /// @notice Whether each of `ids`, deposited together in this order, would find a slot (always true without a
    ///         layout). Ids in one bundle interact (two K Credits, one K slot), so the rule is replayed over a copy
    ///         of the books; `passes()` alone is slot-blind.
    function canTake(uint256[] calldata ids) external view returns (bool[] memory ok) {
        ok = new bool[](ids.length);
        uint8[16] memory have = _have;
        uint256 spill = overflow;
        for (uint256 i; i < ids.length; ++i) {
            if (depositorOf[ids[i]] != address(0) || !passes(ids[i])) continue;
            if (arrangement != Arrangement.Layout) {
                ok[i] = true;
                continue;
            }
            uint256 p = _keyOf(ids[i]);
            if (have[p] >= _slots[p]) {
                if (spill >= anySlots) continue;
                ++spill;
            }
            ++have[p];
            ok[i] = true;
        }
    }

    /// @notice The layout as 80 slot values of the painted trait (0 = any); all zero when the batch has none.
    function layout() external view returns (uint8[80] memory out) {
        Filter memory f = _filter;
        for (uint256 i; i < SIZE; ++i) out[i] = uint8(_slot(f, i));
    }

    /// @notice The order the sheet takes under the layout: each painted slot gets the earliest-deposited
    ///         Credit with its value, the any slots take what is left, in deposit order. Always completable
    ///         once Full (deposits keep overflow ≤ anySlots).
    function layoutOrder() public view returns (uint256[] memory out) {
        uint256 n = _ids.length;
        out = new uint256[](n);
        bool[] memory used = new bool[](n);
        Filter memory f = _filter;
        for (uint256 i; i < n; ++i) {
            uint256 want = _slot(f, i);
            if (want == 0) continue;
            for (uint256 j; j < n; ++j) {
                if (!used[j] && keyOf[_ids[j]] == want) {
                    used[j] = true;
                    out[i] = _ids[j];
                    break;
                }
            }
        }
        uint256 k;
        for (uint256 i; i < n; ++i) {
            if (_slot(f, i) != 0) continue;
            while (used[k]) ++k;
            used[k] = true;
            out[i] = _ids[k];
        }
    }

    /// @dev Position of `value` in a '|'-separated list; 255 if absent (which no set bit can match).
    function _index(string memory value, string memory list) internal pure returns (uint256 idx) {
        bytes memory v = bytes(value);
        bytes memory l = bytes(list);
        uint256 start;
        for (uint256 i; i <= l.length; ++i) {
            if (i == l.length || l[i] == "|") {
                if (i - start == v.length) {
                    bool same = true;
                    for (uint256 j; j < v.length && same; ++j) same = l[start + j] == v[j];
                    if (same) return idx;
                }
                start = i + 1;
                ++idx;
            }
        }
        return 255;
    }

    // ---------------------------------------------------------------- assemble

    /// @notice The exact order `assemble()` hands the adapter: deposit order, sorted by Credit number, or
    ///         `layoutOrder()`. The adapter burns in this order and never reorders.
    /// @dev A MintTime batch (retired; only one opened before the retirement can hold it) sorts by number
    ///      ascending: on mainnet Credit numbers are assigned in payment order, so the two orders are identical.
    function burnOrder() public view returns (uint256[] memory out) {
        Arrangement a = arrangement;
        if (a == Arrangement.Layout) return layoutOrder();
        out = _ids;
        if (a != Arrangement.Number && a != Arrangement.NumberDesc && a != Arrangement.MintTime) return out;
        bool desc = a == Arrangement.NumberDesc;
        // Insertion sort in place; n is at most 80 and ids are distinct. Assembly only to skip bounds checks.
        assembly ("memory-safe") {
            let base := add(out, 0x20)
            let end := add(base, shl(5, mload(out)))
            for { let p := add(base, 0x20) } lt(p, end) { p := add(p, 0x20) } {
                let v := mload(p)
                let q := p
                for {} gt(q, base) { q := sub(q, 0x20) } {
                    let w := mload(sub(q, 0x20))
                    if iszero(xor(desc, gt(w, v))) { break } // asc: stop once w < v; desc: once w > v
                    mstore(q, w)
                }
                mstore(q, v)
            }
        }
    }

    /// @notice Burn the 80 into a Statement in `burnOrder()`. Anyone can call, only during the burn window
    ///         (phase Burnable); the caller pays gas.
    function assemble() external nonReentrant {
        Phase p = phase();
        if (p != Phase.Burnable) revert WrongPhase(p);
        _assemble(burnOrder());
    }

    /// @dev The assembler is fixed in the factory. It is approved as an operator for this batch's
    ///      Credits only for the duration of the call, and its work is checked afterwards: none of the 80
    ///      Credits may still exist, and this batch must own the Statement the adapter says it minted.
    ///      Its storage is its own; nothing it does can reach this contract's state.
    ///      The order is final: the adapter is always told Deposit (pass through).
    function _assemble(uint256[] memory order) internal {
        IAssembler asm = factory.assembler(); // set: phase Burnable needs an active assembler
        address st = asm.statement();
        if (st == address(0) || st == address(credits)) revert StatementNotReceived();

        for (uint256 i; i < order.length; ++i) {
            if (depositorOf[order[i]] == address(0)) revert BadOrder(); // never hand the adapter an id we do not hold
        }
        _assembling = true;
        credits.setApprovalForAll(address(asm), true);
        uint256 sid = asm.assemble(order, uint8(Arrangement.Deposit));
        credits.setApprovalForAll(address(asm), false);
        _assembling = false;

        for (uint256 i; i < SIZE; ++i) {
            try credits.ownerOf(order[i]) returns (address) {
                revert CreditsNotBurned();
            } catch {}
        }
        if (IERC721(st).ownerOf(sid) != address(this)) revert StatementNotReceived();

        statement = st;
        statementId = sid;
        assembledAt = uint64(block.timestamp);
        emit Assembled(msg.sender, st, sid, order);
    }

    // ---------------------------------------------------------------- auction

    /// @notice Smallest bid accepted right now.
    function minBid() public view returns (uint256) {
        if (highBid == 0) {
            if (block.timestamp < assembledAt + RESERVE_WINDOW && reserve > 0) return reserve;
            return MIN_RAISE; // after the reserve lapses, 0.01 ETH: a dust bid must not start the clock
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
        uint256 fee = highBid * protocolFeeBps / 10_000;
        // Equal: 80 units of one share each. Early: 12,640 units spread 237 - 2i over the positions.
        uint256 units = split == Split.Equal ? SIZE : EARLY_UNITS;
        uint256 per = (highBid - fee - creatorFee) / units;
        payoutPerUnit = per;
        fee = highBid - creatorFee - per * units; // rounding dust goes with the protocol fee
        emit Settled(highBidder, highBid, fee, creatorFee, payoutPerShare());

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

    /// @notice What one equal share pays (the average per Credit); Early positions pay 0.5–1.5× this.
    function payoutPerShare() public view returns (uint256) {
        return split == Split.Equal ? payoutPerUnit : payoutPerUnit * EARLY_MID;
    }

    /// @notice A depositor's units of the split: their share count, or, when Early, the sum of their
    ///         positions' weights (237 - 2i, i = 0..79 in deposit order).
    function unitsOf(address depositor) public view returns (uint256 units) {
        if (split == Split.Equal) return sharesOf[depositor];
        uint256 n = _ids.length;
        uint256 left = sharesOf[depositor]; // stop once all of theirs are found
        for (uint256 i; i < n && left != 0; ++i) {
            if (depositorOf[_ids[i]] == depositor) {
                units += 237 - 2 * i;
                --left;
            }
        }
    }

    function claimable(address depositor) public view returns (uint256) {
        if (!settled || claimed[depositor]) return 0;
        return unitsOf(depositor) * payoutPerUnit;
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
        s.phase = phase();
        s.lockAt = uint64(lockAt());
        s.name = name;
        s.creator = creator;
        s.count = _ids.length;
        s.deadline = uint64(burnDeadline()); // when the burn window closes; 0 when not counting down
        s.filledAt = filledAt;
        s.assembledAt = assembledAt;
        s.auctionEnd = auctionEnd;
        s.reserve = reserve;
        s.minBid = statement != address(0) && !settled ? minBid() : 0;
        s.creatorFeeBps = creatorFeeBps;
        s.protocolFeeBps = protocolFeeBps;
        s.filter = _filter;
        s.allowlistSize = allowlistSize;
        s.statement = statement;
        s.statementId = statementId;
        s.highBidder = highBidder;
        s.highBid = highBid;
        s.payoutPerShare = payoutPerShare();
        s.split = split;
    }
}
