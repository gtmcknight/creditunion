// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {ratingsOf} from "../../script/RatingsOf.sol";
import {Batch, IRatings} from "../../src/Batch.sol";
import {BatchFactory} from "../../src/BatchFactory.sol";
import {IAssembler} from "../../src/interfaces/IAssembler.sol";
import {ICredits} from "../../src/interfaces/ICredits.sol";
import {MockCredits} from "../../src/mocks/MockCredits.sol";
import {MockStatement} from "../../src/mocks/MockStatement.sol";
import {MockAssembler} from "../../src/mocks/MockAssembler.sol";

/// @dev Halmos cheatcodes (a16z/halmos-cheatcodes), declared here so the suite needs no extra dependency.
interface SVM {
    function createUint256(string memory name) external pure returns (uint256);
    function createUint(uint256 bits, string memory name) external pure returns (uint256);
    function createAddress(string memory name) external pure returns (address);
    function createBool(string memory name) external pure returns (bool);
    function createCalldata(string memory contractName) external pure returns (bytes memory);
}

SVM constant svm = SVM(0xF3993A62377BCd56AE39D773740A5390411E8BC9);

/// @dev Shared world for the formal suite: Credits, a Statement and its adapter, a factory, and named actors.
///      Rules are written as Halmos `check_` functions: every input is symbolic, so a rule that passes holds
///      for every value, not a sample.
abstract contract FormalBase is Test {
    address internal constant FEE = address(0xFEE);
    address internal constant SETTER = address(0x5E77);
    address internal constant ALICE = address(0xA11CE);
    address internal constant BOB = address(0xB0B);
    uint256 internal constant PROTOCOL_BPS = 250;
    uint256 internal constant CREATOR_BPS = 500;

    MockCredits internal credits;
    MockStatement internal statement;
    MockAssembler internal asm_;
    BatchFactory internal factory;

    /// @param live deploy with the assembler already active (true) or with none, for the setter to propose.
    function _world(bool live) internal {
        vm.warp(1_000_000);
        credits = new MockCredits();
        statement = new MockStatement(ICredits(address(credits)));
        asm_ = new MockAssembler(statement);
        factory = new BatchFactory(
            ICredits(address(credits)),
            IRatings(address(0)),
            live ? IAssembler(address(asm_)) : IAssembler(address(0)),
            SETTER,
            FEE,
            PROTOCOL_BPS,
            CREATOR_BPS,
            1
        );
    }

    function _ids(uint256 first, uint256 n) internal pure returns (uint256[] memory a) {
        a = new uint256[](n);
        for (uint256 i; i < n; ++i) a[i] = first + i;
    }

    function _open(address who, uint256[] memory ids, Batch.Split split) internal returns (Batch b) {
        Batch.Filter memory f;
        vm.startPrank(who);
        credits.setApprovalForAll(address(factory), true);
        b = Batch(
            factory.create("u", f, new uint256[](0), 0, Batch.Arrangement.Deposit, split, 3 days, ids, PROTOCOL_BPS, CREATOR_BPS, ratingsOf(address(factory)))
        );
        vm.stopPrank();
    }

    /// @dev Actors the protocol treats as special; a symbolic caller is kept distinct from them where the
    ///      rule is about outsiders.
    function _outsider(address a) internal view {
        vm.assume(a != address(factory) && a != address(credits) && a != address(statement) && a != address(asm_));
        vm.assume(a != address(this) && a != address(0));
    }
}
