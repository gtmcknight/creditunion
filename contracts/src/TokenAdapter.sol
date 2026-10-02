// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {ERC721} from "@openzeppelin/contracts/token/ERC721/ERC721.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC721Metadata} from "@openzeppelin/contracts/token/ERC721/extensions/IERC721Metadata.sol";
import {IERC721Receiver} from "@openzeppelin/contracts/token/ERC721/IERC721Receiver.sol";
import {Batch} from "./Batch.sol";
import {IAssembler} from "./interfaces/IAssembler.sol";
import {ICredits} from "./interfaces/ICredits.sol";
import {IStatements} from "./interfaces/IStatements.sol";
import {IStatementVault} from "./interfaces/IStatementVault.sol";
import {UnionFormats} from "./UnionFormats.sol";

/// @notice The factory's register of its Credit Unions, and where fees go.
interface ITokenUnions {
    function isBatch(address) external view returns (bool);
    function feeRecipient() external view returns (address);
}

/// @title TokenAdapter
/// @notice The burn contract for token unions: a second BatchFactory, the same Batch code, with this as its assembler.
///         When a full union burns, its 80 Credits become a Statement as usual, but the Statement goes straight into
///         the vault (IStatementVault), and the tokens it pays out are split among the members by the rating each
///         put in (their Credits' scores over the union's total), after the same protocol and creator fees a sale
///         would pay. The union's own Equal/Early split is ignored. No auction.
///
///         Scores are read while the Credits still exist: `rate` writes them down for the union's 80 as they stand
///         (anyone can call it; the site does before the burn), and the burn refuses a union whose 80 changed since.
///
///         The union checks that it owns what `statement()` names, so this contract is also that: a receipt NFT, one
///         per converted Statement, same number, drawn as the Statement (its tokenURI). The union holds the receipt
///         and opens its usual auction on it; the site doesn't show that auction, and any bid would only pay the
///         members ETH on top.
///
///         The burn only converts and books the amount (it already runs near the 16.78M gas cap). Paying out is a
///         second call anyone can make, `distribute`; a member whose transfer fails pulls with `claim`.
///         No owner, no admin, no upgrades.
contract TokenAdapter is IAssembler, IERC721Receiver, ERC721 {
    uint256 public constant SIZE = 80;
    uint8 public constant CONSOLIDATED = 1;

    ICredits public immutable credits;
    IStatements public immutable statements;
    ITokenUnions public immutable factory;
    UnionFormats public immutable formats;
    IStatementVault public immutable vault;
    IERC20 public immutable token;

    struct Conversion {
        uint256 statementId;
        uint256 amount; // tokens the vault paid for it
        uint256 net; // what the members split, after fees
        uint256 protocolFee;
        uint256 creatorFee;
        bool protocolPaid;
        bool creatorPaid;
    }

    /// @dev Each union's 80 scores as rated, in deposit order, sixteen uint16s to a word, and which 80 they were.
    struct Rating {
        bytes32 idsHash;
        uint256 total;
        uint256[5] packed;
    }

    mapping(address union => Conversion) public conversionOf;
    mapping(address union => Rating) internal _rating;
    mapping(address union => mapping(address member => bool)) public claimed;

    event Rated(address indexed union, uint256 total);
    event Converted(address indexed union, uint256 indexed statementId, uint256 amount, uint256 net);
    event Paid(address indexed union, address indexed to, uint256 amount);
    event Unpaid(address indexed union, address indexed to, uint256 amount);

    error NotAUnion();
    error NotEighty();
    error WrongCredits();
    error WrongFormats();
    error NothingPaid();
    error NotRated();
    error NotConverted();
    error NothingToClaim();
    error PaymentFailed();
    error NotAStatement();

    constructor(ICredits credits_, IStatements statements_, ITokenUnions factory_, UnionFormats formats_, IStatementVault vault_)
        ERC721("Converted Statement", "CONVERTED")
    {
        if (statements_.credits() != credits_) revert WrongCredits();
        if (address(formats_).code.length == 0 || address(formats_.factory()) != address(factory_)) revert WrongFormats();
        credits = credits_;
        statements = statements_;
        factory = factory_;
        formats = formats_;
        vault = vault_;
        token = vault_.token();
        credits_.setApprovalForAll(address(statements_), true); // compose burns the Credits this holds
        statements_.setApprovalForAll(address(vault_), true); // the vault takes each Statement as it's made
    }

    /// @notice What a token union holds after its burn: the receipt (this contract).
    function statement() external view returns (address) {
        return address(this);
    }

    /// @inheritdoc IAssembler
    /// @dev Only the factory's unions. Cell i of the Statement is ids[i] (Batch.burnOrder()). Picture spot memory
    ///      (StatementAdapter.record) isn't carried over yet: a picture burns in its layout order.
    function assemble(uint256[] calldata ids, uint8) external returns (uint256 statementId) {
        if (!factory.isBatch(msg.sender)) revert NotAUnion();
        if (ids.length != SIZE) revert NotEighty();
        if (_rating[msg.sender].idsHash != keccak256(abi.encode(Batch(msg.sender).ids()))) revert NotRated();
        uint256[80] memory cells;
        for (uint256 i; i < SIZE; ++i) {
            credits.transferFrom(msg.sender, address(this), ids[i]);
            cells[i] = ids[i];
        }
        statementId = statements.compose(cells, formatOf(msg.sender), address(this));

        uint256 before = token.balanceOf(address(this));
        vault.deposit(statementId);
        uint256 amount = token.balanceOf(address(this)) - before;
        if (amount == 0) revert NothingPaid();

        Batch b = Batch(msg.sender);
        uint256 creatorFee = amount * b.creatorFeeBps() / 10_000;
        uint256 fee = amount * b.protocolFeeBps() / 10_000;
        uint256 net = amount - fee - creatorFee;
        conversionOf[msg.sender] = Conversion(statementId, amount, net, fee, creatorFee, false, false);
        emit Converted(msg.sender, statementId, amount, net);

        _mint(msg.sender, statementId); // the receipt the union checks for
    }

    /// @notice The format a union burns in: its creator's pick (UnionFormats) when the Statements contract has it,
    ///         otherwise Consolidated for a picture (every slot painted in Colors) and Issued for everything else.
    function formatOf(address union) public view returns (uint8) {
        try formats.pickOf(union) returns (bool picked, uint8 format) {
            if (picked && format < statements.formatCount()) return format;
        } catch {}
        return _isPicture(union) && CONSOLIDATED < statements.formatCount() ? CONSOLIDATED : 0;
    }

    function _isPicture(address union) internal view returns (bool) {
        Batch b = Batch(union);
        if (b.arrangement() != Batch.Arrangement.Layout) return false;
        Batch.Filter memory f = b.filter();
        if (f.layoutTrait != 0) return false;
        for (uint256 i; i < SIZE; ++i) {
            uint256 v = i < 64 ? (f.layout0 >> (4 * i)) & 15 : (uint256(f.layout1) >> (4 * (i - 64))) & 15;
            if (v == 0) return false;
        }
        return true;
    }

    // ---------------------------------------------------------------- ratings

    /// @notice Write down the score of each of a full union's 80 Credits, from the score table it opened with, so
    ///         the burn can pay by rating once the Credits are gone. Anyone can call it, again whenever its 80
    ///         change. A union with no table counts every Credit the same.
    function rate(address union) external {
        if (!factory.isBatch(union)) revert NotAUnion();
        uint256[] memory ids = Batch(union).ids();
        if (ids.length != SIZE) revert NotEighty();
        Rating storage r = _rating[union];
        uint256[5] memory packed;
        uint256 total;
        address table = address(Batch(union).ratings());
        for (uint256 i; i < SIZE; ++i) {
            uint256 sc = table == address(0) ? 1 : Batch(union).ratings().scoreOf(ids[i]);
            total += sc;
            packed[i >> 4] |= sc << (16 * (i & 15));
        }
        r.idsHash = keccak256(abi.encode(ids));
        r.total = total;
        r.packed = packed;
        emit Rated(union, total);
    }

    /// @notice Whether a union's current 80 are rated, so it can burn.
    function rated(address union) external view returns (bool) {
        return _rating[union].idsHash != bytes32(0) && _rating[union].idsHash == keccak256(abi.encode(Batch(union).ids()));
    }

    /// @notice The rating a member put in, and the union's total, as written down by `rate`. A union whose Credits
    ///         all scored 0 counts each Credit as 1.
    function ratingOf(address union, address member) public view returns (uint256 mine, uint256 total) {
        Rating storage r = _rating[union];
        (uint256[] memory ids, address[] memory who) = Batch(union).slots();
        bool flat = r.total == 0;
        total = flat ? ids.length : r.total;
        for (uint256 i; i < ids.length && i < SIZE; ++i) {
            if (who[i] != member) continue;
            mine += flat ? 1 : (r.packed[i >> 4] >> (16 * (i & 15))) & 0xffff;
        }
    }

    // ---------------------------------------------------------------- payouts

    /// @notice Tokens a member of `union` is owed and hasn't been paid: their share of the rating, of what's left
    ///         after fees.
    function claimable(address union, address member) public view returns (uint256) {
        Conversion storage c = conversionOf[union];
        if (c.amount == 0 || claimed[union][member]) return 0;
        (uint256 mine, uint256 total) = ratingOf(union, member);
        return c.net * mine / total;
    }

    /// @notice Pays the fees and every member of `union` their tokens. Anyone can call it, as often as they like; a
    ///         transfer that fails leaves that member's tokens for `claim`.
    function distribute(address union) external {
        Conversion storage c = conversionOf[union];
        if (c.amount == 0) revert NotConverted();
        if (!c.protocolPaid) c.protocolPaid = _pay(union, factory.feeRecipient(), c.protocolFee);
        if (!c.creatorPaid) c.creatorPaid = _pay(union, Batch(union).creator(), c.creatorFee);
        // One pass over the 80: each member's rating added up, then one payment each.
        Rating storage r = _rating[union];
        (, address[] memory who) = Batch(union).slots();
        uint256[5] memory packed = r.packed;
        bool flat = r.total == 0;
        uint256 total = flat ? who.length : r.total;
        address[] memory members = new address[](who.length);
        uint256[] memory put = new uint256[](who.length);
        uint256 n;
        for (uint256 i; i < who.length && i < SIZE; ++i) {
            uint256 j;
            while (j < n && members[j] != who[i]) ++j;
            if (j == n) members[n++] = who[i];
            put[j] += flat ? 1 : (packed[i >> 4] >> (16 * (i & 15))) & 0xffff;
        }
        for (uint256 j; j < n; ++j) {
            address m = members[j];
            if (claimed[union][m]) continue;
            claimed[union][m] = true;
            if (!_pay(union, m, c.net * put[j] / total)) claimed[union][m] = false;
        }
    }

    /// @notice Pays one member their tokens. Anyone can call it for anyone.
    function claim(address union, address member) external {
        uint256 amount = claimable(union, member);
        if (amount == 0) revert NothingToClaim();
        claimed[union][member] = true;
        if (!_pay(union, member, amount)) revert PaymentFailed();
    }

    /// @dev A token transfer that never reverts the caller: false when the token refuses or returns false.
    function _pay(address union, address to, uint256 amount) internal returns (bool ok) {
        if (amount == 0) return true;
        bytes memory ret;
        (ok, ret) = address(token).call(abi.encodeCall(IERC20.transfer, (to, amount)));
        ok = ok && (ret.length == 0 || abi.decode(ret, (bool)));
        if (ok) emit Paid(union, to, amount);
        else emit Unpaid(union, to, amount);
    }

    // ---------------------------------------------------------------- receipt

    /// @dev The Statements contract checks its receiver when it mints a burn's Statement here. Everything else is
    ///      refused, so a Credit or stray NFT sent with safeTransferFrom bounces instead of getting stuck.
    function onERC721Received(address, address, uint256, bytes calldata) external view returns (bytes4) {
        if (msg.sender != address(statements)) revert NotAStatement();
        return this.onERC721Received.selector;
    }

    /// @notice The receipt draws as the Statement it stands for (now in the vault).
    function tokenURI(uint256 id) public view override returns (string memory) {
        _requireOwned(id);
        return IERC721Metadata(address(statements)).tokenURI(id);
    }
}
