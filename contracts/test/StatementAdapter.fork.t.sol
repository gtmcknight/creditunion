// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {ratingsOf} from "../script/RatingsOf.sol";
import {Batch} from "../src/Batch.sol";
import {BatchFactory} from "../src/BatchFactory.sol";
import {StatementAdapter, IUnions} from "../src/StatementAdapter.sol";
import {UnionFormats} from "../src/UnionFormats.sol";
import {ICreditArt, ICredits} from "../src/interfaces/ICredits.sol";
import {IStatements} from "../src/interfaces/IStatements.sol";

/// The Statements contract's drawing and rating contracts, cooled before a burn's gas is measured.
interface IStatementsParts {
    function art() external view returns (address);
    function score() external view returns (address);
}

/// @notice Burn day rehearsed on a copy of mainnet: the real Credits, the real factory and the real All Credits
///         union, filled to 80 with real holders' Credits; the real Safe proposes the adapter and it goes live 30
///         minutes later; the union counts down, burns, auctions its Statement and pays every member.
///         It runs on the block before burning switched on (Oct 1 2026), against the live Statements contract,
///         so it needs an archive node: MAINNET_RPC=<url> forge test --match-path test/StatementAdapter.fork.t.sol -vv
contract StatementAdapterForkTest is Test {
    ICredits constant CREDITS = ICredits(0x97630aA70AB14ed9883B41dAfccBc11349723043);
    BatchFactory constant FACTORY = BatchFactory(0xcb06f9076e5fbF3cB052086b1EE7C0F3836aa051);
    Batch constant UNION = Batch(0x939b8a4bdefB975C8Aac6EAe20D578cC1E026F22); // All Credits: takes any Credit
    address constant CUSTODY = 0xc8f8e2F59Dd95fF67c3d39109ecA2e2A017D4c8a; // visualizevalue.eth, holds 365 Credits
    address constant LIVE_STATEMENTS = 0x75Edd94b7e49b3bD5C8047b91F165A5e265a069b; // deployed in block 26100733
    address constant LIVE_FORMATS = 0x16deCDa20c9164CcfDB4BE189557aDc4614aAedC; // UnionFormats
    /// @dev After the Statements contract and the adapter were deployed, before the adapter switched on (26100967).
    uint256 constant BEFORE_SWITCH_ON = 26100900;
    /// @dev EIP-7825 (Fusaka, live since Dec 2025): no transaction may carry more gas than this.
    uint256 constant TX_GAS_CAP = 16_777_216;

    /// @dev The heaviest sheet real Credits make: slipped CMYK misprints, most inked bits first (ink in all
    ///      three words of every cell). A Picture union for a dark image picks Credits like these.
    uint256[80] HEAVIEST = [
        30964, 94670, 10444, 84020, 4295, 59389, 70281, 74206, 88049, 106034,
        9, 6512, 49450, 11704, 46402, 49781, 64541, 75008, 85930, 93480,
        99619, 121491, 36782, 104978, 36969, 95197, 100074, 101251, 110963, 9901,
        14018, 29197, 38645, 41755, 52668, 90468, 91102, 41113, 69639, 71168,
        87083, 90256, 90984, 15607, 37261, 38969, 41429, 50105, 56235, 75640,
        85440, 96079, 102077, 112151, 114108, 5843, 10099, 11881, 19649, 46601,
        50391, 76586, 77910, 84566, 93961, 101429, 107371, 118493, 120541, 28363,
        28420, 38711, 40950, 45631, 64016, 80901, 91456, 92088, 106035, 106302
    ];

    IStatements statements;
    UnionFormats formats;
    StatementAdapter adapter;

    function setUp() public {
        string memory rpc = vm.envOr("MAINNET_RPC", string("https://ethereum-rpc.publicnode.com"));
        vm.createSelectFork(rpc, vm.envOr("FORK_BLOCK", BEFORE_SWITCH_ON)); // pinned: forge caches it between runs
        statements = IStatements(vm.envOr("STATEMENTS", LIVE_STATEMENTS));
        formats = UnionFormats(vm.envOr("FORMATS", LIVE_FORMATS));
        adapter = new StatementAdapter(CREDITS, statements, IUnions(address(FACTORY)), formats);
        // The Statements contract opens composing at a fixed second (composeOpensAt): before it every burn reverts,
        // so the copy of mainnet jumps to that second.
        (bool ok, bytes memory opens) = address(statements).staticcall(abi.encodeWithSignature("composeOpensAt()"));
        if (ok && opens.length == 32) {
            uint256 at = abi.decode(opens, (uint256));
            if (block.timestamp < at) vm.warp(at);
        }
    }

    /// Real holders' Credits, one wallet at a time, until the union holds 80.
    function _fill() internal {
        uint256 need = 80 - UNION.count();
        uint256[] memory one = new uint256[](1);
        for (uint256 id = 5000; need > 0; ++id) {
            address holder;
            try CREDITS.ownerOf(id) returns (address a) {
                holder = a;
            } catch {
                continue;
            }
            if (holder.code.length != 0) continue; // wallets only: contracts may be marketplaces or other unions
            one[0] = id;
            vm.startPrank(holder);
            CREDITS.setApprovalForAll(address(FACTORY), true);
            FACTORY.deposit(address(UNION), one);
            vm.stopPrank();
            --need;
        }
        assertEq(UNION.count(), 80);
    }

    function _switchOn() internal {
        vm.prank(FACTORY.assemblerSetter());
        FACTORY.proposeAssembler(adapter);
        skip(FACTORY.ASSEMBLER_DELAY());
        FACTORY.activateAssembler();
        // UNION is live: members come and go, so only a full one is counting down.
        if (UNION.count() == 80) assertEq(uint8(UNION.phase()), uint8(Batch.Phase.Countdown), "5 minutes' notice before it locks");
        skip(UNION.LOCK_DELAY());
    }

    /// Everything a burn touches starts cold, as in a fresh transaction (setup in the same test warmed it).
    function _cool(address union) internal {
        vm.cool(address(CREDITS));
        vm.cool(address(statements));
        vm.cool(IStatementsParts(address(statements)).art());
        vm.cool(IStatementsParts(address(statements)).score());
        vm.cool(address(adapter));
        vm.cool(address(FACTORY));
        vm.cool(union);
    }

    function test_burnDay() public {
        assertEq(address(FACTORY.assembler()), address(0), "mainnet has no adapter yet");
        _fill();
        assertEq(uint8(UNION.phase()), uint8(Batch.Phase.Waiting), "full, never locked without an adapter");

        // The creator picks a format while everyone can still leave.
        vm.prank(UNION.creator());
        formats.pick(address(UNION), 4); // Accrued
        _switchOn();

        // The burn. Gas is checked against the cap separately (test_unionBurnFitsInOneTransaction).
        uint256[] memory order = UNION.burnOrder();
        UNION.assemble();

        uint256 sid = UNION.statementId();
        assertEq(statements.ownerOf(sid), address(UNION), "the union owns its Statement");
        for (uint256 i; i < order.length; ++i) {
            try CREDITS.ownerOf(order[i]) returns (address) {
                revert("a Credit survived the burn");
            } catch {}
        }
        assertEq(statements.formatOf(sid), 4);
        uint32[80] memory cells = statements.composedFrom(sid);
        for (uint256 i; i < 80; ++i) assertEq(cells[i], order[i], "burned in the union's order");

        // The auction, then the sale paid out to every member.
        address[] memory members = new address[](order.length);
        uint256[] memory had = new uint256[](order.length);
        for (uint256 i; i < order.length; ++i) {
            members[i] = UNION.depositorOf(order[i]);
            had[i] = members[i].balance;
        }
        address bidder = makeAddr("bidder");
        uint256 bid = UNION.minBid() + 10 ether;
        vm.deal(bidder, bid);
        vm.prank(bidder);
        UNION.bid{value: bid}();
        skip(UNION.AUCTION_LENGTH());
        UNION.settle();
        assertEq(statements.ownerOf(sid), bidder, "the winner has the Statement");
        for (uint256 i; i < order.length; ++i) {
            if (members[i].code.length == 0) assertGt(members[i].balance, had[i], "every member is paid");
        }
    }

    /// Burn night with the real unions: every union full on mainnet locks the moment the adapter goes live and burns
    /// in that first hour, one after another, each in one transaction.
    function test_everyFullUnionBurns() public {
        address[] memory all = FACTORY.batches(0, FACTORY.batchCount());
        address[] memory full = new address[](all.length);
        uint256 n;
        for (uint256 i; i < all.length; ++i) {
            if (Batch(all[i]).state() == Batch.State.Full) full[n++] = all[i];
        }
        emit log_named_uint("full unions", n);
        vm.prank(FACTORY.assemblerSetter());
        FACTORY.proposeAssembler(adapter);
        skip(FACTORY.ASSEMBLER_DELAY());
        FACTORY.activateAssembler();
        skip(5 minutes);
        uint256 heaviest;
        for (uint256 i; i < n; ++i) {
            Batch b = Batch(full[i]);
            assertEq(uint8(b.phase()), uint8(Batch.Phase.Burnable));
            _cool(address(b));
            uint256 g = gasleft();
            b.assemble();
            uint256 used = g - gasleft();
            if (used > heaviest) heaviest = used;
            assertEq(statements.ownerOf(b.statementId()), address(b));
        }
        emit log_named_uint("heaviest union burn gas (before refunds)", heaviest);
        assertLt(heaviest, TX_GAS_CAP, "every burn fits in one transaction");
    }

    /// Gas before refunds, which is what a transaction's gas limit has to cover: a holder composing 80 real
    /// Credits directly, then the union's burn through the adapter. The difference is what our path adds.
    function test_unionBurnFitsInOneTransaction() public {
        uint256[] memory held = CREDITS.tokensOf(CUSTODY);
        uint256[80] memory ids;
        for (uint256 i; i < 80; ++i) ids[i] = held[i];
        vm.startPrank(CUSTODY);
        CREDITS.setApprovalForAll(address(statements), true);
        _cool(address(0));
        uint256 g = gasleft();
        statements.compose(ids, 0);
        uint256 direct = g - gasleft();
        vm.stopPrank();

        _fill();
        _switchOn();
        _cool(address(UNION));
        g = gasleft();
        UNION.assemble();
        uint256 union = g - gasleft();

        emit log_named_uint("holder composes 80 directly", direct);
        emit log_named_uint("union burns 80 through the adapter", union);
        emit log_named_uint("the adapter path adds", union - direct);
        emit log_named_uint("transaction gas cap (EIP-7825)", TX_GAS_CAP);
        assertLt(direct, TX_GAS_CAP, "Jack's compose alone doesn't fit in a transaction");
        assertLt(union, TX_GAS_CAP * 9 / 10, "a union burn needs 10% headroom under the cap");
    }

    /// The worst case: a new union holding the heaviest real sheet burns in one transaction.
    function test_heaviestRealSheetFits() public {
        address whale = makeAddr("whale");
        uint256[] memory ids = new uint256[](80);
        for (uint256 i; i < 80; ++i) {
            ids[i] = HEAVIEST[i];
            address holder = CREDITS.ownerOf(ids[i]);
            vm.prank(holder);
            CREDITS.transferFrom(holder, whale, ids[i]);
        }
        Batch.Filter memory any;
        vm.startPrank(whale);
        CREDITS.setApprovalForAll(address(FACTORY), true);
        Batch union = Batch(FACTORY.create("Heaviest", any, new uint256[](0), 0, Batch.Arrangement.Deposit, Batch.Split.Equal, 14 days, ids, FACTORY.protocolFeeBps(), FACTORY.creatorFeeBps(), ratingsOf(address(FACTORY))));
        vm.stopPrank();
        assertEq(union.count(), 80);
        _switchOn();
        _cool(address(union));
        uint256 g = gasleft();
        union.assemble();
        uint256 used = g - gasleft();
        emit log_named_uint("heaviest real sheet, union burn", used);
        assertEq(statements.ownerOf(union.statementId()), address(union));
        assertLt(used, TX_GAS_CAP * 9 / 10, "the heaviest real sheet needs 10% headroom under the cap");
    }

    /// The worst a picture can cost: the heaviest real sheet painted as a picture, its spots recorded and then
    /// every recorded Credit gone (as if all 80 left and others filled in), so the burn rebuilds every spot.
    function test_heaviestRealSheetAsAPictureWithTheCostliestSpots() public {
        address whale = makeAddr("whale");
        uint256[] memory ids = new uint256[](80);
        Batch.Filter memory f;
        ICreditArt art = CREDITS.art();
        for (uint256 i; i < 80; ++i) {
            ids[i] = HEAVIEST[i];
            address holder = CREDITS.ownerOf(ids[i]);
            vm.prank(holder);
            CREDITS.transferFrom(holder, whale, ids[i]);
            bytes memory c = bytes(art.describe(CREDITS.seedOf(ids[i]), CREDITS.timestampOf(ids[i])).colors);
            uint256 m;
            for (uint256 k; k < c.length; ++k) m |= c[k] == "C" ? 1 : c[k] == "M" ? 2 : c[k] == "Y" ? 4 : 8;
            if (i < 64) f.layout0 |= m << (4 * i);
            else f.layout1 |= uint64(m << (4 * (i - 64)));
        }
        vm.startPrank(whale);
        CREDITS.setApprovalForAll(address(FACTORY), true);
        Batch union = Batch(FACTORY.create("Heaviest picture", f, new uint256[](0), 0, Batch.Arrangement.Layout, Batch.Split.Equal, 14 days, ids, FACTORY.protocolFeeBps(), FACTORY.creatorFeeBps(), ratingsOf(address(FACTORY))));
        vm.stopPrank();
        assertTrue(adapter.isPicture(address(union)));
        bytes32 base = keccak256(abi.encode(address(union), uint256(0)));
        for (uint256 w; w < 10; ++w) {
            uint256 word;
            for (uint256 k; k < 8; ++k) word |= (1_000_000 + w * 8 + k) << (32 * k);
            vm.store(address(adapter), bytes32(uint256(base) + w), bytes32(word));
        }
        vm.prank(FACTORY.assemblerSetter());
        FACTORY.proposeAssembler(adapter);
        skip(FACTORY.ASSEMBLER_DELAY());
        FACTORY.activateAssembler();
        skip(union.LOCK_DELAY());
        assertEq(uint8(union.phase()), uint8(Batch.Phase.Burnable));
        _cool(address(union));
        uint256 g = gasleft();
        union.assemble();
        uint256 used = g - gasleft();
        emit log_named_uint("heaviest real sheet as a picture, costliest spots, union burn", used);
        assertEq(statements.ownerOf(union.statementId()), address(union));
        assertLt(used, TX_GAS_CAP * 9 / 10, "the heaviest picture needs 10% headroom under the cap");
    }
}
