// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {ratingsOf} from "../script/RatingsOf.sol";
import {Batch, IRatings} from "../src/Batch.sol";
import {BatchFactory} from "../src/BatchFactory.sol";
import {Sweeper} from "../src/Sweeper.sol";
import {ICreditStrategy} from "../src/interfaces/ICreditStrategy.sol";
import {IFWAMarket} from "../src/interfaces/IFWAMarket.sol";
import {IAssembler} from "../src/interfaces/IAssembler.sol";
import {ICredits} from "../src/interfaces/ICredits.sol";
import {AdvancedOrder, ISeaport} from "../src/interfaces/ISeaport.sol";

/// @notice Against mainnet: the real Credits and the real CreditStrategy (nftstrategy.fun).
///         MAINNET_RPC=<url> forge test --match-path test/SweeperStrategy.fork.t.sol
contract SweeperStrategyForkTest is Test {
    ICredits constant CREDITS = ICredits(0x97630aA70AB14ed9883B41dAfccBc11349723043);
    ISeaport constant SEAPORT = ISeaport(0x0000000000000068F116a894984e2DB1123eB395);
    ICreditStrategy constant STRATEGY = ICreditStrategy(0x8e607209899b5d12Bd3167a6CD0E8E11FEB053d6);

    BatchFactory factory;
    Sweeper sweeper;
    Batch batch;
    address fee = makeAddr("fee");
    address buyer = makeAddr("buyer");
    uint256[] held; // Credits the strategy holds for sale
    uint256[] prices;

    function setUp() public {
        vm.createSelectFork(vm.envOr("MAINNET_RPC", string("https://ethereum-rpc.publicnode.com")));
        factory = new BatchFactory(CREDITS, IRatings(address(0)), IAssembler(address(0)), address(this), fee, 100, 0, 1);
        sweeper = new Sweeper(SEAPORT, factory, 100, IFWAMarket(address(0)), STRATEGY);

        // A real holder opens a test batch with one Credit.
        address creator;
        uint256 id = 1000;
        while (creator == address(0)) {
            try CREDITS.ownerOf(id) returns (address o) {
                if (o.code.length == 0) {
                    creator = o;
                    uint256[] memory one = new uint256[](1);
                    one[0] = id;
                    vm.startPrank(o);
                    CREDITS.setApprovalForAll(address(factory), true);
                    batch = Batch(factory.create("Fork", Batch.Filter(0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0), new uint256[](0), 0, Batch.Arrangement.Deposit, Batch.Split.Equal, 14 days, one, 100, 0, ratingsOf(address(factory))));
                    vm.stopPrank();
                }
            } catch {}
            ++id;
        }

        // Three Credits the strategy has for sale.
        for (id = 100_000; held.length < 3; ++id) {
            uint256 p = STRATEGY.nftForSale(id);
            if (p != 0) {
                held.push(id);
                prices.push(p);
            }
        }
        vm.deal(buyer, 10 ether);
    }

    function _listings(uint256 n) internal view returns (Sweeper.StrategyListing[] memory ls, uint256 total) {
        ls = new Sweeper.StrategyListing[](n);
        for (uint256 i; i < n; ++i) {
            ls[i] = Sweeper.StrategyListing(held[i], prices[i]);
            total += prices[i];
        }
    }

    function test_BuysFromStrategy_DepositsChargesFeeRefundsRest() public {
        (Sweeper.StrategyListing[] memory ls, uint256 total) = _listings(3);
        uint256 stratBefore = address(STRATEGY).balance;
        uint256 buyerBefore = buyer.balance;
        uint256 sweeperBefore = address(sweeper).balance; // mainnet dust can sit at a fresh address
        vm.prank(buyer);
        uint256[] memory ids = sweeper.sweepAll{value: total * 2}(
            address(batch), new AdvancedOrder[](0), new Sweeper.FWAListing[](0), ls, 3, 100
        );
        assertEq(ids.length, 3);
        for (uint256 i; i < 3; ++i) {
            assertEq(ids[i], held[i]);
            assertEq(CREDITS.ownerOf(held[i]), address(batch));
            assertEq(STRATEGY.nftForSale(held[i]), 0);
        }
        assertEq(address(STRATEGY).balance - stratBefore, total);
        assertEq(fee.balance, total / 100);
        assertEq(buyerBefore - buyer.balance, total + total / 100);
        assertEq(address(sweeper).balance, sweeperBefore);
    }

    function test_SoldOrRepricedIsSkipped() public {
        // Someone buys the first one first.
        address other = makeAddr("other");
        vm.deal(other, 1 ether);
        vm.prank(other);
        STRATEGY.sellTargetNFT{value: prices[0]}(held[0]);

        (Sweeper.StrategyListing[] memory ls, uint256 total) = _listings(3);
        ls[1].price = prices[1] + 1; // quoted at a price the strategy no longer asks
        vm.prank(buyer);
        uint256[] memory ids = sweeper.sweepAll{value: total * 2}(
            address(batch), new AdvancedOrder[](0), new Sweeper.FWAListing[](0), ls, 1, 100
        );
        assertEq(ids.length, 1);
        assertEq(ids[0], held[2]);
        assertEq(CREDITS.ownerOf(held[1]), address(STRATEGY));
    }

    function test_MinBoughtReverts() public {
        (Sweeper.StrategyListing[] memory ls, uint256 total) = _listings(2);
        ls[0].price = 1;
        vm.prank(buyer);
        vm.expectRevert(abi.encodeWithSelector(Sweeper.TooFewBought.selector, 1));
        sweeper.sweepAll{value: total}(address(batch), new AdvancedOrder[](0), new Sweeper.FWAListing[](0), ls, 2, 100);
    }

    function test_UnderpaidReverts() public {
        (Sweeper.StrategyListing[] memory ls,) = _listings(2);
        vm.prank(buyer);
        vm.expectRevert(Sweeper.Underpaid.selector);
        sweeper.sweepAll{value: prices[0]}(address(batch), new AdvancedOrder[](0), new Sweeper.FWAListing[](0), ls, 1, 100);
    }

    function test_NoStrategyReverts() public {
        Sweeper plain = new Sweeper(SEAPORT, factory, 100, IFWAMarket(address(0)), ICreditStrategy(address(0)));
        (Sweeper.StrategyListing[] memory ls, uint256 total) = _listings(1);
        vm.prank(buyer);
        vm.expectRevert(Sweeper.NoStrategy.selector);
        plain.sweepAll{value: total}(address(batch), new AdvancedOrder[](0), new Sweeper.FWAListing[](0), ls, 1, 100);
    }

    function test_ConstructorRejectsOtherCollections() public {
        vm.mockCall(address(STRATEGY), abi.encodeWithSelector(ICreditStrategy.collection.selector), abi.encode(address(1)));
        vm.expectRevert(Sweeper.NotACreditStrategy.selector);
        new Sweeper(SEAPORT, factory, 100, IFWAMarket(address(0)), STRATEGY);
    }

    // --- buy: from the strategy straight to the buyer's wallet ---

    function test_Buy_FromStrategyToWallet_ChargesFeeRefundsRest() public {
        (Sweeper.StrategyListing[] memory ls, uint256 total) = _listings(3);
        uint256 stratBefore = address(STRATEGY).balance;
        uint256 buyerBefore = buyer.balance;
        uint256 sweeperBefore = address(sweeper).balance;
        uint256 batchCount = batch.count();
        vm.expectEmit(true, false, false, true, address(sweeper));
        emit Sweeper.Bought(buyer, 3, total, total / 100);
        vm.prank(buyer);
        uint256[] memory ids =
            sweeper.buy{value: total * 2}(new AdvancedOrder[](0), new Sweeper.FWAListing[](0), ls, 3, 100);
        assertEq(ids.length, 3);
        for (uint256 i; i < 3; ++i) {
            assertEq(ids[i], held[i]);
            assertEq(CREDITS.ownerOf(held[i]), buyer);
            assertEq(STRATEGY.nftForSale(held[i]), 0);
        }
        assertEq(batch.count(), batchCount);
        assertEq(address(STRATEGY).balance - stratBefore, total);
        assertEq(fee.balance, total / 100);
        assertEq(buyerBefore - buyer.balance, total + total / 100);
        assertEq(address(sweeper).balance, sweeperBefore);
    }

    function test_Buy_SoldOrRepricedIsSkipped() public {
        address other = makeAddr("other");
        vm.deal(other, 1 ether);
        vm.prank(other);
        STRATEGY.sellTargetNFT{value: prices[0]}(held[0]);

        (Sweeper.StrategyListing[] memory ls, uint256 total) = _listings(3);
        ls[1].price = prices[1] + 1;
        uint256 buyerBefore = buyer.balance;
        vm.prank(buyer);
        uint256[] memory ids =
            sweeper.buy{value: total * 2}(new AdvancedOrder[](0), new Sweeper.FWAListing[](0), ls, 1, 100);
        assertEq(ids.length, 1);
        assertEq(ids[0], held[2]);
        assertEq(CREDITS.ownerOf(held[2]), buyer);
        assertEq(CREDITS.ownerOf(held[0]), other);
        assertEq(CREDITS.ownerOf(held[1]), address(STRATEGY));
        assertEq(buyerBefore - buyer.balance, prices[2] + prices[2] / 100);
    }

    function test_Buy_MinBoughtReverts() public {
        (Sweeper.StrategyListing[] memory ls, uint256 total) = _listings(2);
        ls[0].price = 1;
        vm.prank(buyer);
        vm.expectRevert(abi.encodeWithSelector(Sweeper.TooFewBought.selector, 1));
        sweeper.buy{value: total}(new AdvancedOrder[](0), new Sweeper.FWAListing[](0), ls, 2, 100);
    }

    function test_Buy_UnderpaidReverts() public {
        (Sweeper.StrategyListing[] memory ls,) = _listings(2);
        vm.prank(buyer);
        vm.expectRevert(Sweeper.Underpaid.selector);
        sweeper.buy{value: prices[0]}(new AdvancedOrder[](0), new Sweeper.FWAListing[](0), ls, 1, 100);
    }

    function test_Buy_FeeRaiseReverts() public {
        vm.prank(fee);
        sweeper.setFee(200);
        (Sweeper.StrategyListing[] memory ls, uint256 total) = _listings(1);
        vm.prank(buyer);
        vm.expectRevert(abi.encodeWithSelector(Sweeper.FeeChanged.selector, 200));
        sweeper.buy{value: total * 2}(new AdvancedOrder[](0), new Sweeper.FWAListing[](0), ls, 1, 100);
    }
}
