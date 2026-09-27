// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {ratingsOf} from "../script/RatingsOf.sol";
import {Batch, IRatings} from "../src/Batch.sol";
import {BatchFactory} from "../src/BatchFactory.sol";
import {MockAssembler} from "../src/mocks/MockAssembler.sol";
import {IAssembler} from "../src/interfaces/IAssembler.sol";
import {ICredits} from "../src/interfaces/ICredits.sol";
import {MockCredits} from "../src/mocks/MockCredits.sol";
import {MockStatement} from "../src/mocks/MockStatement.sol";

/// @notice The lock cycle: never locked before an assembler is active; a full batch counts down LOCK_DELAY from
///         max(filledAt, activation), is then locked and burnable for BURN_WINDOW, then unlocks again.
contract LockTest is Test {
    MockCredits credits;
    MockStatement statement;
    MockAssembler asm_;
    BatchFactory staged; // no assembler at deploy
    BatchFactory live; // assembler active from deploy
    Batch.Filter noFilter;
    address setter = makeAddr("setter");
    address fee = makeAddr("fee");
    address alice = makeAddr("alice");
    address bob = makeAddr("bob");
    address eve = makeAddr("eve");

    uint256 constant LOCK_DELAY = 5 minutes;
    uint256 constant BURN_WINDOW = 1 hours;

    function setUp() public {
        vm.warp(1_000_000);
        credits = new MockCredits();
        statement = new MockStatement(ICredits(address(credits)));
        asm_ = new MockAssembler(statement);
        staged = new BatchFactory(ICredits(address(credits)), IRatings(address(0)), IAssembler(address(0)), setter, fee, 100, 0, 1);
        live = new BatchFactory(ICredits(address(credits)), IRatings(address(0)), asm_, address(0), fee, 100, 0, 1);
        credits.mint(alice, 100); // 1..100
        credits.mint(bob, 100); // 101..200
        address[2] memory us = [alice, bob];
        for (uint256 i; i < 2; ++i) {
            vm.startPrank(us[i]);
            credits.setApprovalForAll(address(staged), true);
            credits.setApprovalForAll(address(live), true);
            vm.stopPrank();
        }
    }

    function _range(uint256 from, uint256 n) internal pure returns (uint256[] memory a) {
        a = new uint256[](n);
        for (uint256 i; i < n; ++i) a[i] = from + i;
    }

    /// alice opens with 1..40, bob fills with 101..140.
    function _full(BatchFactory f) internal returns (Batch b) {
        return _fullFrom(f, 0);
    }

    function _fullFrom(BatchFactory f, uint256 off) internal returns (Batch b) {
        vm.prank(alice);
        b = Batch(f.create("L", noFilter, new uint256[](0), 0, Batch.Arrangement.Deposit, Batch.Split.Equal, 14 days, _range(1 + off, 40), 100, 0, ratingsOf(address(f))));
        vm.prank(bob);
        f.deposit(address(b), _range(101 + off, 40));
        assertEq(uint256(b.state()), uint256(Batch.State.Full));
    }

    function _activate() internal {
        vm.prank(setter);
        staged.proposeAssembler(asm_);
        skip(staged.ASSEMBLER_DELAY());
        staged.activateAssembler();
    }

    function _phase(Batch b) internal view returns (Batch.Phase) {
        return b.phase();
    }

    function _wrong(Batch.Phase p) internal pure returns (bytes memory) {
        return abi.encodeWithSelector(Batch.WrongPhase.selector, p);
    }

    // ------------------------------------------------------------ before the assembler

    function test_WithdrawAt80BeforeAdapter() public {
        Batch b = _full(staged);
        assertEq(uint256(_phase(b)), uint256(Batch.Phase.Waiting));
        assertEq(b.lockAt(), 0);
        assertEq(b.burnDeadline(), 0);
        skip(30 days);
        vm.expectRevert(_wrong(Batch.Phase.Waiting));
        b.assemble();
        vm.prank(bob);
        b.withdraw(_range(101, 1));
        assertEq(credits.ownerOf(101), bob);
        assertEq(uint256(_phase(b)), uint256(Batch.Phase.Open));
    }

    /// A proposal alone locks nothing: through the 30-minute delay a full batch stays withdrawable.
    function test_ProposedButNotActiveStillUnlocked() public {
        Batch b = _full(staged);
        vm.prank(setter);
        staged.proposeAssembler(asm_);
        skip(staged.ASSEMBLER_DELAY() + 1 days); // past the delay, but nobody activated
        assertEq(uint256(_phase(b)), uint256(Batch.Phase.Waiting));
        vm.expectRevert(_wrong(Batch.Phase.Waiting));
        b.assemble();
        vm.prank(alice);
        b.withdraw(_range(1, 1));
        assertEq(b.count(), 79);
    }

    // ------------------------------------------------------------ countdown start

    function test_CountdownFromFillWhenAssemblerAlreadyActive() public {
        Batch b = _full(live);
        assertEq(b.filledAt(), block.timestamp);
        assertEq(b.lockAt(), block.timestamp + LOCK_DELAY);
        assertEq(b.burnDeadline(), block.timestamp + LOCK_DELAY + BURN_WINDOW);
        assertEq(uint256(_phase(b)), uint256(Batch.Phase.Countdown));
        Batch.Summary memory s = b.summary();
        assertEq(uint256(s.phase), uint256(Batch.Phase.Countdown));
        assertEq(s.lockAt, b.lockAt());
        assertEq(s.deadline, b.burnDeadline());
    }

    /// Adapter activated while the batch is already full: the countdown runs from activation.
    function test_CountdownFromActivationWhenAlreadyFull() public {
        Batch b = _full(staged);
        uint256 filled = b.filledAt();
        skip(2 days);
        _activate();
        assertEq(b.filledAt(), filled);
        assertEq(b.lockAt(), block.timestamp + LOCK_DELAY);
        assertEq(uint256(_phase(b)), uint256(Batch.Phase.Countdown));
        vm.prank(bob);
        b.withdraw(_range(101, 1)); // the countdown is the last chance to leave
        assertEq(b.lockAt(), 0);
    }

    // ------------------------------------------------------------ countdown edges

    function test_WithdrawDuringCountdownResets() public {
        Batch b = _full(live);
        uint256 at = b.lockAt();
        vm.warp(at - 1);
        vm.prank(alice);
        b.withdraw(_range(1, 1));
        assertEq(b.filledAt(), 0);
        assertEq(b.lockAt(), 0);
        assertEq(uint256(_phase(b)), uint256(Batch.Phase.Open));
        vm.warp(at + 10 minutes); // past the old lockAt: nothing happens under 80
        vm.expectRevert(_wrong(Batch.Phase.Open));
        b.assemble();
        // Refill restarts the countdown from now.
        vm.prank(alice);
        live.deposit(address(b), _range(1, 1));
        assertEq(b.lockAt(), block.timestamp + LOCK_DELAY);
        assertEq(uint256(_phase(b)), uint256(Batch.Phase.Countdown));
    }

    function test_AssembleRevertsBeforeLockAt() public {
        Batch b = _full(live);
        vm.expectRevert(_wrong(Batch.Phase.Countdown)); // same block as the fill
        b.assemble();
        vm.warp(b.lockAt() - 1);
        vm.expectRevert(_wrong(Batch.Phase.Countdown));
        b.assemble();
        vm.warp(b.lockAt());
        b.assemble();
        assertEq(uint256(b.state()), uint256(Batch.State.Auction));
        assertEq(uint256(_phase(b)), uint256(Batch.Phase.Assembled));
        assertEq(b.lockAt(), 0);
    }

    function test_AssembleAtLastSecondOfWindow() public {
        Batch b = _full(live);
        vm.warp(b.burnDeadline() - 1);
        b.assemble();
        assertEq(uint256(b.state()), uint256(Batch.State.Auction));
    }

    function test_AssembleRevertsAfterExpiry() public {
        Batch b = _full(live);
        vm.warp(b.burnDeadline());
        assertEq(uint256(_phase(b)), uint256(Batch.Phase.Expired));
        vm.expectRevert(_wrong(Batch.Phase.Expired));
        b.assemble();
    }

    function test_WithdrawRevertsWhileLocked() public {
        Batch b = _full(live);
        vm.warp(b.lockAt());
        assertEq(uint256(_phase(b)), uint256(Batch.Phase.Burnable));
        vm.prank(alice);
        vm.expectRevert(_wrong(Batch.Phase.Burnable));
        b.withdraw(_range(1, 1));
        vm.warp(b.burnDeadline() - 1);
        vm.prank(bob);
        vm.expectRevert(_wrong(Batch.Phase.Burnable));
        b.withdraw(_range(101, 40));
    }

    function test_UnlockAfterBurnWindow() public {
        Batch b = _full(live);
        vm.warp(b.burnDeadline());
        vm.prank(bob);
        b.withdraw(_range(101, 40));
        assertEq(credits.balanceOf(bob), 100);
        assertEq(uint256(_phase(b)), uint256(Batch.Phase.Open));
    }

    function test_RefillAfterExpiryRestarts() public {
        Batch b = _full(live);
        vm.warp(b.burnDeadline() + 3 days);
        vm.prank(bob);
        b.withdraw(_range(101, 1));
        vm.prank(bob);
        live.deposit(address(b), _range(101, 1)); // same block: leave and rejoin
        assertEq(b.lockAt(), block.timestamp + LOCK_DELAY);
        vm.prank(alice);
        b.withdraw(_range(1, 1)); // the new countdown still lets everyone leave
        assertEq(b.count(), 79);
    }

    // ------------------------------------------------------------ restartCountdown

    function test_RestartOnlyAfterExpiry() public {
        Batch b = _full(live);
        vm.expectRevert(_wrong(Batch.Phase.Countdown));
        b.restartCountdown();
        vm.warp(b.lockAt());
        vm.expectRevert(_wrong(Batch.Phase.Burnable));
        b.restartCountdown();
        Batch o = _fullFrom(staged, 40);
        vm.expectRevert(_wrong(Batch.Phase.Waiting));
        o.restartCountdown();
    }

    /// An expired batch nobody leaves gets a fresh notice and window from anyone, never an instant burn.
    function test_RestartGivesFreshNoticeThenWindow() public {
        Batch b = _full(live);
        vm.warp(b.burnDeadline() + 1 days);
        vm.prank(eve);
        b.restartCountdown();
        assertEq(b.filledAt(), block.timestamp);
        assertEq(b.lockAt(), block.timestamp + LOCK_DELAY);
        vm.expectRevert(_wrong(Batch.Phase.Countdown));
        b.assemble(); // no burn without the 5 minutes
        vm.prank(alice);
        b.withdraw(_range(1, 1)); // and anyone may leave during them
        vm.prank(alice);
        live.deposit(address(b), _range(1, 1));
        vm.warp(b.lockAt());
        b.assemble();
        assertEq(uint256(b.state()), uint256(Batch.State.Auction));
    }

    // ------------------------------------------------------------ fuzz

    /// Over any timing of fill, proposal, activation and probe: a depositor can withdraw exactly when the probe
    /// falls outside [lockAt, lockAt + BURN_WINDOW), and assemble works exactly inside it.
    function testFuzz_WithdrawableExceptInBurnWindow(uint32 gapA, uint32 gapB, uint32 probe, uint8 mode) public {
        uint256 ga = bound(gapA, 0, 3 days);
        uint256 gb = bound(gapB, 0, 3 days);
        uint256 pr = bound(probe, 0, 4 hours);
        mode = uint8(bound(mode, 0, 2)); // 0: active before fill, 1: activated after fill, 2: never activated
        uint256 activeAt;
        Batch b;
        if (mode == 0) {
            skip(ga);
            _activate();
            activeAt = block.timestamp;
            skip(gb);
            b = _full(staged);
        } else {
            b = _full(staged);
            skip(ga);
            if (mode == 1) {
                _activate();
                activeAt = block.timestamp;
            } else {
                vm.prank(setter);
                staged.proposeAssembler(asm_); // proposed only
            }
            skip(gb);
        }
        uint256 filled = b.filledAt();
        skip(pr);
        uint256 lockAt_ = activeAt == 0 ? 0 : (activeAt > filled ? activeAt : filled) + LOCK_DELAY;
        bool inWindow = lockAt_ != 0 && block.timestamp >= lockAt_ && block.timestamp < lockAt_ + BURN_WINDOW;
        assertEq(b.lockAt(), lockAt_);
        assertEq(b.phase() == Batch.Phase.Burnable, inWindow);

        uint256 snap = vm.snapshotState();
        vm.prank(bob);
        bool withdrew;
        try b.withdraw(_range(101, 40)) {
            withdrew = true;
        } catch {}
        assertEq(withdrew, !inWindow, "withdrawable iff outside the burn window");
        if (withdrew) assertEq(credits.balanceOf(bob), 100);
        vm.revertToState(snap);

        bool burned;
        try b.assemble() {
            burned = true;
        } catch {}
        assertEq(burned, inWindow, "burnable iff inside the burn window");
    }
}
