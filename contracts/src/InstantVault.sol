// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {ReentrancyGuardTransient} from "@openzeppelin/contracts/utils/ReentrancyGuardTransient.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Batch} from "./Batch.sol";
import {BatchFactory} from "./BatchFactory.sol";
import {ICredits} from "./interfaces/ICredits.sol";

/// @title InstantVault
/// @notice Sell Credits for BALANCE now instead of waiting for a token union to fill. The vault holds BALANCE; a
///         seller hands it Credits and is paid, in the same transaction, what the union would pay them when it
///         converts: each Credit's rating by the union's own score table, one BALANCE a point, less the union's fees.
///         The vault deposits the Credits into that union in its own name, so when the union converts it is paid
///         the same amount back (converting pays by Jack's score, which has come out a hair above the table's on
///         every union so far). The fees go where they always go, the factory's fee recipient.
///
///         The vault never holds a price: it pays and is repaid in BALANCE, one point for one point. Its stock only
///         waits, as Credits in an unfilled union, until that union converts.
///
///         The fee recipient (the Safe) can pause new sales, take Credits back out of a union that hasn't locked,
///         and send out any token or Credit the vault holds. Anyone can fund it by sending it BALANCE. No upgrades.
contract InstantVault is ReentrancyGuardTransient {
    using SafeERC20 for IERC20;

    /// @notice The token unions' factory (the BALANCE batches).
    BatchFactory public immutable factory;
    ICredits public immutable credits;
    /// @notice BALANCE: what the vault pays in and is repaid in.
    IERC20 public immutable token;
    /// @notice The factory's fee recipient (the Safe): the vault's only admin.
    address public immutable admin;

    bool public paused;

    event Sold(address indexed seller, address indexed batch, address indexed to, uint256[] ids, uint256 paid);
    event Paused(bool paused);

    error NotAdmin();
    error IsPaused();
    error NotBatch();
    error NoCredits();
    error TooLittle(uint256 paid);
    error ShortOfStock(uint256 need, uint256 have);
    error NoTable();

    constructor(BatchFactory factory_, IERC20 token_) {
        factory = factory_;
        credits = factory_.credits();
        token = token_;
        admin = factory_.feeRecipient();
        credits.setApprovalForAll(address(factory_), true);
    }

    modifier onlyAdmin() {
        if (msg.sender != admin) revert NotAdmin();
        _;
    }

    // ---------------------------------------------------------------- selling

    /// @notice What selling `ids` into `batch` pays now, in BALANCE (18 decimals): their ratings in the union's table
    ///         (tenths of a point), less the union's protocol and creator fees, as the union will pay the vault.
    function quote(address batch, uint256[] calldata ids) public view returns (uint256) {
        Batch b = Batch(batch);
        if (address(b.ratings()) == address(0)) revert NoTable(); // a union with no table pays every Credit the same
        uint256 tenths;
        for (uint256 i; i < ids.length; ++i) tenths += b.ratings().scoreOf(ids[i]);
        uint256 keep = 10_000 - b.protocolFeeBps() - b.creatorFeeBps();
        return tenths * 1e17 * keep / 10_000;
    }

    /// @notice Sell your Credits: they go into `batch` in the vault's name and `to` is paid `quote` in BALANCE now,
    ///         at least `minOut`. The union must take them (open, room, its filter) or the whole sale reverts.
    function sell(address batch, uint256[] calldata ids, uint256 minOut, address to) external nonReentrant returns (uint256 paid) {
        if (paused) revert IsPaused();
        if (!factory.isBatch(batch)) revert NotBatch();
        if (ids.length == 0) revert NoCredits();
        paid = quote(batch, ids);
        if (paid < minOut || paid == 0) revert TooLittle(paid);
        uint256 have = token.balanceOf(address(this));
        if (have < paid) revert ShortOfStock(paid, have);
        for (uint256 i; i < ids.length; ++i) credits.transferFrom(msg.sender, address(this), ids[i]);
        factory.deposit(batch, ids);
        token.safeTransfer(to, paid);
        emit Sold(msg.sender, batch, to, ids, paid);
    }

    /// @notice The BALANCE the vault can pay out now (a page caps a sale by it).
    function stock() external view returns (uint256) {
        return token.balanceOf(address(this));
    }

    // ---------------------------------------------------------------- admin

    function setPaused(bool on) external onlyAdmin {
        paused = on;
        emit Paused(on);
    }

    /// @notice Take the vault's Credits back out of a union that hasn't locked (Batch.withdraw), into the vault.
    function reclaim(address batch, uint256[] calldata ids) external onlyAdmin {
        if (!factory.isBatch(batch)) revert NotBatch();
        Batch(batch).withdraw(ids);
    }

    /// @notice Send out a token the vault holds (BALANCE, or anything sent here by mistake).
    function sendToken(IERC20 t, address to, uint256 amount) external onlyAdmin {
        t.safeTransfer(to, amount);
    }

    /// @notice Send out Credits the vault holds (ones reclaimed from a union).
    function sendCredits(address to, uint256[] calldata ids) external onlyAdmin {
        for (uint256 i; i < ids.length; ++i) credits.transferFrom(address(this), to, ids[i]);
    }

    /// @notice Credits come back here when the vault withdraws them from a union.
    function onERC721Received(address, address, uint256, bytes calldata) external view returns (bytes4) {
        if (msg.sender != address(credits)) revert NoCredits();
        return this.onERC721Received.selector;
    }
}
