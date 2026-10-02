// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {ratingsOf} from "../script/RatingsOf.sol";
import {Batch, IRatings} from "../src/Batch.sol";
import {BatchFactory} from "../src/BatchFactory.sol";
import {MockAssembler} from "../src/mocks/MockAssembler.sol";
import {ICredits} from "../src/interfaces/ICredits.sol";
import {MockCredits} from "../src/mocks/MockCredits.sol";
import {MockStatement} from "../src/mocks/MockStatement.sol";
import {ready} from "./utils/Ready.sol";

/// @dev Records the order the Statement contract received.
contract RecordingStatement is MockStatement {
    uint256[] public last;

    constructor(ICredits c) MockStatement(c) {}

    function make(uint256[] calldata ids) external override returns (uint256 id) {
        last = ids;
        credits.burn(msg.sender, ids);
        id = ++supply;
        _safeMint(msg.sender, id);
    }

    function lastOrder() external view returns (uint256[] memory) {
        return last;
    }
}

contract ArrangementTest is Test {
    MockCredits credits;
    RecordingStatement statement;
    BatchFactory factory;
    address fee = makeAddr("fee");
    address alice = makeAddr("alice");
    address bob = makeAddr("bob");
    Batch.Filter noFilter;

    function setUp() public {
        credits = new MockCredits();
        statement = new RecordingStatement(ICredits(address(credits)));
        factory = new BatchFactory(ICredits(address(credits)), IRatings(address(0)), new MockAssembler(statement), address(0), fee, 100, 0, 10);
        credits.mint(alice, 50);
        credits.mint(bob, 50);
        for (uint256 i; i < 2; ++i) {
            address u = [alice, bob][i];
            vm.prank(u);
            credits.setApprovalForAll(address(factory), true);
        }
    }

    function _range(uint256 from, uint256 n) internal pure returns (uint256[] memory a) {
        a = new uint256[](n);
        for (uint256 i; i < n; ++i) a[i] = from + i;
    }

    /// bob deposits first (51..90), then alice (1..40): deposit order differs from id order.
    function _full(Batch.Arrangement how) internal returns (Batch b) {
        vm.prank(bob);
        b = Batch(factory.create("Arr", noFilter, new uint256[](0), 0, how, Batch.Split.Equal, 14 days, _range(51, 40), 100, 0, ratingsOf(address(factory))));
        vm.prank(alice);
        factory.deposit(address(b), _range(1, 40));
    }

    function test_DepositOrderPassesThrough() public {
        Batch b = _full(Batch.Arrangement.Deposit);
        ready(b);
        b.assemble();
        uint256[] memory got = statement.lastOrder();
        assertEq(got[0], 51);
        assertEq(got[39], 90);
        assertEq(got[40], 1);
    }

    function test_NumberSortsById() public {
        Batch b = _full(Batch.Arrangement.Number);
        ready(b);
        b.assemble();
        uint256[] memory got = statement.lastOrder();
        for (uint256 i; i < 80; ++i) assertEq(got[i], i < 40 ? i + 1 : i + 11);
    }

    function test_NumberDescSortsByIdHighToLow() public {
        Batch b = _full(Batch.Arrangement.NumberDesc);
        ready(b);
        b.assemble();
        assertEq(statement.lastOrder()[0], 90);
        assertEq(statement.lastOrder()[79], 1);
    }

    /// Creator's order is retired: new batches can't choose it.
    function test_CreatorArrangementRetired() public {
        vm.prank(bob);
        vm.expectRevert(Batch.ArrangementRetired.selector);
        factory.create("x", noFilter, new uint256[](0), 0, Batch.Arrangement.Creator, Batch.Split.Equal, 14 days, _range(1, 40), 100, 0, ratingsOf(address(factory)));
    }

    function test_ArrangementInSummary() public {
        Batch b = _full(Batch.Arrangement.NumberDesc);
        assertEq(uint256(b.summary().arrangement), uint256(Batch.Arrangement.NumberDesc));
    }
}
