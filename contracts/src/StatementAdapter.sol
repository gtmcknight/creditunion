// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {IERC721} from "@openzeppelin/contracts/token/ERC721/IERC721.sol";
import {IERC721Receiver} from "@openzeppelin/contracts/token/ERC721/IERC721Receiver.sol";
import {Batch} from "./Batch.sol";
import {IAssembler} from "./interfaces/IAssembler.sol";
import {ICredits} from "./interfaces/ICredits.sol";
import {IStatements} from "./interfaces/IStatements.sol";
import {UnionFormats} from "./UnionFormats.sol";

/// @notice The factory's register of its Credit Unions, and where lost-and-found goes.
interface IUnions {
    function isBatch(address) external view returns (bool);
    function feeRecipient() external view returns (address);
}

// True only once the adapter has passed the mainnet fork test against Jack's deployed, verified contract.
// The deploy script refuses mainnet while it's false.
bool constant ADAPTER_READY = true;

/// Burns through the Statements contract given at deploy (`statements`), after a mainnet fork test against it.
/// Until an adapter is switched on in the factory, no Credit Union can lock or burn.
/// @title StatementAdapter
/// @notice Turns a full Credit Union's 80 Credits into one Statement, in the format its creator chose: by default
///         Consolidated for a picture (the site previews pictures that way) and Issued for everything else.
///         During its burn hour the union calls `assemble` with the 80 in their final order, having approved this
///         contract as an operator for that one call. Jack's `compose` burns only the caller's own Credits, so the
///         adapter takes the 80 in and composes with the union as the recipient. The union then checks that all
///         80 are gone and that it owns the Statement. No owner, no admin, no upgrades.
///         A picture's Credits keep their spots once recorded (`record`): if one leaves, only its own spot opens.
contract StatementAdapter is IAssembler, IERC721Receiver {
    /// @notice ADAPTER_READY, readable on chain.
    bool public constant READY = ADAPTER_READY;
    uint256 public constant SIZE = 80;

    ICredits public immutable credits;
    IStatements public immutable statements;
    IUnions public immutable factory;
    /// @notice Where each union's creator picks its format.
    UnionFormats public immutable formats;

    /// @notice Where a picture's 80 Credits fill the page edge to edge, so it reads as the picture the site previews.
    ///         Jack's list only grows, so its index stays 1; formatOf checks the name all the same.
    uint8 public constant CONSOLIDATED = 1;

    /// @notice Where each picture union's Credits sit, as last recorded: spot i holds a Credit's number (0 = open),
    ///         eight uint32s to a word.
    mapping(address => uint256[10]) internal _spots;

    event Rescued(address indexed token, uint256 indexed id, address to);
    event SpotsRecorded(address indexed union);

    error NotAUnion();
    error NotAPicture();
    error NotEighty();
    error NotAStatement();
    error WrongCredits();
    error WrongFormats();

    constructor(ICredits credits_, IStatements statements_, IUnions factory_, UnionFormats formats_) {
        if (statements_.credits() != credits_) revert WrongCredits(); // a Statements for other Credits burns nothing of ours
        if (address(formats_).code.length == 0 || address(formats_.factory()) != address(factory_)) revert WrongFormats();
        credits = credits_;
        statements = statements_;
        factory = factory_;
        formats = formats_;
        credits_.setApprovalForAll(address(statements_), true); // compose burns the Credits the adapter holds
    }

    function statement() external view returns (address) {
        return address(statements);
    }

    /// @notice The format a union burns in, an index into Jack's format list: its creator's pick (UnionFormats) when
    ///         his list has it, otherwise Consolidated for a picture and Issued (0) for everything else. A pick that
    ///         can't be read never stops a burn: the union burns in its default.
    function formatOf(address union) public view returns (uint8) {
        return _formatOf(union, isPicture(union));
    }

    function _formatOf(address union, bool picture) internal view returns (uint8) {
        try formats.pickOf(union) returns (bool picked, uint8 format) {
            if (picked && format < statements.formatCount()) return format;
        } catch {}
        return picture && _named(CONSOLIDATED, "Consolidated") ? CONSOLIDATED : 0;
    }

    /// @notice A picture: a layout painted in colors with every one of its 80 slots painted. Every union made from
    ///         a picture is one, and the site previews each of them in Consolidated.
    function isPicture(address union) public view returns (bool picture) {
        (picture,) = _layoutOf(union);
    }

    /// @dev Whether `union` is a picture and, if so, the Colors each spot takes (a CMYK mask, never 0): its
    ///      layout, read from the filter as Batch.layout() reads it.
    function _layoutOf(address union) internal view returns (bool picture, uint8[80] memory want) {
        Batch b = Batch(union);
        if (b.arrangement() != Batch.Arrangement.Layout) return (false, want);
        Batch.Filter memory f = b.filter();
        if (f.layoutTrait != 0) return (false, want);
        for (uint256 i; i < SIZE; ++i) {
            uint256 v = i < 64 ? (f.layout0 >> (4 * i)) & 15 : (uint256(f.layout1) >> (4 * (i - 64))) & 15;
            if (v == 0) return (false, want);
            want[i] = uint8(v);
        }
        picture = true;
    }

    function _named(uint8 format, string memory name) internal view returns (bool) {
        return format < statements.formatCount() && keccak256(bytes(statements.formatName(format))) == keccak256(bytes(name));
    }

    /// @inheritdoc IAssembler
    /// @dev Only the factory's unions. Cell i of the Statement is ids[i] (Batch.burnOrder()), except in a picture
    ///      with recorded spots, where the same 80 go where `orderOf` says.
    function assemble(uint256[] calldata ids, uint8) external returns (uint256 statementId) {
        if (!factory.isBatch(msg.sender)) revert NotAUnion();
        if (ids.length != SIZE) revert NotEighty();
        for (uint256 i; i < SIZE; ++i) credits.transferFrom(msg.sender, address(this), ids[i]);
        (bool picture, uint8[80] memory want) = _layoutOf(msg.sender);
        statementId = statements.compose(_cells(msg.sender, ids, picture, want), _formatOf(msg.sender, picture), msg.sender); // minted straight to the union
    }

    // ---------------------------------------------------------------- spots

    /// @notice Write down where each Credit in a picture union sits, so it keeps that spot. Without this a leave
    ///         slides every later Credit of the leaver's Colors back one spot (the union's own layout order); with
    ///         it, only the leaver's spot opens, and the next Credit of that Colors fills it. Anyone can call it and
    ///         it only ever writes `orderOf`; the site's keeper calls it after deposits.
    function record(address union) external {
        if (!factory.isBatch(union)) revert NotAUnion();
        uint256[80] memory order = orderOf(union);
        uint256[10] memory packed;
        for (uint256 s; s < SIZE; ++s) {
            if (order[s] <= type(uint32).max) packed[s >> 3] |= order[s] << (32 * (s & 7)); // every Credit's number fits
        }
        _spots[union] = packed;
        emit SpotsRecorded(union);
    }

    /// @notice Where each Credit in a picture union sits now, spot by spot (0 = open): recorded Credits still in
    ///         keep their spots, and the rest, in the order they went in, take the first open spot of their Colors.
    ///         With nothing recorded that's the union's own layout order. A full picture burns in exactly this order.
    function orderOf(address union) public view returns (uint256[80] memory out) {
        (bool picture, uint8[80] memory want) = _layoutOf(union);
        if (!picture) revert NotAPicture();
        Batch b = Batch(union);
        uint256[] memory ids = b.ids();
        uint256[256] memory at = _index(ids);
        uint256[10] memory packed = _spots[union];
        bool[] memory placed = new bool[](ids.length);
        for (uint256 s; s < SIZE; ++s) {
            uint256 id = uint32(packed[s >> 3] >> (32 * (s & 7)));
            if (id == 0) continue;
            uint256 j = _find(at, ids, id);
            if (j == ids.length || placed[j]) continue; // it left since
            placed[j] = true;
            out[s] = id;
        }
        uint256[16] memory next; // per Colors, the first spot that may still be open
        for (uint256 j; j < ids.length; ++j) {
            if (placed[j]) continue;
            uint256 colors = b.keyOf(ids[j]);
            uint256 s = next[colors];
            while (s < SIZE && (out[s] != 0 || want[s] != colors)) ++s;
            if (s == SIZE) continue; // can't happen: a union never holds more Credits of a Colors than its spots
            out[s] = ids[j];
            next[colors] = s + 1;
        }
    }

    /// @dev Where each of `ids` is, for `_find`: open addressing, 256 buckets for at most 80 Credits, j + 1 in each.
    function _index(uint256[] memory ids) private pure returns (uint256[256] memory at) {
        for (uint256 j; j < ids.length; ++j) {
            uint256 h = _bucket(ids[j]);
            while (at[h] != 0) h = (h + 1) & 255;
            at[h] = j + 1;
        }
    }

    /// @dev Where `id` is in `ids`, as indexed by `_index`; ids.length when it isn't there.
    function _find(uint256[256] memory at, uint256[] memory ids, uint256 id) private pure returns (uint256) {
        for (uint256 h = _bucket(id); at[h] != 0; h = (h + 1) & 255) {
            if (ids[at[h] - 1] == id) return at[h] - 1;
        }
        return ids.length;
    }

    function _bucket(uint256 id) private pure returns (uint256) {
        return ((id & type(uint32).max) * 0x9E3779B1 >> 16) & 255;
    }

    /// @notice The spots as last recorded (0 = open, or never recorded).
    function spotsOf(address union) public view returns (uint256[80] memory out) {
        uint256[10] memory packed = _spots[union];
        for (uint256 s; s < SIZE; ++s) out[s] = uint32(packed[s >> 3] >> (32 * (s & 7)));
    }

    /// @dev The burn's cells: `orderOf`, worked out from `ids` alone so it can only ever be those 80, each in a spot
    ///      of its own Colors. `ids` is the layout order, which puts every Credit in a spot of its Colors (so want[j]
    ///      is ids[j]'s Colors) and each Colors' Credits in the order they went in. Recorded Credits take their
    ///      spots, every other spot the next Credit of its Colors. Not a picture, nothing recorded, or anything
    ///      unexpected: `ids` as given.
    function _cells(address union, uint256[] calldata ids, bool picture, uint8[80] memory want)
        internal
        view
        returns (uint256[80] memory cells)
    {
        for (uint256 i; i < SIZE; ++i) cells[i] = ids[i];
        if (!picture) return cells;
        uint256[10] memory packed = _spots[union];
        uint256 any;
        for (uint256 w; w < 10; ++w) any |= packed[w];
        if (any == 0) return cells;

        uint256[] memory list = ids;
        uint256[256] memory at; // built only once some Credit isn't at its spot in the layout order
        bool built;
        uint256[80] memory out;
        bool[80] memory used;
        uint256 open;
        for (uint256 s; s < SIZE; ++s) {
            uint256 id = uint32(packed[s >> 3] >> (32 * (s & 7)));
            uint256 j = s;
            if (id != 0 && list[s] != id) {
                if (!built) (at, built) = (_index(list), true);
                j = _find(at, list, id);
            }
            if (id != 0 && j < SIZE && !used[j] && want[j] == want[s]) {
                used[j] = true;
                out[s] = id;
            } else {
                ++open;
            }
        }
        if (open == 0) return out;
        // Every other spot takes the next unused Credit of its Colors in the layout order: chain each position to
        // the next of the same Colors.
        uint256[16] memory first;
        uint256[80] memory then;
        for (uint256 c; c < 16; ++c) first[c] = SIZE;
        for (uint256 j = SIZE; j > 0; --j) {
            uint256 c = want[j - 1];
            then[j - 1] = first[c];
            first[c] = j - 1;
        }
        for (uint256 s; s < SIZE; ++s) {
            if (out[s] != 0) continue;
            uint256 c = want[s];
            uint256 j = first[c];
            while (j < SIZE && used[j]) j = then[j];
            if (j == SIZE) return cells; // can't happen: a full picture has as many Credits of each Colors as spots
            used[j] = true;
            out[s] = list[j];
            first[c] = then[j];
        }
        return out;
    }

    /// @notice The adapter holds nothing between burns, so any NFT here was sent by mistake (plain `transferFrom`
    ///         fires no hook). Anyone can forward it to the factory's fee recipient as lost-and-found, as a union's
    ///         `rescue` does. Nothing can reach this mid-burn: Credits and Statements call no one back.
    function rescue(IERC721 token, uint256 id) external {
        address to = factory.feeRecipient();
        token.transferFrom(address(this), to, id);
        emit Rescued(address(token), id, to);
    }

    /// @dev Jack's contract mints with `_mint`, so this never runs for it. It refuses everything else, so a
    ///      Credit sent here with safeTransferFrom bounces instead of getting stuck.
    function onERC721Received(address, address, uint256, bytes calldata) external view returns (bytes4) {
        if (msg.sender != address(statements)) revert NotAStatement();
        return this.onERC721Received.selector;
    }
}
