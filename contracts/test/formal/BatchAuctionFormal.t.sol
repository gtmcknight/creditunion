// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {FormalBase, svm} from "./FormalBase.sol";
import {Batch} from "../../src/Batch.sol";

/// @dev Plain wallets for bidders and payees: accept ETH, nothing else.
contract Wallet {
    receive() external payable {}
}

/// @dev An assembled batch in auction: Alice (the creator) put in 40, Bob 40. `EARLY` switches the split.
abstract contract AuctionBase is FormalBase {
    Batch internal batch;
    address internal b1;
    address internal b2;

    function _auction(Batch.Split split) internal {
        _world(true);
        credits.mint(ALICE, 40);
        credits.mint(BOB, 40);
        batch = _open(ALICE, _ids(1, 40), split);
        vm.startPrank(BOB);
        credits.setApprovalForAll(address(factory), true);
        factory.deposit(address(batch), _ids(41, 40));
        vm.stopPrank();
        vm.warp(batch.lockAt());
        batch.assemble();
        b1 = address(new Wallet());
        b2 = address(new Wallet());
    }

    function _bid(address who, uint256 v) internal returns (bool ok) {
        vm.deal(who, v);
        vm.prank(who);
        try batch.bid{value: v}() {
            ok = true;
        } catch {}
    }

    /// One accepted bid of `v`, then time runs past the end and anyone settles.
    function _sold(uint256 v) internal {
        vm.assume(v >= 0.01 ether && v <= 1e30);
        assert(_bid(b1, v));
        vm.warp(batch.auctionEnd());
        batch.settle();
    }
}

