// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {FormalBase, svm} from "./FormalBase.sol";
import {Batch} from "../../src/Batch.sol";

/// @dev A full batch: Alice put in all 80 at t0 with the assembler already live, so the countdown is running.
contract BatchLockFormal is FormalBase {
    Batch internal batch;
    uint256 internal t0;

    function setUp() public {
        _world(true);
        credits.mint(ALICE, 80);
        credits.mint(BOB, 1);
        t0 = block.timestamp;
        batch = _open(ALICE, _ids(1, 80), Batch.Split.Equal);
    }

    /// In the burn window no depositor can pull a Credit out from under the burn.
    function check_noWithdrawWhileBurnable(uint256 dt) public {
        vm.assume(dt < 30 days);
        vm.warp(t0 + dt);
        bool burnable = batch.phase() == Batch.Phase.Burnable;
        vm.prank(ALICE);
        try batch.withdraw(_ids(1, 1)) {
            assert(!burnable);
        } catch {}
    }

    /// Outside the burn window the depositor can always leave (no lock without notice, no lock forever).
    function check_canLeaveOutsideBurnWindow(uint256 dt) public {
        vm.assume(dt < 30 days);
        vm.warp(t0 + dt);
        vm.assume(batch.phase() != Batch.Phase.Burnable);
        vm.prank(ALICE);
        batch.withdraw(_ids(1, 1)); // a revert here is a counterexample
        assert(credits.ownerOf(1) == ALICE);
    }

    /// A burn only happens inside [fill + 5 min, fill + 5 min + 1 h), whoever calls it.
    function check_burnOnlyInWindow(address caller, uint256 dt) public {
        vm.assume(dt < 30 days);
        vm.warp(t0 + dt);
        vm.prank(caller);
        try batch.assemble() {
            assert(dt >= 5 minutes && dt < 5 minutes + 1 hours);
        } catch {}
    }

    /// Restarting a lapsed window never locks at once: it always gives a fresh 5-minute notice.
    function check_restartAlwaysGivesNotice(address caller, uint256 dt) public {
        vm.assume(dt < 30 days);
        vm.warp(t0 + dt);
        vm.prank(caller);
        try batch.restartCountdown() {
            assert(batch.lockAt() == block.timestamp + 5 minutes);
            assert(batch.phase() == Batch.Phase.Countdown);
        } catch {}
    }

    /// A full batch takes no 81st Credit, by either deposit path.
    function check_neverMoreThan80(bool viaFactory) public {
        vm.startPrank(BOB);
        credits.setApprovalForAll(address(factory), true);
        if (viaFactory) {
            try factory.deposit(address(batch), _ids(81, 1)) {} catch {}
        } else {
            try credits.safeTransferFrom(BOB, address(batch), 81) {} catch {}
        }
        vm.stopPrank();
        assert(batch.count() == 80);
        assert(credits.ownerOf(81) == BOB);
    }
}
