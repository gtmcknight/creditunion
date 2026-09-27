// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {FormalBase, svm} from "./FormalBase.sol";
import {Batch} from "../../src/Batch.sol";
import {IAssembler} from "../../src/interfaces/IAssembler.sol";

/// @dev BatchFactory: who may touch fees and the assembler, and that it only ever moves the caller's Credits.
contract FactoryFormal is FormalBase {
    Batch internal batch;

    function setUp() public {
        _world(false); // no assembler yet: the setter's window is open
        credits.mint(ALICE, 2); // 1 opens the batch, 2 stays in Alice's wallet with the factory approved
        batch = _open(ALICE, _ids(1, 1), Batch.Split.Equal);
    }

    /// Only the fee recipient changes fees.
    function check_setFees_onlyFeeRecipient(address caller, uint256 p, uint256 c) public {
        vm.prank(caller);
        try factory.setFees(p, c) {
            assert(caller == FEE);
        } catch {}
    }

    /// Fees never exceed their caps, whoever calls and with whatever values.
    function check_fees_neverAboveCaps(address caller, uint256 p, uint256 c) public {
        vm.prank(caller);
        try factory.setFees(p, c) {} catch {}
        assert(factory.protocolFeeBps() <= 500);
        assert(factory.creatorFeeBps() <= 1000);
    }

    /// Only the setter proposes an assembler.
    function check_propose_onlySetter(address caller, address a) public {
        vm.prank(caller);
        try factory.proposeAssembler(IAssembler(a)) {
            assert(caller == SETTER);
        } catch {}
    }

    /// A proposed assembler cannot go live before its 30-minute notice.
    function check_activate_notBeforeDelay(address caller, uint256 wait) public {
        vm.prank(SETTER);
        factory.proposeAssembler(IAssembler(address(asm_)));
        uint256 proposedAt = block.timestamp;
        vm.assume(wait < 365 days);
        vm.warp(proposedAt + wait);
        vm.prank(caller);
        try factory.activateAssembler() {
            assert(wait >= 30 minutes);
        } catch {}
    }

    /// Once active, the assembler never changes: no call by anyone, including the setter, moves it.
    function check_assembler_fixedOnceActive(address caller) public {
        vm.prank(SETTER);
        factory.proposeAssembler(IAssembler(address(asm_)));
        vm.warp(block.timestamp + 30 minutes);
        factory.activateAssembler();
        address a = address(factory.assembler());
        uint64 at = factory.assemblerActiveAt();

        bytes memory data = svm.createCalldata("BatchFactory");
        vm.prank(caller);
        (bool ok,) = address(factory).call(data);
        ok;
        assert(address(factory.assembler()) == a);
        assert(factory.assemblerActiveAt() == at);
    }

    /// The factory never moves a Credit its owner didn't send: any call by anyone else leaves Alice's
    /// Credit #2 in her wallet, even though she approved the factory for all her Credits.
    function check_factory_neverTakesOthersCredits(address caller) public {
        _outsider(caller);
        vm.assume(caller != ALICE);
        bytes memory data = svm.createCalldata("BatchFactory");
        vm.prank(caller);
        (bool ok,) = address(factory).call(data);
        ok;
        assert(credits.ownerOf(2) == ALICE);
    }

    /// depositFor never records a depositor that could not withdraw or be paid.
    function check_depositFor_rejectsSinks(uint256 pick) public {
        address to = pick % 3 == 0 ? address(0) : pick % 3 == 1 ? address(batch) : address(factory);
        vm.prank(ALICE);
        try factory.depositFor(address(batch), _ids(2, 1), to) {
            assert(false);
        } catch {}
    }

    /// A created batch can never be re-initialized, and neither can the implementation behind every clone.
    function check_initialize_once(address caller, bool impl) public {
        Batch target = impl ? Batch(factory.implementation()) : batch;
        Batch.Filter memory f;
        vm.prank(caller);
        try target.initialize(caller, "x", f, new uint256[](0), 0, 500, 1000, Batch.Arrangement.Deposit, Batch.Split.Equal, 0) {
            assert(false);
        } catch {}
    }

    // The two "any call" rules above time out: create() alone (strings, arrays, a full batch initialize) is
    // too large to explore. Each is split into every other function, plus create() with the parts that
    // matter (caller, the ids moved) symbolic.

    function _activate() internal {
        vm.prank(SETTER);
        factory.proposeAssembler(IAssembler(address(asm_)));
        vm.warp(block.timestamp + 30 minutes);
        factory.activateAssembler();
    }

    /// Assembler fixed once active: any call except create().
    function check_assembler_fixedOnceActive_exceptCreate(address caller) public {
        _activate();
        address a = address(factory.assembler());
        uint64 at = factory.assemblerActiveAt();
        bytes memory data = svm.createCalldata("BatchFactory");
        vm.assume(bytes4(data) != factory.create.selector);
        vm.prank(caller);
        (bool ok,) = address(factory).call(data);
        ok;
        assert(address(factory.assembler()) == a);
        assert(factory.assemblerActiveAt() == at);
    }

    /// Assembler fixed once active: create(), by anyone, with any id.
    function check_assembler_fixedOnceActive_create(address caller, uint256 id) public {
        _activate();
        address a = address(factory.assembler());
        uint64 at = factory.assemblerActiveAt();
        Batch.Filter memory f;
        uint256[] memory ids = new uint256[](1);
        ids[0] = id;
        vm.prank(caller);
        try factory.create("x", f, new uint256[](0), 0, Batch.Arrangement.Deposit, Batch.Split.Equal, 3 days, ids, 250, 500) {}
            catch {}
        assert(address(factory.assembler()) == a);
        assert(factory.assemblerActiveAt() == at);
    }

    /// The factory never takes someone else's Credit: any call except create().
    function check_factory_neverTakesOthersCredits_exceptCreate(address caller) public {
        _outsider(caller);
        vm.assume(caller != ALICE);
        bytes memory data = svm.createCalldata("BatchFactory");
        vm.assume(bytes4(data) != factory.create.selector);
        vm.prank(caller);
        (bool ok,) = address(factory).call(data);
        ok;
        assert(credits.ownerOf(2) == ALICE);
    }

    /// The factory never takes someone else's Credit: create() by anyone else, naming any id.
    function check_factory_neverTakesOthersCredits_create(address caller, uint256 id) public {
        _outsider(caller);
        vm.assume(caller != ALICE);
        Batch.Filter memory f;
        uint256[] memory ids = new uint256[](1);
        ids[0] = id;
        vm.prank(caller);
        try factory.create("x", f, new uint256[](0), 0, Batch.Arrangement.Deposit, Batch.Split.Equal, 3 days, ids, 250, 500) {}
            catch {}
        assert(credits.ownerOf(2) == ALICE);
    }
}
