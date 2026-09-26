// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Vm} from "forge-std/Vm.sol";
import {Batch} from "../../src/Batch.sol";

Vm constant VM = Vm(address(uint160(uint256(keccak256("hevm cheat code")))));

/// @dev Moves a full batch into its burn window so tests written for "assemble once full" still read that way:
///      a countdown is skipped to lockAt, a lapsed window is restarted first. Anything else is left alone.
function ready(Batch b) {
    Batch.Phase p = b.phase();
    if (p == Batch.Phase.Expired) {
        b.restartCountdown();
        p = Batch.Phase.Countdown;
    }
    if (p == Batch.Phase.Countdown) VM.warp(b.lockAt());
}
