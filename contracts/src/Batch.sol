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
    function exitWindowOpen() external view returns (bool);
    function pendingUntil() external view returns (uint64);
    function feeRecipient() external view returns (address);
    function isBatch(address) external view returns (bool);
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
    uint256 public constant MAX_PROTOCOL_FEE_BPS = 500; // 5%
    uint256 public constant FILL_GRACE = 7 days; // a batch that fills always has at least this long to assemble
    uint256 public constant RESERVE_WINDOW = 7 days; // with no bid by then, the reserve no longer applies
    uint256 public constant AUCTION_LENGTH = 24 hours;
    uint256 public constant EXTENSION = 15 minutes;
    uint256 public constant MIN_RAISE_BPS = 500; // 5%
    uint256 public constant MIN_RAISE = 0.01 ether;
    uint256 public constant REFUND_GAS = 50_000;
    uint256 public constant MAX_NAME = 64;
    uint256 public constant MAX_ALLOWLIST = 200;
    uint256 public constant CREATOR_ORDER_GRACE = 1 days; // then anyone burns in deposit order

    /// @notice How the 80 are ordered on the Statement. Fixed when the batch opens; shown before depositing.
    ///         Deposit: as deposited. MintTime / Number: sorted by the adapter. Creator: the creator supplies
    ///         the order at burn time, within CREATOR_ORDER_GRACE of filling; after that, deposit order.
    enum Arrangement {
        Deposit,
        MintTime,
        Number,
        Creator,
        Layout // the sheet follows a palette layout painted when the batch was designed (Filter.layout0/1)
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
    // Layout bookkeeping: how many slots want each palette mask, how many Credits of each are in, how many
    // "any" slots exist, and how many Credits are already spilling into them. The batch stays fillable as
    // long as overflow ≤ anySlots (then every painted slot can be matched and the rest take the any slots).
    uint8[16] internal _slots;
    uint8[16] internal _have;
    uint8 internal anySlots;
    uint8 internal overflow;
    /// @notice The palette mask of a deposited Credit (layout batches only), C=1 M=2 Y=4 K=8.
    mapping(uint256 => uint8) public paletteOf;
    /// @notice When non-empty, only these Credits may join.
    uint256 public allowlistSize;
    mapping(uint256 id => bool) public allowed;
    uint256 public reserve;
    /// @notice The split this batch opened with. Later changes on the factory never reach it.
    uint256 public creatorFeeBps;
    uint256 public protocolFeeBps;
    Arrangement public arrangement;
    Split public split;
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
    /// @notice Wei per unit of the split (a unit is one share when Equal, 1/158 of a share when Early).
    uint256 public payoutPerUnit;
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
    error AssemblerNotReady();
    error NotCreator();
    error CreatorsTurn();
    error BadOrder();
    error NoSlot(uint256 id);
    error LayoutMismatch(uint256 slot);

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
        if ((filter_.minScore != 0 || filter_.maxScore != 0) && address(IBatchFactory(msg.sender).ratings()) == address(0)) {
            revert BadFilter();
        }
        bool hasLayout = filter_.layout0 != 0 || filter_.layout1 != 0;
        if (hasLayout != (arrangement_ == Arrangement.Layout)) revert BadFilter();
        if (hasLayout) {
            Filter memory lf = filter_;
            for (uint256 i; i < SIZE; ++i) {
                uint256 p = _slot(lf, i);
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
            uint256 p = _paletteOf(id);
            if (_have[p] >= _slots[p]) {
                if (overflow >= anySlots) revert NoSlot(id); // no painted slot left for this palette, no any slot free
                ++overflow;
            }
            ++_have[p];
            paletteOf[id] = uint8(p);
        }
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
            if (arrangement == Arrangement.Layout) {
                uint256 p = paletteOf[id];
                if (_have[p] > _slots[p]) --overflow;
                --_have[p];
                delete paletteOf[id];
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
        if (f.palettes == 0 && f.prints == 0 && f.weights == 0 && f.eights == 0) return true;
        ICreditArt.Read memory r = art.describe(credits.seedOf(id), credits.timestampOf(id));
        if (f.palettes != 0 && f.palettes & (1 << _paletteMask(r.colors)) == 0) return false;
        if (f.prints != 0 && f.prints & (1 << _index(r.register, PRINTS)) == 0) return false;
        if (f.weights != 0 && f.weights & (1 << _index(r.weight, WEIGHTS)) == 0) return false;
        if (f.eights != 0 && (r.eights > 31 || f.eights & (1 << r.eights) == 0)) return false;
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

    function _paletteOf(uint256 id) internal view returns (uint256) {
        return _paletteMask(art.describe(credits.seedOf(id), credits.timestampOf(id)).colors);
    }

    /// @dev Palette wanted at layout slot `i` (0 = any).
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
            uint256 p = _paletteOf(ids[i]);
            if (have[p] >= _slots[p]) {
                if (spill >= anySlots) continue;
                ++spill;
            }
            ++have[p];
            ok[i] = true;
        }
    }

    /// @notice The layout as 80 palette masks (0 = any); all zero when the batch has none.
    function layout() external view returns (uint8[80] memory out) {
        Filter memory f = _filter;
        for (uint256 i; i < SIZE; ++i) out[i] = uint8(_slot(f, i));
    }

    /// @notice The order the sheet takes under the layout: each painted slot gets the earliest-deposited
    ///         Credit of its palette, the any slots take what is left, in deposit order. Always completable
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
                if (!used[j] && paletteOf[_ids[j]] == want) {
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

    /// @notice Burn the 80 into a Statement with the batch's arrangement. Anyone can call once Full; the
    ///         caller pays gas. With the Creator arrangement, only after the creator's grace has passed.
    function assemble() external nonReentrant {
        _require(State.Full);
        if (arrangement == Arrangement.Creator || arrangement == Arrangement.Layout) {
            // The creator's day starts when assembly first became possible: at fill, or, for a batch that filled
            // during the staged launch, when the assembler was activated.
            uint256 active = factory.assemblerActiveAt();
            uint256 since = active > filledAt ? active : filledAt;
            if (block.timestamp < since + CREATOR_ORDER_GRACE) revert CreatorsTurn();
        }
        if (arrangement == Arrangement.Layout) return _assemble(layoutOrder(), Arrangement.Deposit);
        _assemble(_ids, arrangement == Arrangement.Creator ? Arrangement.Deposit : arrangement);
    }

    /// @notice Creator arrangement only: the creator burns with a hand-made order (a permutation of the 80).
    function assembleOrdered(uint256[] calldata order) external nonReentrant {
        _require(State.Full);
        if (arrangement != Arrangement.Creator && arrangement != Arrangement.Layout) revert BadOrder();
        if (msg.sender != creator) revert NotCreator();
        if (order.length != SIZE) revert BadOrder();
        Filter memory f = _filter;
        for (uint256 i; i < SIZE; ++i) {
            if (depositorOf[order[i]] == address(0)) revert BadOrder();
            for (uint256 j; j < i; ++j) {
                if (order[j] == order[i]) revert BadOrder();
            }
            // Under a layout the creator may only reshuffle within a palette: every painted slot keeps its colour.
            if (arrangement == Arrangement.Layout) {
                uint256 want = _slot(f, i);
                if (want != 0 && paletteOf[order[i]] != want) revert LayoutMismatch(i);
            }
        }
        _assemble(order, Arrangement.Deposit);
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

        for (uint256 i; i < ids.length; ++i) {
            if (depositorOf[ids[i]] == address(0)) revert BadOrder(); // never hand the adapter an id we do not hold
        }
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
