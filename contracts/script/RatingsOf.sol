// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Vm} from "forge-std/Vm.sol";
import {IRatings} from "../src/Batch.sol";

/// @dev BatchFactory storage slot of `ratings` (checked in RatingsVersionTest.test_RatingsOfMatchesGetter).
uint256 constant RATINGS_SLOT = 4;

/// @notice The factory's current score table, read with vm.load so it doesn't use up a pending
///         vm.prank / vm.broadcast the way an ordinary `factory.ratings()` call in the argument list would.
function ratingsOf(address factory) view returns (IRatings) {
    Vm vm = Vm(address(uint160(uint256(keccak256("hevm cheat code")))));
    return IRatings(address(uint160(uint256(vm.load(factory, bytes32(RATINGS_SLOT))))));
}
