// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test, stdError} from "forge-std/Test.sol";
import {Batch, IRatings} from "../../src/Batch.sol";
import {BatchFactory} from "../../src/BatchFactory.sol";
import {Sweeper} from "../../src/Sweeper.sol";
import {ICreditStrategy} from "../../src/interfaces/ICreditStrategy.sol";
import {IFWAMarket} from "../../src/interfaces/IFWAMarket.sol";
import {IAssembler} from "../../src/interfaces/IAssembler.sol";
import {ICredits} from "../../src/interfaces/ICredits.sol";
import {
    AdvancedOrder,
    ConsiderationItem,
    ISeaport,
    ItemType,
    OfferItem,
    OrderComponents,
    OrderParameters,
    OrderType
} from "../../src/interfaces/ISeaport.sol";

/// @dev Minimal view of the OpenSea SignedZone (SIP-5 metadata).
interface ISignedZone {
    struct Schema {
        uint256 id;
        bytes metadata;
    }

    function getSeaportMetadata() external view returns (string memory name, Schema[] memory schemas);
}

/// @dev A consideration recipient that, when paid, dumps its own ETH on the Sweeper.
contract TipsTheSweeper {
    address payable immutable sweeper;

    constructor(address payable s) payable {
        sweeper = s;
    }

    receive() external payable {
        (bool ok,) = sweeper.call{value: address(this).balance}("");
        require(ok);
    }
}

