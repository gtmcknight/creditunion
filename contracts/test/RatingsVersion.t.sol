// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {ratingsOf} from "../script/RatingsOf.sol";
import {Batch, IRatings} from "../src/Batch.sol";
import {BatchFactory} from "../src/BatchFactory.sol";
import {MockAssembler} from "../src/mocks/MockAssembler.sol";
import {ICredits} from "../src/interfaces/ICredits.sol";
import {MockCredits} from "../src/mocks/MockCredits.sol";
import {MockStatement} from "../src/mocks/MockStatement.sol";
import {Ratings} from "../src/Ratings.sol";
import {RatingsDeploy} from "../script/DeployRatings.s.sol";

/// @notice Moving the factory to a later rating methodology: only the fee recipient proposes, anyone activates
///         after the delay, and a batch keeps the table it opened with.
contract RatingsVersionTest is Test {
    MockCredits credits;
    BatchFactory factory;
    Ratings v3;
    Ratings v4;
    address alice = makeAddr("alice");
    address fee = address(0xFEE);
    uint256[] none;

    function setUp() public {
        credits = new MockCredits();
        // ids 1..4: v3 scores 100, 500, 800, 550; v4 flips them to 800, 550, 100, 500 (×10, little-endian).
        v3 = RatingsDeploy.deploy(abi.encodePacked(bytes2(0xE803), bytes2(0x8813), bytes2(0x401F), bytes2(0x7C15)), "3.4.0");
        v4 = RatingsDeploy.deploy(abi.encodePacked(bytes2(0x401F), bytes2(0x7C15), bytes2(0xE803), bytes2(0x8813)), "4.0.0");
        MockStatement st = new MockStatement(ICredits(address(credits)));
        factory = new BatchFactory(ICredits(address(credits)), IRatings(address(v3)), new MockAssembler(st), address(0), fee, 100, 0, 1);
        credits.mint(alice, 200);
        vm.prank(alice);
        credits.setApprovalForAll(address(factory), true);
    }

    function _one(uint256 id) internal pure returns (uint256[] memory a) {
        a = new uint256[](1);
        a[0] = id;
    }

    function _open(uint256 seed, IRatings expect) internal returns (Batch b) {
        Batch.Filter memory f;
        f.minScore = 4000;
        vm.prank(alice);
        b = Batch(factory.create("R", f, none, 0, Batch.Arrangement.Deposit, Batch.Split.Equal, 14 days, _one(seed), 100, 0, expect));
    }

    function _switch() internal {
        vm.prank(fee);
        factory.proposeRatings(IRatings(address(v4)));
        vm.warp(block.timestamp + factory.RATINGS_DELAY());
        factory.activateRatings();
    }

    function test_Version() public view {
        assertEq(v3.version(), "3.4.0");
        assertEq(v4.version(), "4.0.0");
        IRatings[] memory h = factory.ratingsHistory();
        assertEq(h.length, 1);
        assertEq(address(h[0]), address(v3));
    }

    function test_OpenBatchKeepsItsTable() public {
        Batch old = _open(2, IRatings(address(v3)));
        assertEq(address(old.ratings()), address(v3));
        assertTrue(old.passes(3)); // 800 under v3
        _switch();
        assertEq(address(ratingsOf(address(factory))), address(v4));
        assertTrue(old.passes(3)); // still v3
        assertFalse(old.passes(1));

        Batch fresh = _open(1, IRatings(address(v4)));
        assertEq(address(fresh.ratings()), address(v4));
        assertFalse(fresh.passes(3)); // 100 under v4
        assertTrue(fresh.passes(1));

        IRatings[] memory h = factory.ratingsHistory();
        assertEq(h.length, 2);
        assertEq(address(h[1]), address(v4));
    }

    function test_CreateRevertsIfTableChanged() public {
        _switch();
        Batch.Filter memory f;
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(BatchFactory.RatingsChanged.selector, address(v4)));
        factory.create("R", f, none, 0, Batch.Arrangement.Deposit, Batch.Split.Equal, 14 days, _one(2), 100, 0, IRatings(address(v3)));
    }

    function test_OnlyFeeRecipientProposes() public {
        vm.prank(alice);
        vm.expectRevert(BatchFactory.NotFeeRecipient.selector);
        factory.proposeRatings(IRatings(address(v4)));
    }

    function test_ProposalWaitsForDelay() public {
        vm.prank(fee);
        factory.proposeRatings(IRatings(address(v4)));
        vm.warp(block.timestamp + factory.RATINGS_DELAY() - 1);
        vm.expectRevert(BatchFactory.TooEarly.selector);
        factory.activateRatings();
        // New batches still open on v3 while a proposal is pending.
        assertEq(address(_open(2, IRatings(address(v3))).ratings()), address(v3));
    }

    function test_NothingPending() public {
        vm.expectRevert(BatchFactory.NothingPending.selector);
        factory.activateRatings();
    }

    function test_RejectsZeroAndWrongCount() public {
        vm.startPrank(fee);
        vm.expectRevert(BatchFactory.BadRatings.selector);
        factory.proposeRatings(IRatings(address(0)));
        Ratings short = RatingsDeploy.deploy(abi.encodePacked(bytes2(0xE803), bytes2(0x8813)), "4.0.0");
        vm.expectRevert(BatchFactory.BadRatings.selector);
        factory.proposeRatings(IRatings(address(short)));
        vm.stopPrank();
    }

    function test_ReproposeRestartsDelay() public {
        vm.prank(fee);
        factory.proposeRatings(IRatings(address(v4)));
        vm.warp(block.timestamp + 20 minutes);
        vm.prank(fee);
        factory.proposeRatings(IRatings(address(v3))); // withdraw by proposing the current table
        vm.warp(block.timestamp + 20 minutes);
        vm.expectRevert(BatchFactory.TooEarly.selector);
        factory.activateRatings();
    }

    /// A factory deployed without a table can gain one later; batches opened before it can't use rating rules.
    function test_FirstTableOnTableless() public {
        MockStatement st = new MockStatement(ICredits(address(credits)));
        BatchFactory bare = new BatchFactory(ICredits(address(credits)), IRatings(address(0)), new MockAssembler(st), address(0), fee, 100, 0, 1);
        assertEq(bare.ratingsHistory().length, 0);
        vm.prank(fee);
        bare.proposeRatings(IRatings(address(v3)));
        vm.warp(block.timestamp + bare.RATINGS_DELAY());
        bare.activateRatings();
        assertEq(address(bare.ratings()), address(v3));
    }

    function test_RatingsOfMatchesGetter() public {
        assertEq(address(ratingsOf(address(factory))), address(factory.ratings()));
        _switch();
        assertEq(address(ratingsOf(address(factory))), address(v4));
    }
}
