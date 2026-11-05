// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {ERC721} from "@openzeppelin/contracts/token/ERC721/ERC721.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

/// @notice A Bar's own vault, as in the real edition: it holds the Bar's $BALANCE, and on a melt hands over everything
///         in it, the deposit plus anything others sent to it.
contract StandInVault {
    using SafeERC20 for IERC20;

    address public immutable edition = msg.sender;
    IERC20 public immutable token;

    constructor(IERC20 token_) {
        token = token_;
    }

    function release(address to) external returns (uint256 sent) {
        require(msg.sender == edition, "Only edition");
        sent = token.balanceOf(address(this));
        token.safeTransfer(to, sent);
    }
}

/// @notice A stand-in Bars edition for tests and local chains, not the real one: Bar #n holds n $BALANCE in its own
///         vault, minting is open for one window (up to 10 a call), and once it closes melting (owner only) burns the
///         Bar and hands over everything in its vault. Same calls and events as BarRouter and the site read. Unlike the
///         real one, it may open now.
contract StandInBars is ERC721 {
    using SafeERC20 for IERC20;

    uint256 public constant STEP = 1 ether;
    uint256 public constant MAX_BATCH = 10;
    IERC20 public immutable balance;
    uint64 public immutable mintStart;
    uint64 public immutable mintEnd;
    uint256 public minted;
    mapping(uint256 => StandInVault) public vaultOf;

    event Minted(uint256 indexed id, address indexed to, address vault, uint256 amount);
    event Melted(uint256 indexed id, address indexed owner, uint256 amount);
    event MintBatch(address indexed payer, address indexed to, uint256 first, uint256 quantity, uint256 amount);

    constructor(IERC20 balance_, uint64 start, uint64 end) ERC721("Bars", "BARS") {
        require(start < end, "Window");
        balance = balance_;
        mintStart = start;
        mintEnd = end;
    }

    function isOpen() public view returns (bool) {
        return block.timestamp >= mintStart && block.timestamp < mintEnd;
    }

    function isMeltOpen() public view returns (bool) {
        return block.timestamp >= mintEnd;
    }

    function amountOf(uint256 number) public pure returns (uint256) {
        return number * STEP;
    }

    /// @notice What the next `quantity` Bars take in all.
    function priceOf(uint256 quantity) public view returns (uint256) {
        require(quantity > 0 && quantity <= MAX_BATCH, "Invalid quantity");
        return (2 * minted + 1 + quantity) * quantity / 2 * STEP;
    }

    function mint(address to, uint256 quantity, uint256 expectedFirst, uint256 maxTotal) external returns (uint256 first) {
        require(isOpen(), "Not open");
        first = minted + 1;
        require(expectedFirst == first, "Bar number changed");
        require(priceOf(quantity) <= maxTotal, "Deposit exceeds limit");
        _mintBars(to, quantity);
    }

    /// @notice The next Bars in a row that fit the payer's cap, allowance and balance, as they stand now.
    function quoteMint(address payer, uint256 maxQuantity, uint256 maxTotal)
        public
        view
        returns (uint256 first, uint256 quantity, uint256 total)
    {
        require(maxQuantity > 0 && maxQuantity <= MAX_BATCH, "Invalid quantity");
        if (!isOpen()) return (0, 0, 0);
        uint256 budget = balance.allowance(payer, address(this));
        uint256 held = balance.balanceOf(payer);
        if (held < budget) budget = held;
        if (maxTotal < budget) budget = maxTotal;
        first = minted + 1;
        for (uint256 i; i < maxQuantity; ++i) {
            uint256 amount = amountOf(first + i);
            if (amount > budget - total) break;
            total += amount;
            ++quantity;
        }
        if (quantity == 0) first = 0;
    }

    /// @notice Mint up to `maxQuantity` at the numbers next when it lands, never over `maxTotal`. Nothing fits: no mint.
    function mintUpTo(address to, uint256 maxQuantity, uint256 maxTotal)
        external
        returns (uint256 first, uint256 quantity, uint256 total)
    {
        (first, quantity, total) = quoteMint(msg.sender, maxQuantity, maxTotal);
        if (quantity > 0) _mintBars(to, quantity);
        emit MintBatch(msg.sender, to, first, quantity, total);
    }

    function _mintBars(address to, uint256 quantity) internal {
        for (uint256 i; i < quantity; ++i) {
            uint256 id = ++minted;
            StandInVault vault = new StandInVault(balance);
            vaultOf[id] = vault;
            balance.safeTransferFrom(msg.sender, address(vault), amountOf(id));
            _mint(to, id);
            emit Minted(id, to, address(vault), amountOf(id));
        }
    }

    function melt(uint256 id) external {
        require(isMeltOpen(), "Minting has not closed");
        require(ownerOf(id) == msg.sender, "Only owner");
        _melt(id);
    }

    /// @notice Melt up to ten of your Bars at once, all or none. Returns everything their vaults sent.
    function meltBatch(uint256[] calldata ids) external returns (uint256 total) {
        require(isMeltOpen(), "Minting has not closed");
        require(ids.length > 0 && ids.length <= MAX_BATCH, "Invalid quantity");
        for (uint256 i; i < ids.length; ++i) {
            require(ownerOf(ids[i]) == msg.sender, "Only owner");
            for (uint256 j; j < i; ++j) require(ids[j] != ids[i], "Duplicate Bar");
        }
        for (uint256 i; i < ids.length; ++i) total += _melt(ids[i]);
    }

    /// @dev The event reports what actually left the vault.
    function _melt(uint256 id) internal returns (uint256 sent) {
        _burn(id);
        sent = vaultOf[id].release(msg.sender);
        emit Melted(id, msg.sender, sent);
    }
}