/// @notice Audit tests against mainnet: real Credits, real Seaport 1.6, real OpenSea signed zone.
///         MAINNET_RPC=<url> forge test --match-path test/AuditSweeper.fork.t.sol
contract AuditSweeperForkTest is Test {
    ICredits constant CREDITS = ICredits(0x97630aA70AB14ed9883B41dAfccBc11349723043);
    ISeaport constant SEAPORT = ISeaport(0x0000000000000068F116a894984e2DB1123eB395);
    /// @dev OpenSea's SIP-7 signed zone for Seaport 1.6 ("OpenSeaSignedZone", version 2.0).
    address constant ZONE = 0x000056F7000000EcE9003ca63978907a00FFD100;

    BatchFactory factory;
    Sweeper sweeper;
    Batch batch;
    address fee = makeAddr("fee");
    address creator;
    address buyer = makeAddr("buyer");
    uint256 sellerKey = 0xA11CE;
    address seller;
    uint256 zoneSignerKey = 0x5151;
    address zoneSigner;
    bytes32 zoneDomain;
    uint256[] forSale;

    function setUp() public {
        vm.createSelectFork(vm.envOr("MAINNET_RPC", string("https://ethereum-rpc.publicnode.com")));
        seller = vm.addr(sellerKey);
        zoneSigner = vm.addr(zoneSignerKey);

        factory = new BatchFactory(CREDITS, IRatings(address(0)), IAssembler(address(0)), address(this), fee, 100, 0, 1);
        sweeper = new Sweeper(SEAPORT, factory, 100, IFWAMarket(address(0)), ICreditStrategy(address(0)));

        // Live Credits: one for the creator, four to the seller.
        uint256 id = 1000;
        while (forSale.length < 4 || creator == address(0)) {
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

        // Register our own SIP-7 signer in the real zone: `_signers` is its first storage slot.
        vm.store(ZONE, keccak256(abi.encode(zoneSigner, uint256(0))), bytes32(uint256(1)));
        (bool ok, bytes memory ret) = ZONE.call(abi.encodeWithSignature("isActiveSigner(address)", zoneSigner));
        assertTrue(ok && abi.decode(ret, (bool)), "zone signer not registered");

        // Zone EIP-712 domain, checked against what the zone publishes.
        zoneDomain = keccak256(
            abi.encode(
                keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"),
                keccak256("OpenSeaSignedZone"),
                keccak256("2.0"),
                block.chainid,
                ZONE
            )
        );
        (, ISignedZone.Schema[] memory schemas) = ISignedZone(ZONE).getSeaportMetadata();
        (bytes32 published,,,) = abi.decode(schemas[0].metadata, (bytes32, string, uint256[], string));
        assertEq(zoneDomain, published, "zone domain mismatch");
    }

    // ---------------------------------------------------------------- order builders

    function _components(uint256 id, uint256 price, OrderType t, address zone, address royaltyTo)
        internal
        view
        returns (OrderComponents memory c)
    {
        OfferItem[] memory offer = new OfferItem[](1);
        offer[0] = OfferItem(ItemType.ERC721, address(CREDITS), id, 1, 1);
        ConsiderationItem[] memory cons = new ConsiderationItem[](2);
        uint256 royalty = price / 100;
        cons[0] = ConsiderationItem(ItemType.NATIVE, address(0), 0, price - royalty, price - royalty, payable(seller));
        cons[1] = ConsiderationItem(ItemType.NATIVE, address(0), 0, royalty, royalty, payable(royaltyTo));
        c = OrderComponents({
            offerer: seller,
            zone: zone,
            offer: offer,
            consideration: cons,
            orderType: t,
            startTime: block.timestamp - 1,
            endTime: block.timestamp + 1 days,
            zoneHash: bytes32(0),
            salt: id,
            conduitKey: bytes32(0),
            counter: SEAPORT.getCounter(seller)
        });
    }

    function _sign(OrderComponents memory c) internal view returns (AdvancedOrder memory o, bytes32 orderHash) {
        (, bytes32 domain,) = SEAPORT.information();
        orderHash = SEAPORT.getOrderHash(c);
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(sellerKey, keccak256(abi.encodePacked("\x19\x01", domain, orderHash)));
        o.parameters = OrderParameters(
            c.offerer,
            c.zone,
            c.offer,
            c.consideration,
            c.orderType,
            c.startTime,
            c.endTime,
            c.zoneHash,
            c.salt,
            c.conduitKey,
            c.consideration.length
        );
        o.numerator = 1;
        o.denominator = 1;
        o.signature = abi.encodePacked(r, s, v);
    }

    /// @dev Plain OpenSea listing: FULL_OPEN, no zone (the shape the existing fork tests use).
    function _open(uint256 id, uint256 price) internal view returns (AdvancedOrder memory o) {
        (o,) = _sign(_components(id, price, OrderType.FULL_OPEN, address(0), address(0xC0FFEE)));
    }

    /// @dev OpenSea listing with the signed zone: FULL_RESTRICTED + SIP-7 extraData exactly as
    ///      OpenSea's /listings/fulfillment_data returns it:
    ///        [0]      SIP-6 version byte 0x00
    ///        [1:21]   expected fulfiller (the address the API was asked to sign for)
    ///        [21:29]  expiration (uint64, ~5 minutes on mainnet)
    ///        [29:93]  64-byte compact signature over SignedOrder(fulfiller, expiration, orderHash, context)
    ///        [93:126] context: substandard byte 0x00 + expected received identifier (0 for ETH listings)
    function _restricted(uint256 id, uint256 price, address fulfiller, uint64 expiration)
        internal
        view
        returns (AdvancedOrder memory o)
    {
        bytes32 orderHash;
        (o, orderHash) = _sign(_components(id, price, OrderType.FULL_RESTRICTED, ZONE, address(0xC0FFEE)));
        bytes memory context = abi.encodePacked(bytes1(0x00), bytes32(0));
        bytes32 signedOrderHash = keccak256(
            abi.encode(
                keccak256("SignedOrder(address fulfiller,uint64 expiration,bytes32 orderHash,bytes context)"),
                fulfiller,
                expiration,
                orderHash,
                keccak256(context)
            )
        );
        (uint8 v, bytes32 r, bytes32 s) =
            vm.sign(zoneSignerKey, keccak256(abi.encodePacked("\x19\x01", zoneDomain, signedOrderHash)));
        bytes32 vs = bytes32(uint256(s) | (uint256(v - 27) << 255));
        o.extraData = abi.encodePacked(bytes1(0x00), fulfiller, expiration, r, vs, context);
        assertEq(o.extraData.length, 126);
    }

    // ---------------------------------------------------------------- restricted (signed zone) realism

    /// @dev The Sweeper path works for OpenSea's FULL_RESTRICTED listings when the server asks OpenSea to
    ///      sign for the Sweeper (it does: fulfiller: { address: sweeper } in web/src/worker/opensea.ts).
    function test_RestrictedListing_FulfillsWhenSignedForSweeper() public {
        AdvancedOrder[] memory orders = new AdvancedOrder[](2);
        orders[0] = _restricted(forSale[0], 0.03 ether, address(sweeper), uint64(block.timestamp + 300));
        orders[1] = _open(forSale[1], 0.02 ether); // mixed bundle: one signed-zone, one open
        uint256 total = 0.05 ether;

        uint256 send1 = sweeper.quote(total);
        vm.prank(buyer);
        uint256[] memory ids = sweeper.sweep{value: send1}(address(batch), orders, 2, 500);

        assertEq(ids.length, 2);
        assertEq(CREDITS.ownerOf(forSale[0]), address(batch));
        assertEq(CREDITS.ownerOf(forSale[1]), address(batch));
        assertEq(batch.depositorOf(forSale[0]), buyer);
        assertEq(fee.balance, total / 100);
        assertEq(buyer.balance, 10 ether - total - total / 100);
    }

    /// @dev Signing for address(0) means "any fulfiller" in SIP-7; the Sweeper is fine with that too.
    function test_RestrictedListing_FulfillsWhenSignedForAnyFulfiller() public {
        AdvancedOrder[] memory orders = new AdvancedOrder[](1);
        orders[0] = _restricted(forSale[0], 0.03 ether, address(0), uint64(block.timestamp + 300));
        uint256 send2 = sweeper.quote(0.03 ether);
        vm.prank(buyer);
        sweeper.sweep{value: send2}(address(batch), orders, 1, 500);
        assertEq(CREDITS.ownerOf(forSale[0]), address(batch));
    }

    /// @dev If fulfillment_data is requested for the buyer's own address instead of the Sweeper, the zone's
    ///      authorizeOrder reverts (InvalidFulfiller), Seaport marks the order unavailable, and the
    ///      Sweeper refunds. Nothing is bought; the Sweeper is not the fulfiller OpenSea signed for.
    function test_RestrictedListing_SkippedWhenSignedForBuyer() public {
        AdvancedOrder[] memory orders = new AdvancedOrder[](2);
        orders[0] = _restricted(forSale[0], 0.03 ether, buyer, uint64(block.timestamp + 300));
        orders[1] = _open(forSale[1], 0.02 ether);

        uint256 send3 = sweeper.quote(0.05 ether);
        vm.prank(buyer);
        vm.expectRevert(abi.encodeWithSelector(Sweeper.TooFewBought.selector, 1));
        sweeper.sweep{value: send3}(address(batch), orders, 2, 500);

        // Skipped, not reverted: the open listing still goes through with minBought 1.
        uint256 send4 = sweeper.quote(0.05 ether);
        vm.prank(buyer);
        uint256[] memory ids = sweeper.sweep{value: send4}(address(batch), orders, 1, 500);
        assertEq(ids.length, 1);
        assertEq(ids[0], forSale[1]);
        assertEq(CREDITS.ownerOf(forSale[0]), seller);
        assertEq(buyer.balance, 10 ether - 0.02 ether - 0.0002 ether);
    }

    /// @dev OpenSea's zone signatures expire (~5 minutes on mainnet). A stale quote is skipped by Seaport,
    ///      and when *every* order is skipped Seaport itself reverts with NoSpecifiedOrdersAvailable(), so
    ///      `TooFewBought(0)` is unreachable in practice; the buyer sees Seaport's error, not the Sweeper's.
    function test_RestrictedListing_SkippedWhenZoneSignatureExpired() public {
        AdvancedOrder[] memory orders = new AdvancedOrder[](1);
        orders[0] = _restricted(forSale[0], 0.03 ether, address(sweeper), uint64(block.timestamp + 300));
        skip(301);
        uint256 send5 = sweeper.quote(0.03 ether);
        vm.prank(buyer);
        vm.expectRevert(bytes4(keccak256("NoSpecifiedOrdersAvailable()")));
        sweeper.sweep{value: send5}(address(batch), orders, 1, 500);
    }

    // ---------------------------------------------------------------- ETH accounting

    /// @dev `spent` comes from Seaport's execution log, not a balance delta: a consideration recipient
    ///      that pushes its own ETH at the Sweeper mid-call neither reverts the sweep nor changes the fee.
    function test_ExtraEthDuringSeaportCallDoesNotDistortSpent() public {
        TipsTheSweeper fwd = new TipsTheSweeper{value: 1 ether}(payable(address(sweeper)));
        (AdvancedOrder memory bad,) =
            _sign(_components(forSale[0], 0.03 ether, OrderType.FULL_OPEN, address(0), address(fwd)));
        AdvancedOrder[] memory orders = new AdvancedOrder[](2);
        orders[0] = bad;
        orders[1] = _open(forSale[1], 0.02 ether);

        uint256 send6 = sweeper.quote(0.05 ether);
        uint256 feeBefore = fee.balance;
        uint256 buyerBefore = buyer.balance;
        vm.prank(buyer);
        uint256[] memory ids = sweeper.sweep{value: send6}(address(batch), orders, 2, 500);
        assertEq(ids.length, 2);
        assertEq(fee.balance - feeBefore, 0.05 ether / 100); // fee on the real listings total
        assertEq(buyerBefore - buyer.balance, send6); // buyer paid exactly the quote, nothing more
    }

    // ---------------------------------------------------------------- availability semantics

    /// @dev Seaport semantics, documented: only orders that fail *validation* are skipped. A listing whose
    ///      seller has since moved the Credit (or revoked approval) fails at transfer and reverts the whole
    ///      sweep. The quote endpoint therefore checks ownership and approval per listing before returning it.
    function test_ListingWhoseSellerMovedTokenRevertsWholeSweep() public {
        AdvancedOrder[] memory orders = new AdvancedOrder[](2);
        orders[0] = _open(forSale[0], 0.03 ether);
        orders[1] = _open(forSale[1], 0.02 ether);
        vm.prank(seller);
        CREDITS.transferFrom(seller, makeAddr("elsewhere"), forSale[0]);

        uint256 send7 = sweeper.quote(0.05 ether);
        vm.prank(buyer);
        vm.expectRevert();
        sweeper.sweep{value: send7}(address(batch), orders, 1, 500);
    }

    // ---------------------------------------------------------------- stray Credits

    /// @dev The Sweeper has no ERC721 receiver hook, so a safeTransferFrom of a stray Credit fails instead
    ///      of stranding it. A plain transferFrom still strands it (ERC721 offers no defence), and no
    ///      order shape can extract it: offerer == Sweeper orders skip the signature check but fail at
    ///      transfer because the Sweeper never approved Seaport.
    function test_StrayCreditCannotBeCapturedButIsStuckForever() public {
        uint256 stray = forSale[3];
        vm.prank(seller);
        vm.expectRevert();
        CREDITS.safeTransferFrom(seller, address(sweeper), stray);
        vm.prank(seller);
        CREDITS.transferFrom(seller, address(sweeper), stray);
        assertEq(CREDITS.ownerOf(stray), address(sweeper));

        address attacker = makeAddr("attacker");
        vm.deal(attacker, 1 ether);
        AdvancedOrder[] memory orders = new AdvancedOrder[](1);

        // Offerer = Sweeper (no signature needed), amount 1: Seaport tries transferFrom(sweeper, sweeper).
        OfferItem[] memory offer = new OfferItem[](1);
        offer[0] = OfferItem(ItemType.ERC721, address(CREDITS), stray, 1, 1);
        orders[0].parameters = OrderParameters(
            address(sweeper),
            address(0),
            offer,
            new ConsiderationItem[](0),
            OrderType.FULL_OPEN,
            block.timestamp - 1,
            block.timestamp + 1 days,
            bytes32(0),
            1,
            bytes32(0),
            0
        );
        orders[0].numerator = 1;
        orders[0].denominator = 1;
        vm.prank(attacker);
        vm.expectRevert();
        sweeper.sweep{value: 0.01 ether}(address(batch), orders, 1, 500);

        // Zero-amount offer: would be "available" without a transfer, but Seaport rejects it outright.
        orders[0].parameters.offer[0].startAmount = 0;
        orders[0].parameters.offer[0].endAmount = 0;
        vm.prank(attacker);
        vm.expectRevert();
        sweeper.sweep{value: 0.01 ether}(address(batch), orders, 1, 500);

        assertEq(CREDITS.ownerOf(stray), address(sweeper)); // safe from attackers, and from everyone else
    }
}
