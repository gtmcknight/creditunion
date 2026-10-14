// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Clones} from "@openzeppelin/contracts/proxy/Clones.sol";
import {ERC721} from "@openzeppelin/contracts/token/ERC721/ERC721.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC721Metadata} from "@openzeppelin/contracts/token/ERC721/extensions/IERC721Metadata.sol";
import {Batch, IRatings} from "./Batch.sol";
import {IAssembler} from "./interfaces/IAssembler.sol";
import {ICredits} from "./interfaces/ICredits.sol";
import {IStatements} from "./interfaces/IStatements.sol";
import {IStatementVault} from "./interfaces/IStatementVault.sol";
import {TokenPocket} from "./TokenPocket.sol";
import {UnionFormats} from "./UnionFormats.sol";

/// @notice The factory's register of its Credit Unions, and where fees go.
interface ITokenUnions {
    function isBatch(address) external view returns (bool);
    function feeRecipient() external view returns (address);
}

/// @title TokenAdapter
/// @notice The burn contract for token unions: a second BatchFactory, the same Batch code, with this as its assembler.
///         A full union locks the moment its 80th Credit lands (`lockDelay` is 0) and can burn at once. When it
///         burns, its 80 Credits become a Statement as usual, but the Statement is surrendered straight to the vault
///         (IStatementVault, which is the token itself), and the tokens it pays out are split among the members by the rating each
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
///         Each union converts in a wallet of its own (TokenPocket, cloned at the burn, `pocketOf`): the Statement is
///         minted there, the vault pays there, and every payout leaves from there. The token carries its Statement's
///         colors and mixes them in whatever wallet holds it, so one shared wallet would blend one union's colors into
///         the next; a pocket per union keeps one union's colors out of every other's. Tokens anyone sent to a pocket
///         before its burn are passed to the fee recipient before the vault pays, so they can't tint it; between the
///         burn and the payout a pocket is a wallet like any other.
///
///         The burn only converts and books the amount (it already runs near the 16.78M gas cap). Paying out is a
///         second call anyone can make, `distribute`, or `distributeNext` in parts when the token's transfers cost too
///         much to pay every member in one transaction; a member whose transfer fails pulls with `claim`. While the
///         token can't move yet (a launch lock), every payout fails softly: fees stay unpaid and members stay owed
///         (`claimable`) until a later call, once it opens.
///         No owner, no admin, no upgrades.
contract TokenAdapter is IAssembler, ERC721 {
    uint256 public constant SIZE = 80;
    uint8 public constant CONSOLIDATED = 1;

    /// @dev Gas each paid-out transfer gets, and what must be left before one is tried. A payout that would run short
    ///      reverts the whole call instead of skipping someone, so a wallet's gas estimate always covers every payment
    ///      (Batch.settle works the same way). `claim` sends without the cap.
    uint256 internal constant TRANSFER_GAS = 1_000_000;
    uint256 internal constant PAY_GAS = TRANSFER_GAS * 64 / 63 + 10_000;

    ICredits public immutable credits;
    IStatements public immutable statements;
    ITokenUnions public immutable factory;
    UnionFormats public immutable formats;
    IStatementVault public immutable vault;
    IERC20 public immutable token;
    /// @notice What every union's pocket is a clone of.
    address public immutable pocketImplementation;
    /// @notice The wallet each converted union converted in and pays out from.
    mapping(address union => address) public pocketOf;

    struct Conversion {
        uint256 statementId;
        uint256 amount; // tokens the vault paid for it
        uint256 net; // what the members split, after fees
        uint256 protocolFee;
        uint256 creatorFee;
        bool protocolPaid;
        bool creatorPaid;
    }

    /// @dev Which 80 a union was rated with, and their total rating.
    struct Rating {
        bytes32 idsHash;
        uint256 total;
    }

    mapping(address union => Conversion) public conversionOf;
    mapping(address union => Rating) internal _rating;
    /// @notice The rating each member put in, written down once by `rate`, so a claim reads one number instead of
    ///         the union's 80 slots. A union whose Credits all scored 0 counts each Credit as 1.
    mapping(address union => mapping(address member => uint256)) public putIn;
    /// @dev Each union's members as rated, once each, in the order they joined: who `distribute` pays.
    mapping(address union => address[]) internal _members;
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
    error PayoutGasTooLow();
    error AlreadyConverted();
    error NobodyPaid();

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
        token = IERC20(address(vault_)); // the vault is the token
        pocketImplementation = address(new TokenPocket(statements_, vault_, token));
        credits_.setApprovalForAll(address(statements_), true); // compose burns the Credits this holds
    }


    /// @notice What a token union holds after its burn: the receipt (this contract).
    function statement() external view returns (address) {
        return address(this);
    }

    /// @notice How long a full union waits before it locks and can burn: not at all. Each Batch asks its assembler
    ///         (and waits its own LOCK_DELAY when there's no answer), so a token union converts the moment it fills.
    function lockDelay() external pure returns (uint256) {
        return 0;
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
        // The union's own wallet: the Statement is minted into it and converts there.
        address pocket = Clones.cloneDeterministic(pocketImplementation, bytes32(uint256(uint160(msg.sender))));
        pocketOf[msg.sender] = pocket;
        statementId = statements.compose(cells, formatOf(msg.sender), pocket);
        uint256 amount = TokenPocket(pocket).convert(statementId, factory.feeRecipient());
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

    /// @notice Write down what each member of a full union put in, by the score table it opened with, so the burn can
    ///         pay by rating once the Credits are gone. Anyone can call it, again whenever its 80 change, until it
    ///         converts. A union with no table, or whose Credits all scored 0, counts every Credit the same.
    function rate(address union) external {
        if (!factory.isBatch(union)) revert NotAUnion();
        if (conversionOf[union].amount != 0) revert AlreadyConverted(); // shares are final once the tokens exist
        (uint256[] memory ids, address[] memory who) = Batch(union).slots();
        if (ids.length != SIZE) revert NotEighty();
        // Re-rated after its 80 changed: the last rating's members start over.
        address[] storage was = _members[union];
        for (uint256 k; k < was.length; ++k) delete putIn[union][was[k]];
        delete _members[union];

        address table = address(Batch(union).ratings());
        address[] memory members = new address[](SIZE);
        uint256[] memory put = new uint256[](SIZE);
        uint256[] memory count = new uint256[](SIZE);
        uint256 n;
        uint256 total;
        for (uint256 i; i < SIZE; ++i) {
            uint256 sc = table == address(0) ? 1 : IRatings(table).scoreOf(ids[i]);
            total += sc;
            uint256 j;
            while (j < n && members[j] != who[i]) ++j;
            if (j == n) members[n++] = who[i];
            put[j] += sc;
            ++count[j];
        }
        bool flat = total == 0;
        for (uint256 j; j < n; ++j) {
            _members[union].push(members[j]);
            putIn[union][members[j]] = flat ? count[j] : put[j];
        }
        Rating storage r = _rating[union];
        r.idsHash = keccak256(abi.encode(ids));
        r.total = flat ? SIZE : total;
        emit Rated(union, r.total);
    }

    /// @notice Whether a union's current 80 are rated, so it can burn.
    function rated(address union) external view returns (bool) {
        return _rating[union].idsHash != bytes32(0) && _rating[union].idsHash == keccak256(abi.encode(Batch(union).ids()));
    }

    /// @notice The rating a member put in, and the union's total, as written down by `rate`.
    function ratingOf(address union, address member) public view returns (uint256 mine, uint256 total) {
        return (putIn[union][member], _rating[union].total);
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
        _distribute(union, SIZE);
    }

    /// @notice `distribute` in parts, for a token whose transfers cost too much to pay every member in one
    ///         transaction: pays the fees and the next `count` members not yet paid, in the order they joined. Call it
    ///         again for the rest. A member whose transfer fails counts toward `count` and is tried again next time.
    function distributeNext(address union, uint256 count) external {
        _distribute(union, count);
    }

    /// @notice Pays the fees and the listed members of `union` not yet paid; anyone listed who put nothing in is
    ///         skipped. For a keeper that sends tokens only where it's worth the gas and leaves the rest to `claim`.
    function distributeTo(address union, address[] calldata who) external {
        (Conversion storage c,,) = _payFees(union);
        uint256 total = _rating[union].total;
        for (uint256 j; j < who.length; ++j) {
            address m = who[j];
            uint256 put = putIn[union][m];
            if (put == 0 || claimed[union][m]) continue;
            claimed[union][m] = true;
            if (!_pay(union, m, c.net * put / total, true)) claimed[union][m] = false;
        }
    }

    /// @notice A union's members as rated, once each, in the order they joined.
    function membersOf(address union) external view returns (address[] memory) {
        return _members[union];
    }

    /// @dev The fees, each marked paid before its transfer (as members are), so a token that calls the receiver back
    ///      can't have one paid twice.
    function _payFees(address union) internal returns (Conversion storage c, uint256 tried, uint256 paid) {
        c = conversionOf[union];
        if (c.amount == 0) revert NotConverted();
        if (!c.protocolPaid) {
            c.protocolPaid = true;
            c.protocolPaid = _pay(union, factory.feeRecipient(), c.protocolFee, true);
            if (c.protocolFee != 0) (++tried, paid += c.protocolPaid ? 1 : 0);
        }
        if (!c.creatorPaid) {
            c.creatorPaid = true;
            c.creatorPaid = _pay(union, Batch(union).creator(), c.creatorFee, true);
            if (c.creatorFee != 0) (++tried, paid += c.creatorPaid ? 1 : 0);
        }
    }

    /// @dev A call where every transfer it tried failed reverts (NobodyPaid), so no one spends gas on it: BALANCE
    ///      can't move before its opening block, and until then every payout fails softly.
    function _distribute(address union, uint256 count) internal {
        (Conversion storage c, uint256 tried, uint256 paid) = _payFees(union);
        // The members as rated, each paid their share of the rating, the next `count` not yet paid.
        address[] storage members = _members[union];
        uint256 total = _rating[union].total;
        for (uint256 j; j < members.length && count != 0; ++j) {
            address m = members[j];
            if (claimed[union][m]) continue;
            --count;
            uint256 owed = c.net * putIn[union][m] / total;
            if (owed != 0) ++tried;
            claimed[union][m] = true;
            if (_pay(union, m, owed, true)) paid += owed != 0 ? 1 : 0;
            else claimed[union][m] = false;
        }
        if (tried != 0 && paid == 0) revert NobodyPaid();
    }

    /// @notice Pays one member their tokens. Anyone can call it for anyone.
    function claim(address union, address member) external {
        uint256 amount = claimable(union, member);
        if (amount == 0) revert NothingToClaim();
        claimed[union][member] = true;
        if (!_pay(union, member, amount, false)) revert PaymentFailed();
    }

    /// @dev A transfer out of the union's pocket that returns false when the token refuses or returns false, so the
    ///      caller carries on. A capped one (fees and members paid out) gets TRANSFER_GAS and reverts the whole call
    ///      when less than PAY_GAS is left, rather than letting the transfer fail for want of gas.
    function _pay(address union, address to, uint256 amount, bool capped) internal returns (bool ok) {
        if (amount == 0) return true;
        if (capped && gasleft() < PAY_GAS) revert PayoutGasTooLow();
        TokenPocket pocket = TokenPocket(pocketOf[union]);
        try pocket.pay{gas: capped ? TRANSFER_GAS : gasleft()}(to, amount) returns (bool sent) {
            ok = sent;
        } catch {
            ok = false;
        }
        if (ok) emit Paid(union, to, amount);
        else emit Unpaid(union, to, amount);
    }

    // ---------------------------------------------------------------- receipt

    /// @notice The receipt draws as the Statement it stands for (now in the vault).
    function tokenURI(uint256 id) public view override returns (string memory) {
        _requireOwned(id);
        return IERC721Metadata(address(statements)).tokenURI(id);
    }
}
