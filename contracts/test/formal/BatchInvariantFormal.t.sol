// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {FormalBase} from "./FormalBase.sol";
import {Batch} from "../../src/Batch.sol";

/// @dev Sequences of calls (Halmos invariant mode): Alice and Bob each hold 2 Credits and have 1 in an open
///      batch. Any sender calls any Batch function, or sends a Credit into the batch through the hook, in any
///      order up to --invariant-depth. After every step the books must match what the batch holds.
contract BatchInvariantFormal is FormalBase {
    Batch internal batch;

    function setUp() public {
        _world(true);
        credits.mint(ALICE, 2); // #1 in the batch, #2 loose
        credits.mint(BOB, 2); // #3 in the batch, #4 loose
        batch = _open(ALICE, _ids(1, 1), Batch.Split.Equal);
        vm.startPrank(BOB);
        credits.setApprovalForAll(address(factory), true);
        factory.deposit(address(batch), _ids(3, 1));
        vm.stopPrank();

        targetContract(address(batch));
        targetContract(address(credits));
        bytes4[] memory sel = new bytes4[](1);
        sel[0] = bytes4(keccak256("safeTransferFrom(address,address,uint256)"));
        targetSelector(FuzzSelector(address(credits), sel));
        targetSender(ALICE);
        targetSender(BOB);
    }

    /// Shares always add up to the Credits held, and never exceed 80.
    function invariant_sharesMatchCount() public view {
        uint256 n = batch.count();
        assert(n <= 80);
        assert(batch.sharesOf(ALICE) + batch.sharesOf(BOB) == n);
    }

    /// Every Credit on the books is in the batch; every Credit in the batch is on the books.
    function invariant_booksMatchHoldings() public view {
        for (uint256 id = 1; id <= 4; ++id) {
            bool held = credits.ownerOf(id) == address(batch);
            bool booked = batch.depositorOf(id) != address(0);
            assert(held == booked);
        }
    }

    /// Only the two people who put Credits in are ever on the books (no depositor appears from nowhere).
    /// Alice and Bob may pass loose Credits to each other; that's theirs to do, so it isn't ruled out.
    function invariant_onlyRealDepositors() public view {
        for (uint256 id = 1; id <= 4; ++id) {
            address d = batch.depositorOf(id);
            assert(d == address(0) || d == ALICE || d == BOB);
        }
    }
}
