// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {ERC721} from "@openzeppelin/contracts/token/ERC721/ERC721.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {BarRouter, IPoolManager} from "../src/BarRouter.sol";
import {IBars} from "../src/interfaces/IBars.sol";
import {
    AdvancedOrder,
    ConsiderationItem,
    ISeaport,
    ItemType,
    OfferItem,
    OrderComponents,
    OrderParameters,
    OrderType
} from "../src/interfaces/ISeaport.sol";

/// @dev A Bars edition reduced to what the router relies on: mint takes `amount` $BALANCE from the caller into the
///      edition and mints to `to`; melt (owner only) burns the Bar and returns exactly that amount.
contract StandInBars is ERC721 {
    IERC20 public immutable balance;
    uint256 public minted;
    mapping(uint256 => uint256) public amountOf;

    constructor(IERC20 balance_) ERC721("Bars", "BARS") {
        balance = balance_;
    }

    function mint(address to, uint256 amount) external returns (uint256 id) {
        id = ++minted;
        amountOf[id] = amount;
        balance.transferFrom(msg.sender, address(this), amount);
        _mint(to, id);
    }

    function melt(uint256 id) external {
        require(ownerOf(id) == msg.sender, "Only owner");
        uint256 amount = amountOf[id];
        delete amountOf[id];
        _burn(id);
        balance.transfer(msg.sender, amount);
    }
}