contract BatchAuctionFormal is AuctionBase {
    function setUp() public {
        _auction(Batch.Split.Equal);
    }

    /// Every accepted outbid raises by at least 5% and 0.01 ETH, and the outbid bidder gets exactly their bid back.
    function check_outbidRaisesAndRefunds(uint256 v1, uint256 v2) public {
        vm.assume(v1 <= 1e30 && v2 <= 1e30);
        vm.assume(_bid(b1, v1));
        if (_bid(b2, v2)) {
            assert(v2 >= v1 + 0.01 ether);
            assert(v2 >= v1 + v1 * 5 / 100);
            assert(b1.balance == v1);
            assert(address(batch).balance == v2);
            assert(batch.highBidder() == b2);
        }
    }

    // check_outbidRaisesAndRefunds and check_settleConservesEth time out as single rules (several nonlinear
    // assertions at once). Each is split below into parts the solver can close.

    /// The outbid bidder gets exactly their bid back, and the batch holds only the new high bid.
    function check_outbidRefundsExactly(uint256 v1, uint256 v2) public {
        vm.assume(v1 <= 1e30 && v2 <= 1e30);
        vm.assume(_bid(b1, v1));
        if (_bid(b2, v2)) {
            assert(b1.balance == v1);
            assert(address(batch).balance == v2);
            assert(batch.highBidder() == b2);
        }
    }

    /// Every accepted outbid is at least 5% and 0.01 ETH above the bid it replaces.
    function check_outbidRaisesEnough(uint256 v1, uint256 v2) public {
        vm.assume(v1 <= 1e30 && v2 <= 1e30);
        vm.assume(_bid(b1, v1));
        if (_bid(b2, v2)) {
            assert(v2 >= v1 + 0.01 ether);
            assert(v2 >= v1 + v1 * 5 / 100);
        }
    }

    /// Fees plus both members' claims are exactly the winning bid; the batch ends empty.
    function check_settlePaysOutExactly(uint256 v) public {
        _sold(v);
        batch.claim(ALICE);
        batch.claim(BOB);
        assert(address(batch).balance == 0);
        assert(FEE.balance + ALICE.balance + BOB.balance == v);
    }

    /// Equal split: two members with 40 Credits each are owed the same.
    function check_equalSplitIsEqual(uint256 v) public {
        _sold(v);
        assert(batch.claimable(ALICE) == batch.claimable(BOB));
        assert(statement.ownerOf(batch.statementId()) == b1);
    }

    /// A bid can never shorten the auction, and a late bid always leaves at least 15 minutes.
    function check_bidNeverShortensAuction(uint256 v1, uint256 v2, uint256 dt) public {
        vm.assume(v1 <= 1e30 && v2 <= 1e30 && dt < 30 days);
        vm.assume(_bid(b1, v1));
        uint256 end = batch.auctionEnd();
        vm.warp(block.timestamp + dt);
        if (_bid(b2, v2)) {
            assert(batch.auctionEnd() >= end);
            assert(batch.auctionEnd() >= block.timestamp + 15 minutes);
        }
    }

    /// No settlement before the clock runs out.
    function check_noSettleBeforeEnd(uint256 v, uint256 dt, address caller) public {
        vm.assume(v <= 1e30 && dt < 30 days);
        vm.assume(_bid(b1, v));
        vm.warp(block.timestamp + dt);
        vm.prank(caller);
        try batch.settle() {
            assert(block.timestamp >= batch.auctionEnd());
        } catch {}
    }

    /// Settlement conserves the sale: fees plus every member's claim is exactly the winning bid, nothing is
    /// left stuck and nothing is paid twice. The Statement goes to the winner.
    function check_settleConservesEth(uint256 v) public {
        _sold(v);
        assert(statement.ownerOf(batch.statementId()) == b1);
        uint256 afterFees = address(batch).balance;
        assert(FEE.balance + ALICE.balance + afterFees == v);
        assert(ALICE.balance == v * CREATOR_BPS / 10_000);
        assert(FEE.balance >= v * PROTOCOL_BPS / 10_000);

        batch.claim(ALICE);
        batch.claim(BOB);
        assert(address(batch).balance == 0);
        assert(FEE.balance + ALICE.balance + BOB.balance == v);
        // equal split: 40 shares each
        assert(ALICE.balance - v * CREATOR_BPS / 10_000 == BOB.balance);
    }

    /// A member is paid once.
    function check_claimOnce(uint256 v, address caller) public {
        _sold(v);
        batch.claim(BOB);
        vm.prank(caller);
        try batch.claim(BOB) {
            assert(false);
        } catch {}
    }

    /// Settle runs once: no second payout of fees.
    function check_settleOnce(uint256 v, address caller) public {
        _sold(v);
        vm.prank(caller);
        try batch.settle() {
            assert(false);
        } catch {}
    }

    /// Only the winner can pull an undelivered Statement.
    function check_claimStatement_onlyWinner(uint256 v, address caller) public {
        _sold(v);
        vm.prank(caller);
        try batch.claimStatement(caller) {
            assert(caller == b1);
        } catch {}
    }

    /// Nobody, by any call, can take the Statement out of the batch while the auction runs.
    function check_statementStaysDuringAuction(address caller) public {
        _outsider(caller);
        bytes memory data = svm.createCalldata("Batch");
        vm.prank(caller);
        (bool ok,) = address(batch).call(data);
        ok;
        if (!batch.settled()) assert(statement.ownerOf(batch.statementId()) == address(batch));
    }
}

contract BatchEarlyFormal is AuctionBase {
    function setUp() public {
        _auction(Batch.Split.Early);
    }

    /// Early split: the 80 positions' weights add to exactly the sale net of fees, first money earns more,
    /// and the batch pays out everything it holds.
    function check_earlySplitConserves(uint256 v) public {
        _sold(v);
        assert(batch.unitsOf(ALICE) + batch.unitsOf(BOB) == 12_640);
        uint256 creatorFee = v * CREATOR_BPS / 10_000;
        batch.claim(ALICE);
        batch.claim(BOB);
        assert(address(batch).balance == 0);
        assert(FEE.balance + ALICE.balance + BOB.balance == v);
        assert(ALICE.balance - creatorFee >= BOB.balance);
    }
}
