// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {Batch, IRatings} from "../src/Batch.sol";
import {BatchFactory} from "../src/BatchFactory.sol";
import {MockAssembler} from "../src/MockAssembler.sol";
import {ICredits} from "../src/interfaces/ICredits.sol";
import {MockCredits} from "../src/mocks/MockCredits.sol";
import {MockStatement} from "../src/mocks/MockStatement.sol";

/// @dev Random walk over one batch's whole life: deposits, withdrawals, time, assembly, bids, settle, claims.
///      Actors include an EOA-like receiver, one that reverts on receive, and one that burns gas.
contract Handler is Test {
    MockCredits public credits;
    BatchFactory public factory;
    Batch public batch;
    address[] public actors;
    uint256 public ethIn; // every wei that ever entered the batch through bid()
    uint256 public ethOut; // every wei the batch ever paid out
    uint256 public ghostFees;
    uint256 public ghostCreator;

    constructor(MockCredits c, BatchFactory f, Batch b, address[] memory a) {
        credits = c;
        factory = f;
        batch = b;
        actors = a;
    }

    function _actor(uint256 seed) internal view returns (address) {
        return actors[seed % actors.length];
    }

    function deposit(uint256 seed, uint8 n) external {
        address a = _actor(seed);
        uint256[] memory owned = credits.tokensOf(a);
        if (owned.length == 0) return;
        n = uint8(bound(n, 1, owned.length > 12 ? 12 : owned.length));
        uint256[] memory ids = new uint256[](n);
        for (uint256 i; i < n; ++i) ids[i] = owned[i];
        vm.startPrank(a);
        credits.setApprovalForAll(address(factory), true);
        try factory.deposit(address(batch), ids) {} catch {}
        vm.stopPrank();
    }

    function depositDirect(uint256 seed) external {
        address a = _actor(seed);
        uint256[] memory owned = credits.tokensOf(a);
        if (owned.length == 0) return;
        vm.prank(a);
        try credits.safeTransferFrom(a, address(batch), owned[0]) {} catch {}
    }

    function withdraw(uint256 seed, uint8 n) external {
        address a = _actor(seed);
        uint256[] memory all = batch.ids();
        uint256[] memory mine = new uint256[](all.length);
        uint256 k;
        for (uint256 i; i < all.length; ++i) {
            if (batch.depositorOf(all[i]) == a) mine[k++] = all[i];
        }
        if (k == 0) return;
        n = uint8(bound(n, 1, k));
        assembly {
            mstore(mine, n)
        }
        vm.prank(a);
        try batch.withdraw(mine) {} catch {}
    }

    function warp(uint32 secs) external {
        skip(bound(secs, 1, 3 days));
    }

    function assemble() external {
        try batch.assemble() {} catch {}
    }

    function bid(uint256 seed, uint96 amount) external {
        address a = _actor(seed);
        amount = uint96(bound(amount, 1, 50 ether));
        vm.deal(a, a.balance + amount);
        uint256 before = address(batch).balance;
        vm.prank(a);
        try batch.bid{value: amount}() {
            ethIn += amount;
            // whatever left the batch in this call was a refund
            ethOut += before + amount - address(batch).balance;
        } catch {}
    }

    function settle() external {
        uint256 before = address(batch).balance;
        try batch.settle() {
            ethOut += before - address(batch).balance;
        } catch {}
    }

    function claim(uint256 seed) external {
        address a = _actor(seed);
        uint256 before = address(batch).balance;
        try batch.claim(a) {
            ethOut += before - address(batch).balance;
        } catch {}
    }

    function withdrawOwed(uint256 seed) external {
        address a = _actor(seed);
        uint256 before = address(batch).balance;
        vm.prank(a);
        try batch.withdrawOwed() {
            ethOut += before - address(batch).balance;
        } catch {}
    }
}

contract Reverter {
    receive() external payable {
        revert("no");
    }
}

