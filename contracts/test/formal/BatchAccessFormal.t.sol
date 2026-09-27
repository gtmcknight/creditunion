// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {FormalBase, svm} from "./FormalBase.sol";
import {Batch} from "../../src/Batch.sol";

/// @dev An open batch: Alice deposited Credit #1 (she created it), Bob holds #2.
contract BatchAccessFormal is FormalBase {
    Batch internal batch;

    function setUp() public {
        _world(true);
        credits.mint(ALICE, 1);
        credits.mint(BOB, 1);
        batch = _open(ALICE, _ids(1, 1), Batch.Split.Equal);
    }

    /// Only the factory records deposits made through it.
    function check_depositFrom_onlyFactory(address caller, address from, uint256 id) public {
        uint256[] memory ids = new uint256[](1);
        ids[0] = id;
        vm.prank(caller);
        try batch.depositFrom(from, ids) {
            assert(caller == address(factory));
        } catch {}
    }

    /// Only a Credit's depositor can withdraw it.
    function check_withdraw_onlyDepositor(address caller) public {
        vm.assume(caller != ALICE);
        vm.prank(caller);
        try batch.withdraw(_ids(1, 1)) {
            assert(false);
        } catch {}
    }

    /// No call to the batch by anyone but Alice moves her Credit, her depositor record, or her share.
    function check_outsiderCannotTouchDeposit(address caller) public {
        _outsider(caller);
        vm.assume(caller != ALICE);
        bytes memory data = svm.createCalldata("Batch");
        vm.prank(caller);
        (bool ok,) = address(batch).call(data);
        ok;
        assert(credits.ownerOf(1) == address(batch));
        assert(batch.depositorOf(1) == ALICE);
        assert(batch.sharesOf(ALICE) == 1);
        assert(batch.count() == 1);
    }

    /// The deposit hook only answers the Credits contract: no one can fake a deposit by calling it directly.
    function check_hook_onlyCredits(address caller, address op, address from, uint256 id, bytes calldata data) public {
        vm.assume(caller != address(credits));
        vm.prank(caller);
        try batch.onERC721Received(op, from, id, data) {
            assert(false);
        } catch {}
    }

    /// rescue can never take a pooled Credit.
    function check_rescue_neverTakesPooled(address caller) public {
        vm.prank(caller);
        try batch.rescue(address(credits), 1) {
            assert(false);
        } catch {}
    }

    /// Shares always equal Credits held, and every recorded Credit is actually in the batch, after Alice
    /// or Bob does anything at all to the batch or sends a Credit into it.
    function check_booksMatchHoldings(bool aliceActs, bool viaTransfer) public {
        address who = aliceActs ? ALICE : BOB;
        if (viaTransfer) {
            // Bob's #2 through the hook; Alice owns nothing loose, so hers reverts.
            vm.prank(who);
            try credits.safeTransferFrom(who, address(batch), 2) {} catch {}
        } else {
            bytes memory data = svm.createCalldata("Batch");
            vm.prank(who);
            (bool ok,) = address(batch).call(data);
            ok;
        }
        uint256 n = batch.count();
        assert(n <= 80);
        assert(batch.sharesOf(ALICE) + batch.sharesOf(BOB) == n);
        uint256[] memory ids = batch.ids();
        for (uint256 i; i < ids.length; ++i) {
            assert(credits.ownerOf(ids[i]) == address(batch));
            assert(batch.depositorOf(ids[i]) != address(0));
        }
    }
}
