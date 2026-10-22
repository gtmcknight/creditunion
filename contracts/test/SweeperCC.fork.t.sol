// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {Batch} from "../src/Batch.sol";
import {BatchFactory} from "../src/BatchFactory.sol";
import {Sweeper} from "../src/Sweeper.sol";
import {ICCController, ICCCore} from "../src/interfaces/ICCController.sol";
import {ICreditStrategy} from "../src/interfaces/ICreditStrategy.sol";
import {IFWAMarket} from "../src/interfaces/IFWAMarket.sol";
import {ICredits} from "../src/interfaces/ICredits.sol";
import {AdvancedOrder, ISeaport} from "../src/interfaces/ISeaport.sol";

interface ICCPile {
    function pilePage(uint256 startAfter, uint256 n) external view returns (uint256[] memory);
}

/// @notice Against mainnet: a new Sweeper on the live token factory (the $BALANCE batches) buying Credits the $CC
///         engine's pile holds into the Mixed batch filling now, in a buyer's name, at the engine's own prices.
///         MAINNET_RPC=<url> forge test --match-path test/SweeperCC.fork.t.sol
contract SweeperCCForkTest is Test {
    ICredits constant CREDITS = ICredits(0x97630aA70AB14ed9883B41dAfccBc11349723043);
    ISeaport constant SEAPORT = ISeaport(0x0000000000000068F116a894984e2DB1123eB395);
    ICreditStrategy constant STRATEGY = ICreditStrategy(0x8e607209899b5d12Bd3167a6CD0E8E11FEB053d6);
    IFWAMarket constant FWA = IFWAMarket(0x2b019Cfb591988D28C64C4f4be6a24b1592BBF25);
    ICCCore constant CC_CORE = ICCCore(0xcdb1889ae12074d750CD9B8531B692015465e0dD);
    ICCController CC; // Core's controller now (V2 0xCD64… on 2026-10-22; V1 0x222C… before)
    BatchFactory constant TOKEN_FACTORY = BatchFactory(0x1Ea4b73dE4e946bc58A9A477a7291abe7D7417C1);

    Sweeper sweeper;
    Batch batch;
    address buyer = makeAddr("buyer");
    uint256[] pile; // two Credits the engine sells now
    uint256[] prices;

    function setUp() public {
        vm.createSelectFork(vm.envOr("MAINNET_RPC", string("https://ethereum-rpc.publicnode.com")));
        CC = ICCController(CC_CORE.controller());
        sweeper = new Sweeper(SEAPORT, TOKEN_FACTORY, 200, FWA, STRATEGY, CC_CORE);

        // The open batch with room that takes any Credit (Mixed).
        address[] memory bs = TOKEN_FACTORY.batches(0, 20);
        for (uint256 i; i < bs.length && address(batch) == address(0); ++i) {
            Batch b = Batch(bs[i]);
            if (b.state() == Batch.State.Open && b.count() <= 78 && b.filter().palettes == 0) batch = b;
        }
        require(address(batch) != address(0), "no open Mixed batch");

        // Two Credits the engine's pile sells right now, with their prices.
        if (!CC.creditSaleOn()) return;
        uint256[] memory page = ICCPile(address(CC_CORE)).pilePage(0, 200);
        for (uint256 i; i < page.length && pile.length < 2; ++i) {
            try CC.creditPrice(page[i]) returns (uint256 p) {
                if (p != 0) {
                    pile.push(page[i]);
                    prices.push(p);
                }
            } catch {}
        }
        vm.deal(buyer, 10 ether);
    }

    function test_Fork_BuysFromTheCCPile_IntoTheMixedBatch_InTheBuyersName() public {
        if (pile.length < 2) vm.skip(true); // the engine's sale is off or its pile too small at this block: reported as skipped, not passed
        Sweeper.CCListing[] memory l = new Sweeper.CCListing[](2);
        // Quoted with 2% room, as the page will: the engine charges its price at the buy and refunds the rest.
        l[0] = Sweeper.CCListing(pile[0], prices[0] * 102 / 100);
        l[1] = Sweeper.CCListing(pile[1], prices[1] * 102 / 100);
        uint256 cost = prices[0] + prices[1];
        uint256 countBefore = batch.count();
        uint256 feeBefore = TOKEN_FACTORY.feeRecipient().balance;
        uint256 buyerBefore = buyer.balance;
        uint256 sweeperBefore = address(sweeper).balance; // Foundry's deploy address holds someone's dust on mainnet

        uint256 value = sweeper.quote(cost * 102 / 100); // read before the prank, which the next call takes
        vm.prank(buyer);
        uint256[] memory ids = sweeper.sweepEvery{value: value}(
            address(batch), new AdvancedOrder[](0), new Sweeper.FWAListing[](0), new Sweeper.StrategyListing[](0), l, 2, 200
        );

        assertEq(ids.length, 2);
        assertEq(batch.count(), countBefore + 2);
        assertEq(batch.depositorOf(pile[0]), buyer);
        assertEq(batch.depositorOf(pile[1]), buyer);
        assertEq(CREDITS.ownerOf(pile[0]), address(batch));
        // Paid the engine's prices (same block, so the quote holds) plus our 2%, nothing more.
        assertEq(buyerBefore - buyer.balance, cost + cost * 200 / 10_000);
        assertEq(TOKEN_FACTORY.feeRecipient().balance - feeBefore, cost * 200 / 10_000);
        assertEq(address(sweeper).balance, sweeperBefore); // holds nothing of the buyer's
    }

    function test_Fork_BuyEvery_SendsAPileCreditToTheWallet() public {
        if (pile.length < 1) vm.skip(true); // the engine's sale is off or its pile too small at this block: reported as skipped, not passed
        Sweeper.CCListing[] memory l = new Sweeper.CCListing[](1);
        l[0] = Sweeper.CCListing(pile[0], prices[0] * 102 / 100);
        uint256 value = sweeper.quote(prices[0] * 102 / 100);
        uint256 buyerBefore = buyer.balance;
        vm.prank(buyer);
        uint256[] memory ids = sweeper.buyEvery{value: value}(
            new AdvancedOrder[](0), new Sweeper.FWAListing[](0), new Sweeper.StrategyListing[](0), l, 1, 200
        );
        assertEq(ids.length, 1);
        assertEq(CREDITS.ownerOf(pile[0]), buyer);
        assertEq(buyerBefore - buyer.balance, prices[0] + prices[0] * 200 / 10_000);
    }

    function test_Fork_ARepricedPileCreditIsSkipped() public {
        if (pile.length < 2) vm.skip(true); // the engine's sale is off or its pile too small at this block: reported as skipped, not passed
        Sweeper.CCListing[] memory l = new Sweeper.CCListing[](2);
        l[0] = Sweeper.CCListing(pile[0], prices[0] - 1); // a wei under its price now: skipped
        l[1] = Sweeper.CCListing(pile[1], prices[1]);
        uint256 value = sweeper.quote(prices[0] + prices[1]);
        vm.prank(buyer);
        uint256[] memory ids = sweeper.sweepEvery{value: value}(
            address(batch), new AdvancedOrder[](0), new Sweeper.FWAListing[](0), new Sweeper.StrategyListing[](0), l, 1, 200
        );
        assertEq(ids.length, 1);
        assertEq(ids[0], pile[1]);
        assertEq(batch.depositorOf(pile[1]), buyer);
        assertTrue(CREDITS.ownerOf(pile[0]) != address(batch));
    }
}