contract GasBurner {
    uint256 public x;

    receive() external payable {
        for (uint256 i; i < 10_000; ++i) x = i;
    }
}

contract BatchInvariants is Test {
    MockCredits credits;
    MockStatement statement;
    BatchFactory factory;
    Batch batch;
    Handler handler;
    address[] actors;
    address fee = makeAddr("fee");
    address creator = makeAddr("creator");

    function setUp() public {
        credits = new MockCredits();
        statement = new MockStatement(ICredits(address(credits)));
        factory = new BatchFactory(ICredits(address(credits)), IRatings(address(0)), new MockAssembler(statement), address(0), fee, 100, 0, 10);

        actors.push(creator);
        actors.push(makeAddr("alice"));
        actors.push(makeAddr("bob"));
        actors.push(address(new Reverter()));
        actors.push(address(new GasBurner()));
        for (uint256 i; i < actors.length; ++i) credits.mint(actors[i], 40);

        uint256[] memory ids = new uint256[](10);
        for (uint256 i; i < 10; ++i) ids[i] = i + 1;
        vm.startPrank(creator);
        credits.setApprovalForAll(address(factory), true);
        batch = Batch(factory.create("Inv", Batch.Filter(0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0), new uint256[](0), 0.5 ether, Batch.Arrangement.Deposit, Batch.Split.Equal, 30 days, ids, 100, 0));
        vm.stopPrank();

        handler = new Handler(credits, factory, batch, actors);
        targetContract(address(handler));
    }

    /// Every wei in the batch is spoken for: the live high bid, unpaid owed balances, and unclaimed shares.
    function invariant_EthAccountedFor() public view {
        uint256 liabilities;
        if (batch.settled()) {
            for (uint256 i; i < actors.length; ++i) liabilities += batch.claimable(actors[i]);
        } else {
            liabilities += batch.highBid();
        }
        for (uint256 i; i < actors.length; ++i) liabilities += batch.owed(actors[i]);
        liabilities += batch.owed(fee) + batch.owed(creator);
        assertEq(address(batch).balance, liabilities, "balance != liabilities");
        assertEq(handler.ethIn(), handler.ethOut() + address(batch).balance, "in != out + balance");
    }

    /// Shares always equal the Credits actually held and recorded, per depositor and in total.
    function invariant_SharesMatchHoldings() public view {
        uint256[] memory ids = batch.ids();
        if (!batch.settled() && batch.statement() == address(0)) {
            assertEq(credits.balanceOf(address(batch)), ids.length, "held != recorded");
        }
        uint256 total;
        for (uint256 i; i < actors.length; ++i) {
            uint256 mine;
            for (uint256 j; j < ids.length; ++j) {
                if (batch.depositorOf(ids[j]) == actors[i]) ++mine;
            }
            assertEq(batch.sharesOf(actors[i]), mine, "sharesOf != recorded ids");
            total += mine;
        }
        assertEq(total, ids.length, "sum(shares) != ids");
        assertLe(ids.length, 80, "over 80");
    }

    /// Once locked at 80, the set of Credits never changes; once assembled, the batch holds none.
    function invariant_LockIsFinal() public view {
        Batch.State s = batch.state();
        if (s == Batch.State.Full || s == Batch.State.Auction || s == Batch.State.Settled) {
            assertEq(batch.ids().length, 80, "locked batch lost ids");
        }
        if (batch.statement() != address(0)) {
            assertEq(credits.balanceOf(address(batch)), 0, "credits survive assembly");
            assertEq(statement.ownerOf(batch.statementId()), batch.settled() ? batch.highBidder() : address(batch));
        }
    }

    /// The winning bid is never below the reserve while the reserve window is live.
    function invariant_ReserveRespected() public view {
        if (batch.highBid() > 0 && block.timestamp < batch.assembledAt() + batch.RESERVE_WINDOW()) {
            assertGe(batch.highBid(), batch.reserve());
        }
    }
}
