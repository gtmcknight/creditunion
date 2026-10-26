// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {ERC721} from "@openzeppelin/contracts/token/ERC721/ERC721.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

/// @notice A stand-in Bars edition for tests and local chains, not the real one: each Bar holds the $BALANCE deposited
///         at its mint, minting is open for one window, and melting (owner only, any time) burns the Bar and returns
///         that $BALANCE. Same calls and events as BarRouter and the site read. With a `step`, it is priced by count
///         instead: mint's second word is how many, and Bar #n holds n × step.
contract StandInBars is ERC721 {
    using SafeERC20 for IERC20;

    IERC20 public immutable balance;
    uint64 public immutable mintStart;
    uint64 public immutable mintEnd;
    uint256 public immutable step;
    uint256 public minted;
    mapping(uint256 => uint256) public amountOf;

    event Minted(uint256 indexed id, address indexed to, address vault, uint256 amount);
    event Melted(uint256 indexed id, address indexed owner, uint256 amount);

    constructor(IERC20 balance_, uint64 start, uint64 end, uint256 step_) ERC721("Bars", "BARS") {
        require(start < end, "Window");
        balance = balance_;
        mintStart = start;
        mintEnd = end;
        step = step_;
    }

    /// @notice Priced by count: what the next `quantity` Bars take in all.
    function priceOf(uint256 quantity) external view returns (uint256 total) {
        require(step > 0, "Not by count");
        for (uint256 i = 1; i <= quantity; ++i) total += (minted + i) * step;
    }

    function isOpen() public view returns (bool) {
        return block.timestamp >= mintStart && block.timestamp < mintEnd;
    }

    function mint(address to, uint256 amountOrQuantity) external returns (uint256 first) {
        require(isOpen(), "Closed");
        if (step == 0) return _one(to, amountOrQuantity);
        require(amountOrQuantity > 0 && amountOrQuantity <= 10, "Invalid quantity");
        first = minted + 1;
        for (uint256 i; i < amountOrQuantity; ++i) _one(to, (minted + 1) * step);
    }

    function _one(address to, uint256 amount) internal returns (uint256 id) {
        require(amount >= 1e18, "Below minimum");
        id = ++minted;
        amountOf[id] = amount;
        balance.safeTransferFrom(msg.sender, address(this), amount);
        _mint(to, id);
        emit Minted(id, to, address(this), amount);
    }

    function melt(uint256 id) external {
        require(ownerOf(id) == msg.sender, "Only owner");
        uint256 amount = amountOf[id];
        delete amountOf[id];
        _burn(id);
        balance.safeTransfer(msg.sender, amount);
        emit Melted(id, msg.sender, amount);
    }
}
