// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {Batch, IRatings} from "../src/Batch.sol";
import {BatchFactory} from "../src/BatchFactory.sol";
import {Sweeper} from "../src/Sweeper.sol";
import {IFWAMarket} from "../src/interfaces/IFWAMarket.sol";
import {IAssembler} from "../src/interfaces/IAssembler.sol";
import {ICredits} from "../src/interfaces/ICredits.sol";
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

/// @notice Against mainnet: the real Credits and the real Seaport 1.6.
///         MAINNET_RPC=<url> forge test --match-path test/Sweeper.fork.t.sol
contract SweeperForkTest is Test {
    ICredits constant CREDITS = ICredits(0x97630aA70AB14ed9883B41dAfccBc11349723043);
    ISeaport constant SEAPORT = ISeaport(0x0000000000000068F116a894984e2DB1123eB395);

    BatchFactory factory;
    Sweeper sweeper;
    Batch batch;
    address fee = makeAddr("fee");
    address creator;
    address buyer = makeAddr("buyer");
    uint256 sellerKey = 0xA11CE;
    address seller;
    uint256[] forSale;

    function setUp() public {
        vm.createSelectFork(vm.envOr("MAINNET_RPC", string("https://ethereum-rpc.publicnode.com")));
        seller = vm.addr(sellerKey);

        // minOpen 1 so a single real holder can open a test batch
        factory = new BatchFactory(CREDITS, IRatings(address(0)), IAssembler(address(0)), address(this), fee, 100, 0, 1);
        sweeper = new Sweeper(SEAPORT, factory, 100, IFWAMarket(address(0)));

        // Find live Credits: one for the creator, three to move to our seller.
        uint256 id = 1000;
        while (forSale.length < 3 || creator == address(0)) {
            try CREDITS.ownerOf(id) returns (address o) {
                if (o.code.length == 0) {
                    if (creator == address(0)) {
                        creator = o;
                        uint256[] memory one = new uint256[](1);
                        one[0] = id;
                        vm.startPrank(o);
                        CREDITS.setApprovalForAll(address(factory), true);
                        batch = Batch(factory.create("Fork", Batch.Filter(0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0), new uint256[](0), 0, Batch.Arrangement.Deposit, Batch.Split.Equal, 14 days, one, 100, 0));
                        vm.stopPrank();
                    } else {
                        vm.prank(o);
                        CREDITS.transferFrom(o, seller, id);
                        forSale.push(id);
                    }
                }
            } catch {}
            ++id;
        }
        vm.prank(seller);
        CREDITS.setApprovalForAll(address(SEAPORT), true);
        vm.deal(buyer, 10 ether);
    }

    function _listing(uint256 id, uint256 price) internal view returns (AdvancedOrder memory o) {
        OfferItem[] memory offer = new OfferItem[](1);
        offer[0] = OfferItem(ItemType.ERC721, address(CREDITS), id, 1, 1);
        ConsiderationItem[] memory cons = new ConsiderationItem[](2);
        uint256 royalty = price / 100;
        cons[0] = ConsiderationItem(ItemType.NATIVE, address(0), 0, price - royalty, price - royalty, payable(seller));
        cons[1] = ConsiderationItem(ItemType.NATIVE, address(0), 0, royalty, royalty, payable(address(0xC0FFEE)));

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

    function test_SweepBuysDepositsAndChargesOnePercent() public {
        AdvancedOrder[] memory orders = new AdvancedOrder[](3);
        uint256 total;
        for (uint256 i; i < 3; ++i) {
            uint256 price = 0.03 ether + i * 0.001 ether;
            orders[i] = _listing(forSale[i], price);
            total += price;
        }
        uint256 sellerBefore = seller.balance;
        uint256 send = sweeper.quote(total) + 0.5 ether; // overpay; the rest comes back
        uint256 dust = address(sweeper).balance; // mainnet addresses can hold pre-existing dust

        vm.prank(buyer);
        uint256[] memory ids = sweeper.sweep{value: send}(address(batch), orders, 3, 500);

        assertEq(ids.length, 3);
        for (uint256 i; i < 3; ++i) {
            assertEq(CREDITS.ownerOf(forSale[i]), address(batch));
            assertEq(batch.depositorOf(forSale[i]), buyer);
        }
        assertEq(batch.sharesOf(buyer), 3);
        assertEq(fee.balance, total / 100);
        assertEq(buyer.balance, 10 ether - total - total / 100); // extra 0.5 refunded
        assertEq(seller.balance - sellerBefore, total - total / 100); // minus the 1% royalty item
        assertEq(address(sweeper).balance, dust); // holds nothing of ours afterwards

        // The buyer owns the deposit: they can withdraw while the batch is open.
        vm.prank(buyer);
        batch.withdraw(ids);
        assertEq(CREDITS.ownerOf(forSale[0]), buyer);
    }

    function test_SkipsFilledListingAndEnforcesMin() public {
        AdvancedOrder[] memory orders = new AdvancedOrder[](2);
        orders[0] = _listing(forSale[0], 0.03 ether);
        orders[1] = _listing(forSale[1], 0.03 ether);
        // Someone else fills the first listing first; Seaport now reports it unavailable.
        address other = makeAddr("other");
        vm.deal(other, 1 ether);
        AdvancedOrder[] memory first = new AdvancedOrder[](1);
        first[0] = orders[0];
        vm.prank(other);
        sweeper.sweep{value: 0.0303 ether}(address(batch), first, 1, 500);

        vm.prank(buyer);
        vm.expectRevert();
        sweeper.sweep{value: 0.07 ether}(address(batch), orders, 2, 500);

        vm.prank(buyer);
        uint256[] memory ids = sweeper.sweep{value: 0.07 ether}(address(batch), orders, 1, 500);
        assertEq(ids.length, 1);
        assertEq(ids[0], forSale[1]);
        assertEq(buyer.balance, 10 ether - 0.03 ether - 0.0003 ether);
    }

    function test_FeeMustBeCovered() public {
        AdvancedOrder[] memory orders = new AdvancedOrder[](1);
        orders[0] = _listing(forSale[0], 0.03 ether);
        vm.prank(buyer);
        vm.expectRevert(abi.encodeWithSelector(Sweeper.FeeNotCovered.selector, 0.0003 ether));
        sweeper.sweep{value: 0.03 ether}(address(batch), orders, 1, 500);
    }

    function test_RejectsNonBatchAndNonCredit() public {
        AdvancedOrder[] memory orders = new AdvancedOrder[](1);
        orders[0] = _listing(forSale[0], 0.03 ether);
        vm.prank(buyer);
        vm.expectRevert(Sweeper.NotBatch.selector);
        sweeper.sweep{value: 1 ether}(address(0xdead), orders, 1, 500);

        orders[0].parameters.offer[0].token = address(0x1234);
        vm.prank(buyer);
        vm.expectRevert(abi.encodeWithSelector(Sweeper.NotACredit.selector, 0));
        sweeper.sweep{value: 1 ether}(address(batch), orders, 1, 500);
    }
}