/// @notice Against mainnet: the real $BALANCE, its v4 pool and Seaport 1.6, with a stand-in edition.
///         MAINNET_RPC=<url> forge test --match-path test/BarRouter.fork.t.sol
contract BarRouterForkTest is Test {
    IERC20 constant BALANCE = IERC20(0x3620540c994433D7B4a628C46d2ED5F92572eA07);
    IPoolManager constant POOL_MANAGER = IPoolManager(0x000000000004444c5dc75cB358380D2e3dE08A90);
    ISeaport constant SEAPORT = ISeaport(0x0000000000000068F116a894984e2DB1123eB395);
    address constant LBP_HOOK = 0x2EEF0e2a9a652d755AccAD95a24541A98B5CA000;

    StandInBars bars;
    BarRouter router;
    address fee = makeAddr("fee");
    address buyer = makeAddr("buyer");
    address keeper = makeAddr("keeper");
    uint256 sellerKey = uint256(keccak256("bars seller")); // 0xA11CE has a 7702 delegation on mainnet that forwards ETH away
    address seller;

    function setUp() public {
        vm.createSelectFork(vm.envOr("MAINNET_RPC", string("https://ethereum-rpc.publicnode.com")));
        seller = vm.addr(sellerKey);
        bars = new StandInBars(BALANCE);
        router = new BarRouter(IBars(address(bars)), BALANCE, POOL_MANAGER, SEAPORT, fee, 100, 3000, 30, LBP_HOOK);
        vm.deal(buyer, 100 ether);
        vm.deal(keeper, 100 ether);
        vm.deal(seller, 100 ether);
        vm.prank(seller);
        bars.setApprovalForAll(address(SEAPORT), true);
    }

    /// @dev The seller mints a Bar holding `amount` through the router, so it can list it.
    function _sellerBar(uint256 amount) internal returns (uint256 id) {
        vm.prank(seller);
        id = router.mint{value: 50 ether}(seller, amount, 500);
    }

    function _listing(uint256 id, uint256 price) internal view returns (AdvancedOrder memory o) {
        OfferItem[] memory offer = new OfferItem[](1);
        offer[0] = OfferItem(ItemType.ERC721, address(bars), id, 1, 1);
        ConsiderationItem[] memory cons = new ConsiderationItem[](1);
        cons[0] = ConsiderationItem(ItemType.NATIVE, address(0), 0, price, price, payable(seller));
        OrderComponents memory c = OrderComponents({
            offerer: seller,
            zone: address(0),
            offer: offer,
            consideration: cons,
            orderType: OrderType.FULL_OPEN,
            startTime: block.timestamp - 1,
            endTime: block.timestamp + 1 days,
            zoneHash: bytes32(0),
            salt: id,
            conduitKey: bytes32(0),
            counter: SEAPORT.getCounter(seller)
        });
        (, bytes32 domain,) = SEAPORT.information();
        (uint8 v, bytes32 r, bytes32 s) =
            vm.sign(sellerKey, keccak256(abi.encodePacked("\x19\x01", domain, SEAPORT.getOrderHash(c))));
        o.parameters = OrderParameters(
            c.offerer, c.zone, c.offer, c.consideration, c.orderType, c.startTime, c.endTime,
            c.zoneHash, c.salt, c.conduitKey, cons.length
        );
        o.numerator = 1;
        o.denominator = 1;
        o.signature = abi.encodePacked(r, s, v);
    }

    function _one(AdvancedOrder memory o) internal pure returns (AdvancedOrder[] memory orders) {
        orders = new AdvancedOrder[](1);
        orders[0] = o;
    }

    function test_MintBuysExactlyTheAmountAndRefunds() public {
        uint256 amount = 369e18;
        uint256 dust = address(router).balance;
        vm.prank(buyer);
        uint256 id = router.mint{value: 50 ether}(buyer, amount, 500);

        assertEq(bars.ownerOf(id), buyer);
        assertEq(bars.amountOf(id), amount);
        assertEq(BALANCE.balanceOf(address(router)), 0);
        uint256 paid = 100 ether - buyer.balance;
        assertGt(paid, 0);
        assertApproxEqAbs(fee.balance, paid / 101, 1); // 1% of the swap, inside what the buyer paid
        assertEq(address(router).balance, dust);
    }

    function test_MintRevertsWhenUnderpaid() public {
        vm.prank(buyer);
        vm.expectRevert();
        router.mint{value: 1 wei}(buyer, 369e18, 500);
    }

    function test_MintRefusesARaisedFee() public {
        vm.prank(fee);
        router.setFee(200);
        vm.prank(buyer);
        vm.expectRevert(abi.encodeWithSelector(BarRouter.FeeChanged.selector, 200));
        router.mint{value: 50 ether}(buyer, 369e18, 100);
    }

    function test_MeltForEthProfitsOnACheapListing() public {
        uint256 id = _sellerBar(1_000e18);
        uint256 price = 0.0001 ether;
        AdvancedOrder[] memory orders = _one(_listing(id, price));
        uint256 before = keeper.balance;
        vm.prank(keeper);
        uint256 back = router.meltForEth{value: price}(orders, 1, 1);

        assertGt(back, price);
        assertEq(keeper.balance, before - price + back);
        vm.expectRevert();
        bars.ownerOf(id); // melted
        assertEq(BALANCE.balanceOf(address(router)), 0);
    }

    function test_MeltForEthRevertsAboveBacking() public {
        uint256 id = _sellerBar(10e18);
        uint256 price = 90 ether;
        AdvancedOrder[] memory orders = _one(_listing(id, price));
        vm.prank(keeper);
        vm.expectRevert(); // NoProfit, and the whole buy unwinds
        router.meltForEth{value: price}(orders, 1, 0);
        assertEq(bars.ownerOf(id), seller);
    }

    function test_MeltForBalanceDeliversTheDeposit() public {
        uint256 id = _sellerBar(500e18);
        uint256 price = 0.01 ether;
        AdvancedOrder[] memory orders = _one(_listing(id, price));
        uint256 feeBefore = fee.balance;
        vm.prank(buyer);
        uint256 out = router.meltForBalance{value: price + price / 100}(orders, 1, 500e18, 500);

        assertEq(out, 500e18);
        assertEq(BALANCE.balanceOf(buyer), 500e18);
        assertEq(fee.balance - feeBefore, price / 100);
    }

    function test_SkipsASoldListingAndEnforcesMin() public {
        uint256 a = _sellerBar(100e18);
        uint256 b = _sellerBar(100e18);
        AdvancedOrder[] memory orders = new AdvancedOrder[](2);
        orders[0] = _listing(a, 0.001 ether);
        orders[1] = _listing(b, 0.001 ether);
        AdvancedOrder[] memory first = _one(orders[0]);
        vm.prank(keeper);
        router.meltForEth{value: 0.001 ether}(first, 1, 0);

        vm.prank(buyer);
        vm.expectRevert(abi.encodeWithSelector(BarRouter.TooFewBought.selector, 1));
        router.meltForBalance{value: 0.01 ether}(orders, 2, 0, 500);

        vm.prank(buyer);
        uint256 out = router.meltForBalance{value: 0.01 ether}(orders, 1, 0, 500);
        assertEq(out, 100e18);
    }

    function test_RejectsAnythingButABar() public {
        uint256 id = _sellerBar(10e18);
        AdvancedOrder[] memory orders = _one(_listing(id, 0.001 ether));
        orders[0].parameters.offer[0].token = address(0x1234);
        vm.prank(keeper);
        vm.expectRevert(abi.encodeWithSelector(BarRouter.NotABar.selector, 0));
        router.meltForEth{value: 0.001 ether}(orders, 1, 0);
    }

    function test_OnlyThePoolManagerCallsBack() public {
        vm.expectRevert(BarRouter.NotPoolManager.selector);
        router.unlockCallback(abi.encode(true, 1, 1));
    }
}
