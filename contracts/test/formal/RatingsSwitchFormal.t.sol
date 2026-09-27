// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {FormalBase, svm} from "./FormalBase.sol";
import {ratingsOf} from "../../script/RatingsOf.sol";
import {Batch, IRatings} from "../../src/Batch.sol";
import {BatchFactory} from "../../src/BatchFactory.sol";
import {IAssembler} from "../../src/interfaces/IAssembler.sol";
import {ICredits} from "../../src/interfaces/ICredits.sol";
import {MockCredits} from "../../src/mocks/MockCredits.sol";
import {MockStatement} from "../../src/mocks/MockStatement.sol";
import {MockAssembler} from "../../src/mocks/MockAssembler.sol";
import {Ratings, DataStore} from "../../src/Ratings.sol";

/// @dev Moving to a later score table: who may propose, the notice, that nothing else moves the factory's table,
///      that create() only opens on the table the caller expected, and that an open batch keeps its own.
contract RatingsSwitchFormal is FormalBase {
    Ratings internal v3;
    Ratings internal v4;
    Batch internal batch;

    function setUp() public {
        vm.warp(1_000_000);
        v3 = _table(hex"2003" hex"3412" hex"401f", "3.4.0");
        v4 = _table(hex"401f" hex"3412" hex"2003", "4.0.0");
        credits = new MockCredits();
        statement = new MockStatement(ICredits(address(credits)));
        asm_ = new MockAssembler(statement);
        factory = new BatchFactory(
            ICredits(address(credits)), IRatings(address(v3)), IAssembler(address(asm_)), SETTER, FEE, PROTOCOL_BPS, CREATOR_BPS, 1
        );
        credits.mint(ALICE, 1);
        batch = _open(ALICE, _ids(1, 1), Batch.Split.Equal);
    }

    function _table(bytes memory data, string memory version) internal returns (Ratings r) {
        address[] memory c = new address[](1);
        c[0] = DataStore.write(data);
        r = new Ratings(c, 3, version);
    }

    function _propose() internal {
        vm.prank(FEE);
        factory.proposeRatings(IRatings(address(v4)));
    }

    /// Only the fee recipient proposes a table.
    function check_proposeRatings_onlyFeeRecipient(address caller) public {
        vm.prank(caller);
        try factory.proposeRatings(IRatings(address(v4))) {
            assert(caller == FEE);
        } catch {}
    }

    /// A proposed table cannot go live before its 30-minute notice, whoever activates it.
    function check_activateRatings_notBeforeDelay(address caller, uint256 wait) public {
        _propose();
        uint256 proposedAt = block.timestamp;
        vm.assume(wait < 365 days);
        vm.warp(proposedAt + wait);
        vm.prank(caller);
        try factory.activateRatings() {
            assert(wait >= 30 minutes);
        } catch {}
    }

    /// With a proposal pending, no call except activateRatings() (and create(), below) moves the factory's table,
    /// whoever makes it.
    function check_ratings_onlyActivateMovesIt_exceptCreate(address caller) public {
        _propose();
        vm.warp(block.timestamp + 30 minutes);
        bytes memory data = svm.createCalldata("BatchFactory");
        vm.assume(bytes4(data) != factory.create.selector && bytes4(data) != factory.activateRatings.selector);
        vm.prank(caller);
        (bool ok,) = address(factory).call(data);
        ok;
        assert(address(factory.ratings()) == address(v3));
    }

    /// create() never moves the factory's table.
    function check_ratings_unchangedByCreate(address caller, uint256 id) public {
        _propose();
        vm.warp(block.timestamp + 30 minutes);
        Batch.Filter memory f;
        uint256[] memory ids = new uint256[](1);
        ids[0] = id;
        vm.prank(caller);
        try factory.create("x", f, new uint256[](0), 0, Batch.Arrangement.Deposit, Batch.Split.Equal, 3 days, ids, PROTOCOL_BPS, CREATOR_BPS, IRatings(address(v3))) {}
            catch {}
        assert(address(factory.ratings()) == address(v3));
    }

    /// A batch only opens on the table its creator expected, and it keeps exactly that table.
    function check_create_onlyOnExpectedTable(address expect) public {
        credits.mint(BOB, 1);
        Batch.Filter memory f;
        vm.startPrank(BOB);
        credits.setApprovalForAll(address(factory), true);
        try factory.create("x", f, new uint256[](0), 0, Batch.Arrangement.Deposit, Batch.Split.Equal, 3 days, _ids(2, 1), PROTOCOL_BPS, CREATOR_BPS, IRatings(expect)) returns (address b) {
            assert(expect == address(v3));
            assert(address(Batch(b).ratings()) == address(v3));
        } catch {}
        vm.stopPrank();
    }

    /// After the factory moves to a new table, no call to an open batch by anyone changes the table it opened with.
    function check_openBatch_keepsItsTable(address caller) public {
        _propose();
        vm.warp(block.timestamp + 30 minutes);
        factory.activateRatings();
        assert(address(factory.ratings()) == address(v4));
        bytes memory data = svm.createCalldata("Batch");
        vm.prank(caller);
        (bool ok,) = address(batch).call(data);
        ok;
        assert(address(batch.ratings()) == address(v3));
    }
}
