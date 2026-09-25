// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {Batch, IRatings} from "../src/Batch.sol";
import {BatchFactory} from "../src/BatchFactory.sol";
import {Sweeper} from "../src/Sweeper.sol";
import {MockAssembler} from "../src/MockAssembler.sol";
import {ICredits} from "../src/interfaces/ICredits.sol";
import {ISeaport} from "../src/interfaces/ISeaport.sol";
import {MockCredits} from "../src/mocks/MockCredits.sol";
import {MockStatement} from "../src/mocks/MockStatement.sol";

/// @notice Audit unit tests for BatchFactory.depositFor and Sweeper, on the mocks.
contract AuditSweeperTest is Test {
    MockCredits credits;
    MockStatement statement;
    BatchFactory factory;
    Sweeper sweeper;
    address fee = makeAddr("fee");
    address alice = makeAddr("alice");
    address bob = makeAddr("bob");
    address carol = makeAddr("carol");
    Batch.Filter noFilter;

    function setUp() public {
        credits = new MockCredits();
        statement = new MockStatement(ICredits(address(credits)));
        factory = new BatchFactory(ICredits(address(credits)), IRatings(address(0)), new MockAssembler(statement), address(0), fee, 100, 0, 10);
        sweeper = new Sweeper(ISeaport(makeAddr("seaport")), factory, 100);
        credits.mint(alice, 50); // ids 1..50
        credits.mint(bob, 50); // ids 51..100
        for (uint256 i; i < 3; ++i) {
            address u = [alice, bob, carol][i];
            vm.prank(u);
            credits.setApprovalForAll(address(factory), true);
            vm.deal(u, 100 ether);
        }
    }

    function _range(uint256 from, uint256 n) internal pure returns (uint256[] memory a) {
        a = new uint256[](n);
        for (uint256 i; i < n; ++i) a[i] = from + i;
    }

    /// @dev depositFor may not name a sink that could never withdraw or be paid: the batch itself, the
    ///      factory, or another batch. (Any other contract without receive() is still the caller's own
    ///      mistake; the factory only ever moves the caller's Credits.)
    function test_DepositForRejectsSinks() public {
        vm.prank(alice);
        Batch b = Batch(factory.create("Audit", noFilter, new uint256[](0), 0, Batch.Arrangement.Deposit, 14 days, _range(1, 40), 100, 0));
        vm.startPrank(bob);
        vm.expectRevert(BatchFactory.NoDepositor.selector);
        factory.depositFor(address(b), _range(90, 1), address(b));
        vm.expectRevert(BatchFactory.NoDepositor.selector);
        factory.depositFor(address(b), _range(90, 1), address(factory));
        vm.expectRevert(BatchFactory.NoDepositor.selector);
        factory.depositFor(address(b), _range(90, 1), address(0));
        factory.depositFor(address(b), _range(90, 1), carol); // a person is fine
        vm.stopPrank();
        assertEq(b.depositorOf(90), carol);
    }

    function test_DepositForOnlyMovesCallersCredits() public {
        vm.prank(alice);
        Batch b = Batch(factory.create("Audit", noFilter, new uint256[](0), 0, Batch.Arrangement.Deposit, 14 days, _range(1, 10), 100, 0));
        // bob names alice as depositor but tries to move alice's Credit 11: fails at transferFrom.
        vm.prank(bob);
        vm.expectRevert();
        factory.depositFor(address(b), _range(11, 1), alice);
        // The Sweeper approved the factory, but only a call *from* the Sweeper could use that approval.
        credits.mint(address(sweeper), 1); // id 101 held by the sweeper
        vm.prank(bob);
        vm.expectRevert();
        factory.depositFor(address(b), _range(101, 1), bob);
        assertEq(credits.ownerOf(101), address(sweeper));
    }

    /// The buy-in fee moves only by the fee recipient, never above the cap, and every quote reads the current one.
    function test_FeeSetterCapped() public {
        assertEq(sweeper.quote(1 ether), 1.01 ether);
        vm.prank(bob);
        vm.expectRevert(Sweeper.NotFeeRecipient.selector);
        sweeper.setFee(200);
        vm.prank(fee);
        vm.expectRevert(Sweeper.FeeTooHigh.selector);
        sweeper.setFee(501);
        vm.prank(fee);
        sweeper.setFee(200);
        assertEq(sweeper.feeBps(), 200);
        assertEq(sweeper.quote(1 ether), 1.02 ether);
    }
}
