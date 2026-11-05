// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {BarRouter, IPoolManager} from "../src/BarRouter.sol";
import {IBars} from "../src/interfaces/IBars.sol";
import {StandInBars} from "../src/mocks/StandInBars.sol";
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
        bars = new StandInBars(BALANCE, uint64(block.timestamp), uint64(block.timestamp + 8 days));
        router = new BarRouter(IBars(address(bars)), BALANCE, POOL_MANAGER, SEAPORT, fee, 100, 3000, 30, LBP_HOOK);
        vm.deal(buyer, 100 ether);
        vm.deal(keeper, 100 ether);
        vm.deal(seller, 100 ether);
        vm.prank(seller);
        bars.setApprovalForAll(address(SEAPORT), true);
    }

    /// @dev The seller mints the next Bar through the router, so it can list it once melting opens.
    function _sellerBar() internal returns (uint256 id) {
        uint256 quoted = bars.priceOf(1);
        vm.prank(seller);
        id = router.mint{value: 50 ether}(seller, 1, 500, quoted);
    }

    /// @dev What Bars #1 to #n hold between them, each in its own vault.
    function _inVaults(uint256 n) internal view returns (uint256 total) {
        for (uint256 id = 1; id <= n; ++id) total += BALANCE.balanceOf(address(bars.vaultOf(id)));
    }

    /// @dev Mints the seller Bars #1 to #n, then closes the window so they can melt.
    function _sellerBars(uint256 n) internal {
        for (uint256 i; i < n; ++i) _sellerBar();
        vm.warp(bars.mintEnd());
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

    function test_MintBuysExactlyWhatTheBarsHoldAndRefunds() public {
        uint256 quoted = bars.priceOf(3);
        assertEq(quoted, 6e18); // #1 + #2 + #3
        uint256 dust = address(router).balance;
        vm.prank(buyer);
        uint256 first = router.mint{value: 50 ether}(buyer, 3, 500, quoted);

        assertEq(first, 1);
        assertEq(bars.ownerOf(3), buyer);
        assertEq(_inVaults(3), 6e18);
        assertEq(BALANCE.balanceOf(address(router)), 0);
        uint256 paid = 100 ether - buyer.balance;
        assertGt(paid, 0);
        assertApproxEqAbs(fee.balance, paid / 101, 1); // 1% of the swap, inside what the buyer paid
        assertEq(address(router).balance, dust);
    }

    function test_MintRevertsWhenUnderpaid() public {
        vm.prank(buyer);
        vm.expectRevert();
        router.mint{value: 1 wei}(buyer, 1, 500, 1e18);
    }

    function test_MintRefusesARaisedFee() public {
        vm.prank(fee);
        router.setFee(200);
        vm.prank(buyer);
        vm.expectRevert(abi.encodeWithSelector(BarRouter.FeeChanged.selector, 200));
        router.mint{value: 50 ether}(buyer, 1, 100, 1e18);
    }

    /// A mint that lands first makes the quoted number dearer; the late one spends nothing, whatever ETH it sent.
    function test_MintRevertsWhenSomeoneMintsFirst() public {
        uint256 quoted = bars.priceOf(1);
        _sellerBar();
        uint256 dearer = bars.priceOf(1);
        vm.prank(buyer);
        vm.expectRevert(abi.encodeWithSelector(BarRouter.PriceChanged.selector, dearer));
        router.mint{value: 50 ether}(buyer, 1, 500, quoted);
    }

    /// With room in the cap, a mint someone lands first takes the next number instead, and pays only for that one.
    function test_MintTakesTheNextNumberWithinTheCap() public {
        uint256 quoted = bars.priceOf(1);
        _sellerBar();
        vm.prank(buyer);
        uint256 id = router.mint{value: 50 ether}(buyer, 1, 500, quoted + 100e18);
        assertEq(id, 2);
        assertEq(bars.ownerOf(2), buyer);
        assertEq(_inVaults(2), 3e18); // #1 and #2
        assertEq(BALANCE.balanceOf(address(router)), 0);
    }

    function test_MintRevertsAfterTheWindow() public {
        vm.warp(bars.mintEnd());
        vm.prank(buyer);
        vm.expectRevert(bytes("Not open"));
        router.mint{value: 50 ether}(buyer, 1, 500, 1e18);
    }

    /// Melting opens when minting closes; a listed Bar can't be bought and melted before.
    function test_MeltsRevertWhileMintingIsOpen() public {
        uint256 id = _sellerBar();
        AdvancedOrder[] memory orders = _one(_listing(id, 1 wei));
        vm.prank(keeper);
        vm.expectRevert(BarRouter.MeltClosed.selector);
        router.meltForEth{value: 1 wei}(orders, 1, 0);
        vm.prank(buyer);
        vm.expectRevert(BarRouter.MeltClosed.selector);
        router.meltForBalance{value: 1 wei}(orders, 1, 0, 500);
    }

    function test_MeltForEthProfitsOnACheapListing() public {
        _sellerBars(10);
        uint256 price = 10 wei;
        AdvancedOrder[] memory orders = _one(_listing(10, price));
        uint256 before = keeper.balance;
        vm.prank(keeper);
        uint256 back = router.meltForEth{value: price}(orders, 1, 1);

        assertGt(back, price);
        assertEq(keeper.balance, before - price + back);
        vm.expectRevert();
        bars.ownerOf(10); // melted
        assertEq(BALANCE.balanceOf(address(router)), 0);
    }

    function test_MeltForEthRevertsAboveBacking() public {
        _sellerBars(1);
        uint256 price = 90 ether;
        AdvancedOrder[] memory orders = _one(_listing(1, price));
        vm.prank(keeper);
        vm.expectRevert(); // NoProfit, and the whole buy unwinds
        router.meltForEth{value: price}(orders, 1, 0);
        assertEq(bars.ownerOf(1), seller);
    }

    function test_MeltForBalanceDeliversTheDeposit() public {
        _sellerBars(5);
        uint256 price = 0.01 ether;
        AdvancedOrder[] memory orders = _one(_listing(5, price));
        uint256 feeBefore = fee.balance;
        vm.prank(buyer);
        uint256 out = router.meltForBalance{value: price + price / 100}(orders, 1, 5e18, 500);

        assertEq(out, 5e18);
        assertEq(BALANCE.balanceOf(buyer), 5e18);
        assertEq(fee.balance - feeBefore, price / 100);
    }

    /// A melt hands over everything in the Bar's vault, so $BALANCE someone sent to it comes out too.
    function test_MeltForBalanceDeliversWhatTheVaultHolds() public {
        _sellerBars(5);
        uint256 price = 0.01 ether;
        AdvancedOrder[] memory five = _one(_listing(5, price));
        AdvancedOrder[] memory four = _one(_listing(4, price));
        address vault = address(bars.vaultOf(4));
        vm.prank(buyer);
        router.meltForBalance{value: price + price / 100}(five, 1, 5e18, 500);
        vm.prank(buyer);
        BALANCE.transfer(vault, 2e18);

        vm.prank(buyer);
        uint256 out = router.meltForBalance{value: price + price / 100}(four, 1, 6e18, 500);
        assertEq(out, 6e18);
        assertEq(BALANCE.balanceOf(buyer), 9e18);
        assertEq(BALANCE.balanceOf(vault), 0);
    }

    function test_SkipsASoldListingAndEnforcesMin() public {
        _sellerBars(2);
        AdvancedOrder[] memory orders = new AdvancedOrder[](2);
        orders[0] = _listing(1, 0.001 ether);
        orders[1] = _listing(2, 0.001 ether);
        AdvancedOrder[] memory first = _one(orders[0]);
        vm.prank(buyer);
        router.meltForBalance{value: 0.01 ether}(first, 1, 0, 500);

        vm.prank(buyer);
        vm.expectRevert(abi.encodeWithSelector(BarRouter.TooFewBought.selector, 1));
        router.meltForBalance{value: 0.01 ether}(orders, 2, 0, 500);

        vm.prank(buyer);
        uint256 out = router.meltForBalance{value: 0.01 ether}(orders, 1, 0, 500);
        assertEq(out, 2e18);
    }

    /// A melted or moved Bar's listing is still a live order to Seaport; its transfer would revert the whole fill.
    function test_SkipsAListingWhoseBarWasMeltedOrMoved() public {
        _sellerBars(3);
        AdvancedOrder[] memory orders = new AdvancedOrder[](3);
        orders[0] = _listing(1, 0.001 ether);
        orders[1] = _listing(2, 0.001 ether);
        orders[2] = _listing(3, 0.001 ether);
        vm.startPrank(seller);
        bars.melt(1);
        bars.transferFrom(seller, keeper, 2);
        vm.stopPrank();

        vm.prank(buyer);
        vm.expectRevert(abi.encodeWithSelector(BarRouter.TooFewBought.selector, 1));
        router.meltForBalance{value: 0.01 ether}(orders, 2, 0, 500);

        vm.prank(buyer);
        uint256 out = router.meltForBalance{value: 0.01 ether}(orders, 1, 0, 500);
        assertEq(out, 3e18);
        assertEq(bars.ownerOf(2), keeper);
    }

    function test_RejectsAnythingButABar() public {
        _sellerBars(1);
        AdvancedOrder[] memory orders = _one(_listing(1, 0.001 ether));
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
