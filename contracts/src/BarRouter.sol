// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {ReentrancyGuardTransient} from "@openzeppelin/contracts/utils/ReentrancyGuardTransient.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {IBars} from "./interfaces/IBars.sol";
import {
    AdvancedOrder,
    CriteriaResolver,
    Execution,
    FulfillmentComponent,
    ISeaport,
    ItemType,
    OfferItem
} from "./interfaces/ISeaport.sol";

/// @dev The few Uniswap v4 PoolManager calls one single-pool swap needs. Currency is an address, ETH is zero.
interface IPoolManager {
    struct PoolKey {
        address currency0;
        address currency1;
        uint24 fee;
        int24 tickSpacing;
        address hooks;
    }

    struct SwapParams {
        bool zeroForOne;
        int256 amountSpecified; // negative: exact input; positive: exact output
        uint160 sqrtPriceLimitX96;
    }

    function unlock(bytes calldata data) external returns (bytes memory);
    function swap(PoolKey memory key, SwapParams memory params, bytes calldata hookData) external returns (int256);
    function sync(address currency) external;
    function settle() external payable returns (uint256);
    function take(address currency, address to, uint256 amount) external;
}

/// @title BarRouter
/// @notice Bars from ETH, in one transaction each way:
///         - `mint`: buy exactly the $BALANCE a Bar should hold in the ETH/$BALANCE pool and mint the Bar to you.
///         - `meltForBalance`: buy Bars listed on Seaport, melt them, and send you the $BALANCE that was inside.
///         - `meltForEth`: the same, then sell that $BALANCE in the pool; reverts unless you end with more ETH than
///           you sent, by at least `minProfit`.
///         Nothing is held between transactions. Unused ETH comes back.
/// @dev A Bar takes the ink of the $BALANCE deposited into it, which here is the pool's mix: the router passes on the
///      $BALANCE the pool gave it. Minting from your own wallet keeps your own ink.
contract BarRouter is ReentrancyGuardTransient {
    using SafeERC20 for IERC20;

    uint256 public constant MAX_FEE_BPS = 500;
    uint160 internal constant MIN_SQRT_PRICE = 4295128739;
    uint160 internal constant MAX_SQRT_PRICE = 1461446703485210103287273052203988822378723970342;

    /// @notice Fee on the ETH a `mint` or `meltForBalance` spends, in basis points. The fee recipient may change it
    ///         within MAX_FEE_BPS; `meltForEth` pays none.
    uint256 public feeBps;

    IBars public immutable bars;
    IERC20 public immutable balance;
    IPoolManager public immutable poolManager;
    ISeaport public immutable seaport;
    address public immutable feeRecipient;
    uint24 public immutable poolFee;
    int24 public immutable tickSpacing;
    address public immutable hooks;

    event FeeSet(uint256 feeBps);
    event Minted(address indexed buyer, address indexed to, uint256 indexed id, uint256 amount, uint256 spent, uint256 fee);
    event Melted(address indexed buyer, uint256 bars, uint256 spent, uint256 balanceOut, uint256 ethOut);

    error FeeTooHigh();
    error FeeChanged(uint256 feeBps);
    error NotFeeRecipient();
    error NotPoolManager();
    error ZeroAmount();
    error Underpaid(uint256 needed);
    error NotABar(uint256 orderIndex);
    error TooFewBought(uint256 bought);
    error TooLittleBalance(uint256 balanceOut);
    error NoProfit(uint256 ethBack);
    error PaymentFailed();

    constructor(
        IBars bars_,
        IERC20 balance_,
        IPoolManager poolManager_,
        ISeaport seaport_,
        address feeRecipient_,
        uint256 feeBps_,
        uint24 poolFee_,
        int24 tickSpacing_,
        address hooks_
    ) {
        if (feeBps_ > MAX_FEE_BPS) revert FeeTooHigh();
        bars = bars_;
        balance = balance_;
        poolManager = poolManager_;
        seaport = seaport_;
        feeRecipient = feeRecipient_;
        feeBps = feeBps_;
        poolFee = poolFee_;
        tickSpacing = tickSpacing_;
        hooks = hooks_;
        emit FeeSet(feeBps_);
    }

    /// @notice Change the fee, never above MAX_FEE_BPS. Every call reads the current value.
    function setFee(uint256 feeBps_) external {
        if (msg.sender != feeRecipient) revert NotFeeRecipient();
        if (feeBps_ > MAX_FEE_BPS) revert FeeTooHigh();
        feeBps = feeBps_;
        emit FeeSet(feeBps_);
    }

    // ---------------------------------------------------------------- mint

    /// @notice Buy exactly `amount` $BALANCE with the ETH sent and mint a Bar holding it to `to`. msg.value is the
    ///         most you pay, fee included; the rest comes back.
    /// @param maxFeeBps The fee rate you were quoted; reverts if it has been raised since.
    function mint(address to, uint256 amount, uint256 maxFeeBps) external payable nonReentrant returns (uint256 id) {
        if (feeBps > maxFeeBps) revert FeeChanged(feeBps);
        if (amount == 0) revert ZeroAmount();
        uint256 spent = abi.decode(poolManager.unlock(abi.encode(true, amount, msg.value)), (uint256));
        uint256 fee = spent * feeBps / 10_000;
        if (spent + fee > msg.value) revert Underpaid(spent + fee);

        balance.forceApprove(address(bars), amount);
        id = bars.mint(to, amount);
        emit Minted(msg.sender, to, id, amount, spent, fee);
        _settle(fee, msg.value - spent);
    }

    // ---------------------------------------------------------------- melt

    /// @notice Buy the Bars in `orders` that are still listed, melt them, and send you the $BALANCE that was inside.
    ///         msg.value pays the listings plus the fee; the rest comes back.
    /// @param minBought Revert unless at least this many listings were still available.
    /// @param minBalance Revert unless the melted Bars held at least this much $BALANCE.
    function meltForBalance(AdvancedOrder[] calldata orders, uint256 minBought, uint256 minBalance, uint256 maxFeeBps)
        external
        payable
        nonReentrant
        returns (uint256 balanceOut)
    {
        if (feeBps > maxFeeBps) revert FeeChanged(feeBps);
        uint256 bought;
        uint256 spent;
        (bought, spent, balanceOut) = _buyAndMelt(orders, minBought);
        if (balanceOut < minBalance) revert TooLittleBalance(balanceOut);
        uint256 fee = spent * feeBps / 10_000;
        if (msg.value - spent < fee) revert Underpaid(spent + fee);

        balance.safeTransfer(msg.sender, balanceOut);
        emit Melted(msg.sender, bought, spent, balanceOut, 0);
        _settle(fee, msg.value - spent);
    }

    /// @notice Buy the Bars in `orders` that are still listed, melt them, sell the $BALANCE in the pool, and send you
    ///         all the ETH. Reverts unless that is at least msg.value + `minProfit`, so a call either profits or does
    ///         nothing.
    function meltForEth(AdvancedOrder[] calldata orders, uint256 minBought, uint256 minProfit)
        external
        payable
        nonReentrant
        returns (uint256 ethBack)
    {
        (uint256 bought, uint256 spent, uint256 balanceOut) = _buyAndMelt(orders, minBought);
        uint256 ethOut = abi.decode(poolManager.unlock(abi.encode(false, balanceOut, uint256(0))), (uint256));
        ethBack = msg.value - spent + ethOut;
        if (ethBack < msg.value + minProfit) revert NoProfit(ethBack);

        emit Melted(msg.sender, bought, spent, balanceOut, ethOut);
        if (!_send(msg.sender, ethBack)) revert PaymentFailed();
    }

    /// @dev Buys what is still listed into this contract and melts each Bar bought.
    /// @return bought How many Bars came through.
    /// @return spent What the listings cost, from Seaport's own record of what it paid out (never a balance delta, so
    ///         ETH pushed here by a seller or royalty wallet mid-call cannot distort it).
    /// @return balanceOut The $BALANCE the melts returned.
    function _buyAndMelt(AdvancedOrder[] calldata orders, uint256 minBought)
        internal
        returns (uint256 bought, uint256 spent, uint256 balanceOut)
    {
        uint256 n = orders.length;
        FulfillmentComponent[][] memory offerF = new FulfillmentComponent[][](n);
        uint256 nc;
        for (uint256 i; i < n; ++i) {
            OfferItem[] calldata offer = orders[i].parameters.offer;
            if (offer.length != 1 || offer[0].itemType != ItemType.ERC721 || offer[0].token != address(bars)) {
                revert NotABar(i);
            }
            offerF[i] = new FulfillmentComponent[](1);
            offerF[i][0] = FulfillmentComponent(i, 0);
            nc += orders[i].parameters.consideration.length;
        }
        FulfillmentComponent[][] memory considF = new FulfillmentComponent[][](nc);
        uint256 k;
        for (uint256 i; i < n; ++i) {
            uint256 m = orders[i].parameters.consideration.length;
            for (uint256 j; j < m; ++j) {
                considF[k] = new FulfillmentComponent[](1);
                considF[k++][0] = FulfillmentComponent(i, j);
            }
        }

        (bool[] memory available, Execution[] memory executions) = seaport.fulfillAvailableAdvancedOrders{
            value: msg.value
        }(orders, new CriteriaResolver[](0), offerF, considF, bytes32(0), address(this), n);
        for (uint256 i; i < executions.length; ++i) {
            if (executions[i].item.itemType == ItemType.NATIVE) spent += executions[i].item.amount;
        }

        uint256 before = balance.balanceOf(address(this));
        for (uint256 i; i < n; ++i) {
            if (!available[i]) continue;
            bars.melt(orders[i].parameters.offer[0].identifierOrCriteria);
            ++bought;
        }
        if (bought < minBought || bought == 0) revert TooFewBought(bought);
        balanceOut = balance.balanceOf(address(this)) - before;
    }

    // ---------------------------------------------------------------- the pool

    /// @dev Inside `unlock`. Buying: exactly `amount` $BALANCE for ETH, paying at most `maxEth`. Selling: exactly
    ///      `amount` $BALANCE for ETH. Both tokens land in this contract. Returns the ETH paid or received.
    function unlockCallback(bytes calldata data) external returns (bytes memory) {
        if (msg.sender != address(poolManager)) revert NotPoolManager();
        (bool buying, uint256 amount, uint256 maxEth) = abi.decode(data, (bool, uint256, uint256));
        IPoolManager.PoolKey memory key = IPoolManager.PoolKey(address(0), address(balance), poolFee, tickSpacing, hooks);
        if (buying) {
            int256 delta = poolManager.swap(key, IPoolManager.SwapParams(true, int256(amount), MIN_SQRT_PRICE + 1), "");
            uint256 eth = uint256(-int256(int128(delta >> 128)));
            if (eth > maxEth) revert Underpaid(eth);
            poolManager.settle{value: eth}();
            poolManager.take(address(balance), address(this), uint256(int256(int128(delta))));
            return abi.encode(eth);
        }
        int256 d = poolManager.swap(key, IPoolManager.SwapParams(false, -int256(amount), MAX_SQRT_PRICE - 1), "");
        uint256 out = uint256(int256(int128(d >> 128)));
        poolManager.sync(address(balance));
        balance.safeTransfer(address(poolManager), uint256(-int256(int128(d))));
        poolManager.settle();
        poolManager.take(address(0), address(this), out);
        return abi.encode(out);
    }

    // ---------------------------------------------------------------- ETH

    /// @dev Pays the fee, then returns the rest of `left` to the caller.
    function _settle(uint256 fee, uint256 left) internal {
        if (fee > 0 && !_send(feeRecipient, fee)) revert PaymentFailed();
        if (left > fee && !_send(msg.sender, left - fee)) revert PaymentFailed();
    }

    /// @dev Seaport and the pool send ETH here. No ERC721 receiver hook on purpose: Seaport delivers with plain
    ///      transferFrom, and a safeTransferFrom of a stray NFT here should fail, not strand it.
    receive() external payable {}

    function _send(address to, uint256 amount) internal returns (bool ok) {
        assembly {
            ok := call(gas(), to, amount, 0, 0, 0, 0)
        }
    }
}
