// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {Batch, IRatings} from "../src/Batch.sol";
import {BatchFactory} from "../src/BatchFactory.sol";
import {MockAssembler} from "../src/mocks/MockAssembler.sol";
import {ICredits} from "../src/interfaces/ICredits.sol";
import {MockCredits} from "../src/mocks/MockCredits.sol";
import {MockStatement} from "../src/mocks/MockStatement.sol";
import {ready} from "./utils/Ready.sol";

/// @notice Early-bird split: position i (deposit order, 0-based) earns 237 - 2i units of 12,640.
contract SplitTest is Test {
    MockCredits credits;
    MockStatement statement;
    BatchFactory factory;
    Batch.Filter noFilter;
    address alice = makeAddr("alice");
    address bob = makeAddr("bob");
    address carol = makeAddr("carol");
    address fee = makeAddr("fee");

    function setUp() public {
        credits = new MockCredits();
        statement = new MockStatement(ICredits(address(credits)));
        factory = new BatchFactory(ICredits(address(credits)), IRatings(address(0)), new MockAssembler(statement), address(0), fee, 200, 0, 1);
        credits.mint(alice, 40); // 1..40
        credits.mint(alice, 40); // 41..80
        credits.mint(bob, 40); // 81..120
        credits.mint(bob, 40); // 121..160
        credits.mint(carol, 40); // 161..200
        credits.mint(carol, 40); // 201..240
        for (uint256 i; i < 3; ++i) {
            address u = [alice, bob, carol][i];
            vm.prank(u);
            credits.setApprovalForAll(address(factory), true);
            vm.deal(u, 100 ether);
        }
    }

    function _range(uint256 from, uint256 n) internal pure returns (uint256[] memory a) {
        a = new uint256[](n);
        for (uint256 i; i < n; ++i) a[i] = from + i;
    }

    function _open(address who, uint256[] memory ids, Batch.Split split) internal returns (Batch b) {
        vm.prank(who);
        b = Batch(factory.create("S", noFilter, new uint256[](0), 0, Batch.Arrangement.Deposit, split, 14 days, ids, 200, 0));
    }

    function _sell(Batch b, uint256 amount) internal {
        ready(b);
        b.assemble();
        vm.deal(address(0xB1D), amount);
        vm.prank(address(0xB1D));
        b.bid{value: amount}();
        skip(1 days);
        b.settle();
    }

    /// Alice seeds 10 (positions 1-10), bob adds 30, carol fills the last 40. 4 ETH sale, 2% fee.
    function test_EarlyWeights() public {
        Batch b = _open(alice, _range(1, 10), Batch.Split.Early);
        vm.prank(bob);
        factory.deposit(address(b), _range(81, 30));
        vm.prank(carol);
        factory.deposit(address(b), _range(161, 40));
        assertEq(uint256(b.split()), uint256(Batch.Split.Early));
        // units: alice positions 0..9 → Σ(237-2i) = 2370 - 90 = 2280; bob 10..39 → 30*237 - 2*Σ(10..39)=7110-1470=5640; carol 40..79 → 9480-2*2380=4720
        assertEq(b.unitsOf(alice), 2280);
        assertEq(b.unitsOf(bob), 5640);
        assertEq(b.unitsOf(carol), 4720);
        assertEq(uint256(2280 + 5640 + 4720), 12_640);

        _sell(b, 4 ether);
        uint256 net = 4 ether - 0.08 ether;
        uint256 per = net / 12_640;
        assertEq(b.payoutPerUnit(), per);
        assertEq(b.payoutPerShare(), per * 158); // one "average" share
        assertEq(b.claimable(alice), 2280 * per);
        // first position earns 1.5 shares, last earns 0.5
        assertEq(237 * per, b.payoutPerShare() * 3 / 2);
        assertEq(79 * per, b.payoutPerShare() / 2);

        uint256 a0 = alice.balance;
        uint256 b0 = bob.balance;
        uint256 c0 = carol.balance;
        b.claim(alice);
        b.claim(bob);
        b.claim(carol);
        assertEq(alice.balance - a0 + bob.balance - b0 + carol.balance - c0 + fee.balance, 4 ether, "every wei paid out");
        assertEq(address(b).balance, 0);
        assertGt(alice.balance - a0, 10 * b.payoutPerShare()); // early money beat the average
        assertLt(carol.balance - c0, 40 * b.payoutPerShare()); // late money trailed it
    }

    /// Withdrawing forfeits the position: everyone behind moves up, and re-depositing joins at the back.
    function test_WithdrawShiftsPositions() public {
        Batch b = _open(alice, _range(1, 5), Batch.Split.Early);
        vm.prank(bob);
        factory.deposit(address(b), _range(81, 5));
        assertEq(b.unitsOf(alice), 237 + 235 + 233 + 231 + 229);
        vm.prank(alice);
        b.withdraw(_range(1, 5));
        assertEq(b.unitsOf(alice), 0);
        assertEq(b.unitsOf(bob), 237 + 235 + 233 + 231 + 229); // bob is first now
        vm.prank(alice);
        factory.deposit(address(b), _range(1, 5));
        assertEq(b.unitsOf(alice), 227 + 225 + 223 + 221 + 219); // back of the line
    }

    /// depositFor (the Sweeper's path) takes the next positions for the buyer.
    function test_DepositForTakesNextPositions() public {
        Batch b = _open(alice, _range(1, 1), Batch.Split.Early);
        vm.prank(bob);
        factory.depositFor(address(b), _range(81, 3), carol);
        assertEq(b.unitsOf(alice), 237);
        assertEq(b.unitsOf(carol), 235 + 233 + 231);
    }

    /// Equal batches are untouched: every share pays net / 80 exactly, as before.
    function test_EqualUnchanged() public {
        Batch b = _open(alice, _range(1, 40), Batch.Split.Equal);
        vm.prank(bob);
        factory.deposit(address(b), _range(81, 40));
        _sell(b, 3 ether);
        assertEq(b.payoutPerShare(), (3 ether - 0.06 ether) / 80);
        assertEq(b.unitsOf(alice), 40);
        assertEq(b.claimable(alice), 40 * b.payoutPerShare());
        assertEq(b.summary().payoutPerShare, b.payoutPerShare());
        assertEq(uint256(b.summary().split), uint256(Batch.Split.Equal));
    }

    /// Any bid, any three-way division of positions: the payouts plus the fee equal the bid exactly.
    function testFuzz_EarlySplitIsExact(uint96 amount, uint8 aShare, uint8 bShare) public {
        amount = uint96(bound(amount, 0.01 ether, 1_000_000 ether));
        uint256 a = bound(aShare, 1, 40);
        uint256 bb = bound(bShare, 1, 40);
        uint256 c = 80 - a - bb;
        Batch b = _open(alice, _range(1, a), Batch.Split.Early);
        vm.prank(bob);
        factory.deposit(address(b), _range(81, bb));
        if (c > 0) {
            vm.prank(carol);
            factory.deposit(address(b), _range(161, c));
        }
        assertEq(b.unitsOf(alice) + b.unitsOf(bob) + b.unitsOf(carol), 12_640);
        _sell(b, amount);
        if (b.claimable(alice) > 0) b.claim(alice);
        if (b.claimable(bob) > 0) b.claim(bob);
        if (b.claimable(carol) > 0) b.claim(carol);
        assertEq(address(b).balance, 0);
        assertEq((alice.balance - 100 ether) + (bob.balance - 100 ether) + (carol.balance - 100 ether) + fee.balance, amount);
        assertLe(fee.balance, uint256(amount) * 2 / 100 + 12_640); // fee + at most one unit of dust per unit
    }

    /// Claiming on an Early batch walks the positions: the back-of-line depositor is the worst case (~460k).
    function test_ClaimGas() public {
        Batch b = _open(alice, _range(1, 40), Batch.Split.Early);
        vm.prank(bob);
        factory.deposit(address(b), _range(81, 40));
        _sell(b, 1 ether);
        uint256 g = gasleft();
        b.claim(bob); // positions 40..79: the early exit never fires before the end
        assertLt(g - gasleft(), 500_000);
    }
}
