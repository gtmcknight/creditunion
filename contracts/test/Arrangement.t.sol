// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {Batch} from "../src/Batch.sol";
import {BatchFactory} from "../src/BatchFactory.sol";
import {MockAssembler} from "../src/MockAssembler.sol";
import {ICredits} from "../src/interfaces/ICredits.sol";
import {MockCredits} from "../src/mocks/MockCredits.sol";
import {MockStatement} from "../src/mocks/MockStatement.sol";

/// @dev Records the order the Statement contract received.
contract RecordingStatement is MockStatement {
    uint256[] public last;

    constructor(ICredits c) MockStatement(c) {}

    function make(uint256[] calldata ids) external override returns (uint256 id) {
        last = ids;
        credits.burn(msg.sender, ids);
        id = ++totalSupply;
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
        factory = new BatchFactory(ICredits(address(credits)), new MockAssembler(statement), address(0), fee, 100, 10);
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
        b = Batch(factory.create("Arr", noFilter, new uint256[](0), 0, 0, how, 14 days, _range(51, 40)));
        vm.prank(alice);
        factory.deposit(address(b), _range(1, 40));
    }

    function test_DepositOrderPassesThrough() public {
        Batch b = _full(Batch.Arrangement.Deposit);
        b.assemble();
        uint256[] memory got = statement.lastOrder();
        assertEq(got[0], 51);
        assertEq(got[39], 90);
        assertEq(got[40], 1);
    }

    function test_NumberSortsById() public {
        Batch b = _full(Batch.Arrangement.Number);
        b.assemble();
        uint256[] memory got = statement.lastOrder();
        for (uint256 i; i < 80; ++i) assertEq(got[i], i < 40 ? i + 1 : i + 11);
    }

    function test_MintTimeSortsByTimestamp() public {
        // MockCredits stamps timestampOf(id) = id, so MintTime equals Number here; the point is the path.
        Batch b = _full(Batch.Arrangement.MintTime);
        b.assemble();
        assertEq(statement.lastOrder()[0], 1);
        assertEq(statement.lastOrder()[79], 90);
    }

    function test_CreatorOrders() public {
        Batch b = _full(Batch.Arrangement.Creator);
        // Within the grace, nobody else can burn...
        vm.prank(alice);
        vm.expectRevert(Batch.CreatorsTurn.selector);
        b.assemble();
        // ...and only the creator may hand in an order.
        uint256[] memory rev = new uint256[](80);
        uint256[] memory ids = b.ids();
        for (uint256 i; i < 80; ++i) rev[i] = ids[79 - i];
        vm.prank(alice);
        vm.expectRevert(Batch.NotCreator.selector);
        b.assembleOrdered(rev);
        vm.prank(bob);
        b.assembleOrdered(rev);
        assertEq(statement.lastOrder()[0], 40);
        assertEq(statement.lastOrder()[79], 51);
    }

    function test_CreatorOrderMustBePermutation() public {
        Batch b = _full(Batch.Arrangement.Creator);
        uint256[] memory ids = b.ids();
        uint256[] memory bad = ids;
        bad[3] = bad[4]; // duplicate
        vm.prank(bob);
        vm.expectRevert(Batch.BadOrder.selector);
        b.assembleOrdered(bad);
        uint256[] memory bad2 = b.ids();
        bad2[0] = 99; // not in the batch
        vm.prank(bob);
        vm.expectRevert(Batch.BadOrder.selector);
        b.assembleOrdered(bad2);
        uint256[] memory short_ = new uint256[](79);
        vm.prank(bob);
        vm.expectRevert(Batch.BadOrder.selector);
        b.assembleOrdered(short_);
    }

    function test_CreatorGraceThenAnyoneInDepositOrder() public {
        Batch b = _full(Batch.Arrangement.Creator);
        skip(b.CREATOR_ORDER_GRACE());
        vm.prank(alice);
        b.assemble();
        assertEq(statement.lastOrder()[0], 51); // deposit order
    }

    function test_OrderedOnlyForCreatorArrangement() public {
        Batch b = _full(Batch.Arrangement.Deposit);
        uint256[] memory ids = b.ids();
        vm.prank(bob);
        vm.expectRevert(Batch.BadOrder.selector);
        b.assembleOrdered(ids);
    }

    function test_ArrangementInSummary() public {
        Batch b = _full(Batch.Arrangement.MintTime);
        assertEq(uint256(b.summary().arrangement), uint256(Batch.Arrangement.MintTime));
    }
}
