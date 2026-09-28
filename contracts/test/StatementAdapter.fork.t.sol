// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {Batch} from "../src/Batch.sol";
import {BatchFactory} from "../src/BatchFactory.sol";
import {StatementAdapter, IUnions} from "../src/StatementAdapter.sol";
import {ICredits} from "../src/interfaces/ICredits.sol";
import {IStatements} from "../src/interfaces/IStatements.sol";
import {MockStatement} from "../src/mocks/MockStatement.sol";

/// @notice Burn day rehearsed on a copy of mainnet: the real Credits, the real factory and the real All Credits
///         union, filled to 80 with real holders' Credits; the real Safe proposes the adapter at 7:30pm ET and it
///         goes live at 8pm; the union counts down, burns, auctions its Statement and pays every member.
///         Until Jack publishes his contract, MockStatement stands in for it. When he does, finish
///         StatementAdapter._compose and run this against his contract with STATEMENTS=<his address>.
///         MAINNET_RPC=<url> [STATEMENTS=<address>] forge test --match-path test/StatementAdapter.fork.t.sol -vv
contract StatementAdapterForkTest is Test {
    ICredits constant CREDITS = ICredits(0x97630aA70AB14ed9883B41dAfccBc11349723043);
    BatchFactory constant FACTORY = BatchFactory(0xcb06f9076e5fbF3cB052086b1EE7C0F3836aa051);
    Batch constant UNION = Batch(0x939b8a4bdefB975C8Aac6EAe20D578cC1E026F22); // All Credits: takes any Credit
    uint256 constant OPENS = 1790899200; // Oct 2 2026 00:00 UTC (Oct 1, 8pm ET): Jack's contract opens
    uint256 constant KEEPER_GAS = 12_000_000; // what the keeper and the page send with assemble()

    IStatements statements;
    StatementAdapter adapter;
    bool standIn;

    function setUp() public {
        vm.createSelectFork(vm.envOr("MAINNET_RPC", string("https://ethereum-rpc.publicnode.com")));
        address jack = vm.envOr("STATEMENTS", address(0));
        standIn = jack == address(0);
        statements = standIn ? IStatements(address(new MockStatement(CREDITS))) : IStatements(jack);
        adapter = new StatementAdapter(CREDITS, statements, IUnions(address(FACTORY)));
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

    function test_burnDay() public {
        assertEq(address(FACTORY.assembler()), address(0), "mainnet has no adapter yet");
        _fill();
        assertEq(uint8(UNION.phase()), uint8(Batch.Phase.Waiting), "full, never locked without an adapter");

        // The creator picks a direction while everyone can still leave.
        vm.prank(UNION.creator());
        adapter.chooseDirection(address(UNION), StatementAdapter.Direction.Balance);

        // 7:30pm ET: the Safe proposes. 8pm: the notice has run and it's switched on (the keeper does this).
        vm.warp(OPENS - 30 minutes);
        vm.prank(FACTORY.assemblerSetter());
        FACTORY.proposeAssembler(adapter);
        skip(FACTORY.ASSEMBLER_DELAY());
        FACTORY.activateAssembler();
        assertEq(uint8(UNION.phase()), uint8(Batch.Phase.Countdown), "5 minutes' notice before it locks");
        skip(UNION.LOCK_DELAY());

        // The burn.
        uint256[] memory order = UNION.burnOrder();
        uint256 before = gasleft();
        UNION.assemble();
        uint256 used = before - gasleft();
        emit log_named_uint("gas to burn one union", used);
        assertLt(used, KEEPER_GAS, "raise ASSEMBLE_GAS in web/src/worker/keeper.ts and the page");

        uint256 sid = UNION.statementId();
        assertEq(statements.ownerOf(sid), address(UNION), "the union owns its Statement");
        for (uint256 i; i < order.length; ++i) {
            try CREDITS.ownerOf(order[i]) returns (address) {
                revert("a Credit survived the burn");
            } catch {}
        }
        if (standIn) {
            assertEq(MockStatement(address(statements)).directionOf(sid), uint8(StatementAdapter.Direction.Balance));
            assertEq(MockStatement(address(statements)).orderOf(sid), order, "burned in the union's order");
        }

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
}
