// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {Batch, IRatings} from "../src/Batch.sol";
import {BatchFactory} from "../src/BatchFactory.sol";
import {LiveRatings, ICreditScore} from "../src/LiveRatings.sol";
import {ICredits} from "../src/interfaces/ICredits.sol";

interface IStatementsScore {
    function score() external view returns (address);
}

/// @notice LiveRatings on a copy of mainnet: it gives the Statements contract's scores, cut to tenths; the Safe
///         proposes it, it goes live 30 minutes later, a union opened then checks its rating rule against it, and a
///         union opened before keeps the old table.
///     MAINNET_RPC=<url> forge test --match-path test/LiveRatings.fork.t.sol -vv
contract LiveRatingsForkTest is Test {
    ICredits constant CREDITS = ICredits(0x97630aA70AB14ed9883B41dAfccBc11349723043);
    BatchFactory constant FACTORY = BatchFactory(0xcb06f9076e5fbF3cB052086b1EE7C0F3836aa051);
    address constant STATEMENTS = 0x75Edd94b7e49b3bD5C8047b91F165A5e265a069b;
    Batch constant OLD_RULE = Batch(0xaA56EaB8cF50ab369ef0a212ccB40ebEc7dbd1b7); // open, min rating 745.2, old table
    uint256 constant FORK_BLOCK = 26105278;

    ICreditScore scorer;
    LiveRatings live;

    function setUp() public {
        vm.createSelectFork(vm.envString("MAINNET_RPC"), FORK_BLOCK);
        scorer = ICreditScore(IStatementsScore(STATEMENTS).score());
        live = new LiveRatings(CREDITS, scorer, 122_154);
    }

    function test_MatchesTheStatementsScorer() public view {
        uint256[6] memory ids = [uint256(1), 9, 39, 539, 53739, 122154];
        for (uint256 i; i < ids.length; ++i) {
            uint256 s = scorer.scoreOf(CREDITS.seedOf(ids[i]), CREDITS.timestampOf(ids[i]));
            assertEq(live.scoreOf(ids[i]), s / 1000);
        }
        assertEq(live.scoreOf(9), 7970); // 797.0310
        assertEq(live.scoreOf(1), 1324); // 132.4012
        assertEq(live.scoreOf(0), 0);
        assertEq(live.scoreOf(122_155), 0);
        assertEq(live.count(), FACTORY.ratings().count());
    }

    function test_GasPerScore() public {
        uint256 g = gasleft();
        live.scoreOf(9);
        emit log_named_uint("scoreOf gas (cold)", g - gasleft());
        g = gasleft();
        live.scoreOf(39);
        emit log_named_uint("scoreOf gas (warm contracts)", g - gasleft());
    }

    function test_SafeSwitchesNewUnionsOnly() public {
        IRatings oldTable = FACTORY.ratings();
        vm.prank(FACTORY.feeRecipient());
        FACTORY.proposeRatings(IRatings(address(live)));
        vm.warp(block.timestamp + FACTORY.RATINGS_DELAY());
        FACTORY.activateRatings();
        assertEq(address(FACTORY.ratings()), address(live));

        // An open union keeps the old table: #53739 is 745.2 there (745.1549 by the Statements scorer).
        assertEq(address(OLD_RULE.ratings()), address(oldTable));
        assertTrue(OLD_RULE.passes(53739));

        // A union opened now uses the live one: at 750.0, #539 (749.9 in the old table, 750.0496 live) gets in.
        Batch.Filter memory f;
        f.minScore = 7500;
        address holder = CREDITS.ownerOf(539);
        vm.etch(holder, ""); // in case it carries delegated code
        uint256[] memory none;
        uint256[] memory open = new uint256[](1);
        open[0] = 539;
        vm.startPrank(holder);
        CREDITS.setApprovalForAll(address(FACTORY), true);
        Batch fresh = Batch(
            FACTORY.create("Live", f, none, 0, Batch.Arrangement.Deposit, Batch.Split.Equal, 14 days, open, FACTORY.protocolFeeBps(), FACTORY.creatorFeeBps(), IRatings(address(live)))
        );
        vm.stopPrank();
        assertEq(address(fresh.ratings()), address(live));
        assertEq(fresh.ids().length, 1);
        assertEq(oldTable.scoreOf(539), 7499); // the old table would have refused it
        assertFalse(fresh.passes(53739)); // 745.1 live, under 750
    }
}
