// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test, stdStorage, StdStorage} from "forge-std/Test.sol";
import {ratingsOf} from "../script/RatingsOf.sol";
import {Batch, IRatings} from "../src/Batch.sol";
import {BatchFactory} from "../src/BatchFactory.sol";
import {StatementAdapter, IUnions} from "../src/StatementAdapter.sol";
import {IAssembler} from "../src/interfaces/IAssembler.sol";
import {ICredits} from "../src/interfaces/ICredits.sol";
import {IStatements} from "../src/interfaces/IStatements.sol";
import {MockCredits} from "../src/mocks/MockCredits.sol";
import {MockStatement} from "../src/mocks/MockStatement.sol";

/// @notice The draft StatementAdapter against the stand-in for Jack's contract (MockStatement.compose): the burn,
///         the creator's direction and when it can change, waiting for Jack's contract to open, its cap, and what
///         the adapter refuses. The same checks rerun against his real contract on a mainnet fork
///         (StatementAdapter.fork.t.sol) once it's published.
contract StatementAdapterTest is Test {
    using stdStorage for StdStorage;

    MockCredits credits;
    MockStatement statements;
    StatementAdapter adapter;
    BatchFactory factory;
    Batch.Filter noFilter;
    address setter = makeAddr("setter");
    address fee = makeAddr("fee");
    address alice = makeAddr("alice"); // opens the union, so she is its creator
    address bob = makeAddr("bob");

    function setUp() public {
        vm.warp(1_000_000);
        credits = new MockCredits();
        statements = new MockStatement(ICredits(address(credits)));
        factory = new BatchFactory(ICredits(address(credits)), IRatings(address(0)), IAssembler(address(0)), setter, fee, 100, 0, 1);
        adapter = new StatementAdapter(ICredits(address(credits)), IStatements(address(statements)), IUnions(address(factory)));
        credits.mint(alice, 100); // 1..100
        credits.mint(bob, 100); // 101..200
        vm.prank(alice);
        credits.setApprovalForAll(address(factory), true);
        vm.prank(bob);
        credits.setApprovalForAll(address(factory), true);
    }

    function _range(uint256 from, uint256 n) internal pure returns (uint256[] memory a) {
        a = new uint256[](n);
        for (uint256 i; i < n; ++i) a[i] = from + i;
    }

    /// alice opens with 1..40.
    function _open() internal returns (Batch b) {
        vm.prank(alice);
        b = Batch(factory.create("S", noFilter, new uint256[](0), 0, Batch.Arrangement.NumberDesc, Batch.Split.Equal, 14 days, _range(1, 40), 100, 0, ratingsOf(address(factory))));
    }

    /// bob fills it with 101..140.
    function _fill(Batch b) internal {
        vm.prank(bob);
        factory.deposit(address(b), _range(101, 40));
        assertEq(uint256(b.state()), uint256(Batch.State.Full));
    }

    /// The setter proposes the adapter; 30 minutes later anyone switches it on.
    function _switchOn() internal {
        vm.prank(setter);
        factory.proposeAssembler(adapter);
        skip(factory.ASSEMBLER_DELAY());
        factory.activateAssembler();
    }

    function _burnHour(Batch b) internal {
        skip(b.LOCK_DELAY());
        assertEq(uint8(b.phase()), uint8(Batch.Phase.Burnable));
    }

    function _choose(Batch b, StatementAdapter.Direction d) internal {
        vm.prank(alice);
        adapter.chooseDirection(address(b), d);
    }

    function _fixedIn(Batch b, Batch.Phase p) internal {
        assertEq(uint8(b.phase()), uint8(p));
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(StatementAdapter.DirectionFixed.selector, p));
        adapter.chooseDirection(address(b), StatementAdapter.Direction.Balance);
    }

    function test_theDraftIsNotReadyForMainnet() public view {
        assertFalse(adapter.READY(), "flip READY only after _compose meets Jack's real contract on a mainnet fork");
    }

    function test_burnsAFullUnionIntoAStatement() public {
        Batch b = _open();
        _fill(b);
        _switchOn();
        _burnHour(b);
        uint256[] memory order = b.burnOrder();
        b.assemble();

        uint256 sid = b.statementId();
        assertEq(statements.ownerOf(sid), address(b), "the union owns its Statement");
        for (uint256 i; i < 80; ++i) {
            vm.expectRevert();
            credits.ownerOf(order[i]);
        }
        assertEq(statements.orderOf(sid), order, "burned in the union's order");
        assertEq(statements.directionOf(sid), uint8(StatementAdapter.Direction.Issued), "nobody chose: Issued");
        assertEq(credits.balanceOf(address(adapter)), 0, "the adapter keeps no Credits");
        assertEq(statements.balanceOf(address(adapter)), 0, "or Statements");
    }

    function test_theCreatorsDirectionReachesTheStatement() public {
        Batch b = _open();
        _choose(b, StatementAdapter.Direction.Balance);
        _fill(b);
        _switchOn();
        _burnHour(b);
        b.assemble();
        assertEq(statements.directionOf(b.statementId()), uint8(StatementAdapter.Direction.Balance));
    }

    function test_theDirectionCanChangeWhileMembersCanLeave() public {
        Batch b = _open();
        _choose(b, StatementAdapter.Direction.Consolidated); // filling
        _fill(b);
        assertEq(uint8(b.phase()), uint8(Batch.Phase.Waiting));
        _choose(b, StatementAdapter.Direction.Reconciled); // full, waiting for burning to open
        vm.prank(setter);
        factory.proposeAssembler(adapter);
        _choose(b, StatementAdapter.Direction.Balance); // still waiting during the 30-minute notice
        assertEq(uint8(adapter.directionOf(address(b))), uint8(StatementAdapter.Direction.Balance));
    }

    function test_theDirectionIsFixedFromTheCountdown() public {
        Batch b = _open();
        _fill(b);
        _switchOn();
        _fixedIn(b, Batch.Phase.Countdown);
        skip(b.LOCK_DELAY());
        _fixedIn(b, Batch.Phase.Burnable);
        b.assemble();
        _fixedIn(b, Batch.Phase.Assembled);
    }

    function test_aLapsedBurnHourOpensItAgain() public {
        Batch b = _open();
        _fill(b);
        _switchOn();
        skip(b.LOCK_DELAY() + b.BURN_WINDOW());
        assertEq(uint8(b.phase()), uint8(Batch.Phase.Expired));
        _choose(b, StatementAdapter.Direction.Consolidated); // unlocked again: everyone can leave
        b.restartCountdown();
        _fixedIn(b, Batch.Phase.Countdown);
    }

    function test_onlyTheCreatorChooses() public {
        Batch b = _open();
        vm.prank(bob);
        vm.expectRevert(StatementAdapter.NotTheCreator.selector);
        adapter.chooseDirection(address(b), StatementAdapter.Direction.Balance);
    }

    function test_thereAreOnlyFourDirections() public {
        Batch b = _open();
        vm.prank(alice);
        (bool ok,) = address(adapter).call(abi.encodeWithSelector(StatementAdapter.chooseDirection.selector, address(b), uint8(4)));
        assertFalse(ok);
    }

    function test_onlyTheFactorysUnions() public {
        vm.prank(alice);
        vm.expectRevert(StatementAdapter.NotAUnion.selector);
        adapter.chooseDirection(makeAddr("not a union"), StatementAdapter.Direction.Balance);

        // A holder can't burn through it directly, even with 80 Credits and an approval.
        vm.startPrank(alice);
        credits.setApprovalForAll(address(adapter), true);
        vm.expectRevert(StatementAdapter.NotAUnion.selector);
        adapter.assemble(_range(1, 80), 0);
        vm.stopPrank();
    }

    function test_nothingMovesBeforeJacksContractOpens() public {
        statements.setOpensAt(block.timestamp + 1 days);
        Batch b = _open();
        _fill(b);
        _switchOn();
        _burnHour(b);
        uint256[] memory order = b.burnOrder();
        vm.expectRevert(bytes("not open"));
        b.assemble();
        for (uint256 i; i < 80; ++i) assertEq(credits.ownerOf(order[i]), address(b), "every Credit stays in the union");

        // The hour lapses and the union unlocks. Once Jack's contract opens, a fresh countdown burns it.
        skip(b.BURN_WINDOW());
        vm.warp(statements.opensAt());
        b.restartCountdown();
        _burnHour(b);
        b.assemble();
        assertEq(statements.ownerOf(b.statementId()), address(b));
    }

    function test_atJacksCapTheUnionKeepsItsCredits() public {
        stdstore.target(address(statements)).sig("totalSupply()").checked_write(statements.CAP());
        Batch b = _open();
        _fill(b);
        _switchOn();
        _burnHour(b);
        vm.expectRevert(bytes("cap"));
        b.assemble();
        assertEq(uint8(b.phase()), uint8(Batch.Phase.Burnable));
        assertEq(credits.balanceOf(address(b)), 80);
    }

    function test_takesNothingButStatements() public {
        vm.prank(alice);
        vm.expectRevert(StatementAdapter.NotAStatement.selector);
        credits.safeTransferFrom(alice, address(adapter), 1);
    }
}
