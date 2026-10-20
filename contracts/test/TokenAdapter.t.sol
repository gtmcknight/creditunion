// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {ratingsOf} from "../script/RatingsOf.sol";
import {Batch, IRatings} from "../src/Batch.sol";
import {BatchFactory} from "../src/BatchFactory.sol";
import {IAssembler} from "../src/interfaces/IAssembler.sol";
import {ICredits} from "../src/interfaces/ICredits.sol";
import {IStatements} from "../src/interfaces/IStatements.sol";
import {IERC721} from "@openzeppelin/contracts/token/ERC721/IERC721.sol";
import {MockCredits} from "../src/mocks/MockCredits.sol";
import {MockStatement} from "../src/mocks/MockStatement.sol";
import {MockStatementVault} from "../src/mocks/MockStatementVault.sol";
import {TokenAdapter, ITokenUnions} from "../src/TokenAdapter.sol";
import {UnionFormats, IUnionFactory} from "../src/UnionFormats.sol";
import {ready} from "./utils/Ready.sol";

/// @dev Scores ×10 by id: Credit n scores n, so who put in what is easy to add up.
contract IdRatings is IRatings {
    function scoreOf(uint256 id) external pure returns (uint16) {
        return uint16(id);
    }

    function count() external pure returns (uint256) {
        return 1000;
    }
}

/// @dev A union creator that asks for the payout again from inside the token's callback, once, and lets the receipt
///      through whether or not the ask works.
contract Reenterer {
    TokenAdapter public immutable adapter;
    address public union;
    bool internal _again;

    constructor(TokenAdapter adapter_) {
        adapter = adapter_;
    }

    function open(BatchFactory factory, uint256[] calldata ids) external {
        IERC721(address(factory.credits())).setApprovalForAll(address(factory), true);
        Batch.Filter memory any;
        union = factory.create("R", any, new uint256[](0), 0, Batch.Arrangement.Deposit, Batch.Split.Equal, 14 days, ids, 200, 300, ratingsOf(address(factory)));
    }

    function onTokens(uint256) external {
        if (_again) return;
        _again = true;
        try adapter.distribute(union) {} catch {}
    }
}

/// @dev An assembler that only answers `lockDelay()`, with the bytes it was given (or reverts, given none), to see how
///      a Batch reads its notice.
contract Notice is IAssembler {
    bytes internal _answer;
    bool internal _answers;

    constructor(bytes memory answer_, bool answers_) {
        _answer = answer_;
        _answers = answers_;
    }

    function statement() external pure returns (address) {
        return address(0xdead);
    }

    function assemble(uint256[] calldata, uint8) external pure returns (uint256) {
        revert("not here");
    }

    fallback(bytes calldata) external returns (bytes memory) {
        require(_answers, "no lockDelay");
        return _answer;
    }
}

/// @notice Token unions: a second factory with TokenAdapter as its assembler. The burn puts the Statement in the vault
///         and books its tokens; distribute pays fees and members by the union's split.
contract TokenAdapterTest is Test {
    MockCredits credits;
    MockStatement statements;
    MockStatementVault vault;
    BatchFactory factory;
    UnionFormats formats;
    TokenAdapter adapter;
    Batch.Filter noFilter;
    address alice = makeAddr("alice");
    address bob = makeAddr("bob");
    address carol = makeAddr("carol");
    address fee = makeAddr("fee");
    uint256 constant PER = 1_000_000 ether;

    function setUp() public {
        credits = new MockCredits();
        statements = new MockStatement(ICredits(address(credits)));
        vault = new MockStatementVault(IERC721(address(statements)), PER);
        // The adapter needs the factory and the factory takes its assembler later: deploy with a setter, propose, activate.
        factory = new BatchFactory(ICredits(address(credits)), new IdRatings(), IAssembler(address(0)), address(this), fee, 200, 300, 1);
        formats = new UnionFormats(IUnionFactory(address(factory)));
        adapter = new TokenAdapter(ICredits(address(credits)), IStatements(address(statements)), ITokenUnions(address(factory)), formats, vault);
        factory.proposeAssembler(adapter);
        skip(factory.ASSEMBLER_DELAY());
        factory.activateAssembler();
        for (uint256 i; i < 3; ++i) {
            address u = [alice, bob, carol][i];
            credits.mint(u, 40);
            credits.mint(u, 40);
            vm.prank(u);
            credits.setApprovalForAll(address(factory), true);
        }
    }

    function _range(uint256 from, uint256 n) internal pure returns (uint256[] memory a) {
        a = new uint256[](n);
        for (uint256 i; i < n; ++i) a[i] = from + i;
    }

    /// Alice opens with 10, bob adds 30, carol fills 40; the union burns.
    function _burned(Batch.Split split) internal returns (Batch b) {
        vm.prank(alice);
        b = Batch(factory.create("T", noFilter, new uint256[](0), 0, Batch.Arrangement.Deposit, split, 14 days, _range(1, 10), 200, 300, ratingsOf(address(factory))));
        vm.prank(bob);
        factory.deposit(address(b), _range(81, 30));
        vm.prank(carol);
        factory.deposit(address(b), _range(161, 40));
        adapter.rate(address(b));
        ready(b);
        b.assemble();
    }

    /// What each member put in, with Credit n scoring n: alice 1..10, bob 81..110, carol 161..200.
    uint256 constant A = 55;
    uint256 constant B = 30 * 81 + 435; // 81..110
    uint256 constant C = 40 * 161 + 780; // 161..200

    function test_BurnConvertsAndHoldsReceipt() public {
        Batch b = _burned(Batch.Split.Equal);
        uint256 sid = b.statementId();
        assertEq(b.statement(), address(adapter), "the union holds the receipt");
        assertEq(adapter.ownerOf(sid), address(b));
        assertEq(statements.ownerOf(sid), address(vault), "the Statement is in the vault");
        address pocket = adapter.pocketOf(address(b));
        assertGt(pocket.code.length, 0, "the union's pocket exists");
        assertEq(vault.balanceOf(pocket), PER, "the tokens wait in the union's pocket");
        assertEq(vault.balanceOf(address(adapter)), 0, "never in the adapter");
        (uint256 id, uint256 amount, uint256 net,,,,) = adapter.conversionOf(address(b));
        assertEq(id, sid);
        assertEq(amount, PER);
        assertEq(net, PER - PER * 200 / 10_000 - PER * 300 / 10_000);
        for (uint256 i = 1; i <= 10; ++i) vm.assertFalse(_exists(i), "Credits burned");
    }

    /// Paid by the rating each put in, whatever the union's split says.
    function test_PaysByRating() public {
        for (uint256 k; k < 2; ++k) {
            if (k == 1) setUp();
            Batch b = _burned(k == 0 ? Batch.Split.Equal : Batch.Split.Early);
            adapter.distribute(address(b));
            (,, uint256 net, uint256 protocolFee, uint256 creatorFee,,) = adapter.conversionOf(address(b));
            uint256 total = A + B + C;
            assertEq(vault.balanceOf(alice), net * A / total + creatorFee, "alice: her rating's share and the creator fee");
            assertEq(vault.balanceOf(bob), net * B / total);
            assertEq(vault.balanceOf(carol), net * C / total);
            assertEq(vault.balanceOf(fee), protocolFee);
            assertLe(vault.balanceOf(adapter.pocketOf(address(b))), 3, "only rounding dust stays");
            (uint256 mine, uint256 all) = adapter.ratingOf(address(b), bob);
            assertEq(mine, B);
            assertEq(all, total);
        }
    }

    function test_DistributeTwiceChangesNothing() public {
        Batch b = _burned(Batch.Split.Equal);
        adapter.distribute(address(b));
        uint256 got = vault.balanceOf(bob);
        adapter.distribute(address(b));
        assertEq(vault.balanceOf(bob), got);
        vm.expectRevert(TokenAdapter.NothingToClaim.selector);
        adapter.claim(address(b), bob);
    }

    /// The burn waits for a rating of the 80 it holds; a rating from before a change doesn't count.
    function test_BurnNeedsCurrentRating() public {
        vm.prank(alice);
        Batch b = Batch(factory.create("T", noFilter, new uint256[](0), 0, Batch.Arrangement.Deposit, Batch.Split.Equal, 14 days, _range(1, 10), 200, 300, ratingsOf(address(factory))));
        vm.prank(bob);
        factory.deposit(address(b), _range(81, 30));
        vm.prank(carol);
        factory.deposit(address(b), _range(161, 40));
        ready(b);
        vm.expectRevert(TokenAdapter.NotRated.selector);
        b.assemble();
        adapter.rate(address(b));
        assertTrue(adapter.rated(address(b)));
        b.assemble();
    }

    function test_RefusedMemberClaimsLater() public {
        Batch b = _burned(Batch.Split.Equal);
        vault.block_(bob, true);
        adapter.distribute(address(b));
        (,, uint256 net,,,,) = adapter.conversionOf(address(b));
        uint256 total = A + B + C;
        assertEq(vault.balanceOf(bob), 0);
        assertEq(vault.balanceOf(carol), net * C / total, "one refusal stops no one else");
        assertEq(adapter.claimable(address(b), bob), net * B / total);
        vault.block_(bob, false);
        adapter.claim(address(b), bob);
        assertEq(vault.balanceOf(bob), net * B / total);
    }

    /// In parts: the fees and the next members not yet paid, in the order they joined, then the rest.
    function test_DistributeNextPaysInParts() public {
        Batch b = _burned(Batch.Split.Equal);
        (,, uint256 net, uint256 protocolFee, uint256 creatorFee,,) = adapter.conversionOf(address(b));
        uint256 total = A + B + C;
        adapter.distributeNext(address(b), 2);
        assertEq(vault.balanceOf(fee), protocolFee, "the fees go with the first part");
        assertEq(vault.balanceOf(alice), net * A / total + creatorFee);
        assertEq(vault.balanceOf(bob), net * B / total);
        assertEq(vault.balanceOf(carol), 0, "carol joined last");
        assertEq(adapter.claimable(address(b), carol), net * C / total);
        adapter.distributeNext(address(b), 2);
        assertEq(vault.balanceOf(carol), net * C / total);
        assertLe(vault.balanceOf(adapter.pocketOf(address(b))), 3, "only rounding dust stays");
        adapter.distributeNext(address(b), 2);
        adapter.distribute(address(b));
        assertEq(vault.balanceOf(carol), net * C / total, "nothing is paid twice");
    }

    /// A member whose transfer fails takes a place in the part and is tried again in the next.
    function test_DistributeNextRetriesRefused() public {
        Batch b = _burned(Batch.Split.Equal);
        (,, uint256 net,,,,) = adapter.conversionOf(address(b));
        uint256 total = A + B + C;
        vault.block_(bob, true);
        adapter.distributeNext(address(b), 2);
        assertEq(vault.balanceOf(bob), 0);
        assertEq(vault.balanceOf(carol), 0);
        adapter.distributeNext(address(b), 2);
        assertEq(vault.balanceOf(bob), 0);
        assertEq(vault.balanceOf(carol), net * C / total);
        vault.block_(bob, false);
        adapter.distributeNext(address(b), 1);
        assertEq(vault.balanceOf(bob), net * B / total);
    }

    /// A creator whose token callback asks for the payout again still gets the creator fee once, and no one is short.
    function test_CallbackCantTakeFeeTwice() public {
        Reenterer r = new Reenterer(adapter);
        uint256 first = credits.mint(address(r), 10);
        r.open(factory, _range(first, 10));
        Batch b = Batch(r.union());
        vm.prank(bob);
        factory.deposit(address(b), _range(81, 30));
        vm.prank(carol);
        factory.deposit(address(b), _range(161, 40));
        adapter.rate(address(b));
        ready(b);
        b.assemble();
        vault.hook(address(r));
        adapter.distribute(address(b));
        (,, uint256 net,, uint256 creatorFee,,) = adapter.conversionOf(address(b));
        uint256 mine = 10 * first + 45;
        uint256 total = mine + B + C;
        assertEq(vault.balanceOf(address(r)), net * mine / total + creatorFee, "the creator fee once");
        assertEq(vault.balanceOf(bob), net * B / total);
        assertEq(vault.balanceOf(carol), net * C / total, "no one is short");
        assertLe(vault.balanceOf(adapter.pocketOf(address(b))), 3, "only rounding dust stays");
    }

    /// Too little gas for the next payment reverts the call, fees and all, instead of skipping someone, so a wallet's
    /// gas estimate covers every payment.
    function test_ShortGasRevertsInsteadOfSkipping() public {
        Batch b = _burned(Batch.Split.Equal);
        vm.expectRevert(TokenAdapter.PayoutGasTooLow.selector);
        adapter.distribute{gas: 1_200_000}(address(b));
        assertEq(vault.balanceOf(fee), 0);
        assertEq(vault.balanceOf(alice), 0);
        assertGt(adapter.claimable(address(b), alice), 0, "still owed, nothing booked as paid");
        adapter.distribute{gas: 3_000_000}(address(b));
        assertGt(vault.balanceOf(carol), 0);
    }

    /// A token union locks the moment its 80th Credit lands: no countdown, no way out, and it burns in that block.
    function test_LocksTheMomentItFills() public {
        vm.prank(alice);
        Batch b = Batch(factory.create("T", noFilter, new uint256[](0), 0, Batch.Arrangement.Deposit, Batch.Split.Equal, 14 days, _range(1, 40), 200, 300, ratingsOf(address(factory))));
        vm.prank(bob);
        factory.deposit(address(b), _range(81, 39));
        assertEq(uint256(b.phase()), uint256(Batch.Phase.Open));
        vm.prank(bob);
        factory.deposit(address(b), _range(120, 1));
        assertEq(uint256(b.phase()), uint256(Batch.Phase.Burnable), "burnable the moment it fills");
        assertEq(b.lockAt(), block.timestamp);
        uint256[] memory one = _range(120, 1);
        vm.prank(bob);
        vm.expectRevert(abi.encodeWithSelector(Batch.WrongPhase.selector, Batch.Phase.Burnable));
        b.withdraw(one);
        adapter.rate(address(b));
        b.assemble();
        assertEq(uint256(b.phase()), uint256(Batch.Phase.Assembled), "converted in the block it filled");
    }

    /// Unions whose assembler states no notice (the auction kind) still count down LOCK_DELAY; a longer stated notice
    /// is capped at it, an answer that isn't one word counts as none, and a shorter one is kept.
    function test_AuctionUnionsStillCountDown() public {
        bytes[4] memory answers = [bytes(""), abi.encode(uint256(1 days)), abi.encode(uint256(1), uint256(2)), abi.encode(uint256(30))];
        bool[4] memory answers_ = [false, true, true, true];
        uint256[4] memory want = [uint256(5 minutes), 5 minutes, 5 minutes, 30];
        for (uint256 k; k < 4; ++k) {
            BatchFactory f = new BatchFactory(ICredits(address(credits)), new IdRatings(), IAssembler(address(0)), address(this), fee, 200, 300, 1);
            f.proposeAssembler(new Notice(answers[k], answers_[k]));
            skip(f.ASSEMBLER_DELAY());
            f.activateAssembler();
            address who = makeAddr(string.concat("notice-", vm.toString(k)));
            uint256 first = credits.mint(who, 80);
            vm.startPrank(who);
            credits.setApprovalForAll(address(f), true);
            Batch b = Batch(f.create("N", noFilter, new uint256[](0), 0, Batch.Arrangement.Deposit, Batch.Split.Equal, 14 days, _range(first, 40), 200, 300, ratingsOf(address(f))));
            f.deposit(address(b), _range(first + 40, 40));
            vm.stopPrank();
            assertEq(b.lockAt(), block.timestamp + want[k], "lock delay");
            assertEq(uint256(b.phase()), uint256(Batch.Phase.Countdown));
        }
    }

    /// Before the token's transfers open, the burn still converts but nothing can be paid: a payout call reverts
    /// (NobodyPaid) so no one spends gas on it, fees and members stay owed and a claim reverts. The first payout after
    /// the opening pays everyone in full.
    function test_PayoutsWaitForTheOpening() public {
        vault.setTransfersOpenBlock(uint64(block.number + 100));
        Batch b = _burned(Batch.Split.Equal);
        (,, uint256 net, uint256 protocolFee, uint256 creatorFee,,) = adapter.conversionOf(address(b));
        uint256 total = A + B + C;
        vm.expectRevert(TokenAdapter.NobodyPaid.selector);
        adapter.distribute(address(b));
        assertEq(vault.balanceOf(alice) + vault.balanceOf(bob) + vault.balanceOf(carol) + vault.balanceOf(fee), 0, "nothing moves before the opening");
        assertEq(adapter.claimable(address(b), bob), net * B / total, "still owed");
        vm.expectRevert(TokenAdapter.PaymentFailed.selector);
        adapter.claim(address(b), bob);
        vm.roll(block.number + 100);
        adapter.distribute(address(b));
        assertEq(vault.balanceOf(fee), protocolFee);
        assertEq(vault.balanceOf(alice), net * A / total + creatorFee);
        assertEq(vault.balanceOf(bob), net * B / total);
        assertEq(vault.balanceOf(carol), net * C / total);
        assertEq(adapter.claimable(address(b), carol), 0);
    }

    /// Until the token takes Statements (its renderer registered, its creator's launch retirement done) a burn reverts
    /// whole: the Credits stay in the union, unburned, and the same burn converts once the gate opens.
    function test_NoBurnBeforeTheLaunchGate() public {
        vm.prank(alice);
        Batch b = Batch(factory.create("T", noFilter, new uint256[](0), 0, Batch.Arrangement.Deposit, Batch.Split.Equal, 14 days, _range(1, 10), 200, 300, ratingsOf(address(factory))));
        vm.prank(bob);
        factory.deposit(address(b), _range(81, 30));
        vm.prank(carol);
        factory.deposit(address(b), _range(161, 40));
        adapter.rate(address(b));
        ready(b);
        vault.setGate(false, 0, 0);
        vm.expectRevert(MockStatementVault.RendererNotRegistered.selector);
        b.assemble();
        vault.setGate(true, 2_386, 0);
        vm.expectRevert(MockStatementVault.LaunchSupplyNotFinalized.selector);
        b.assemble();
        assertEq(b.count(), 80, "still whole");
        for (uint256 i = 1; i <= 10; ++i) assertTrue(_exists(i), "nothing burned");
        vault.setGate(true, 2_386, 2_386);
        b.assemble();
        (, uint256 amount,,,,,) = adapter.conversionOf(address(b));
        assertEq(amount, PER, "converted once the gate opened");
    }

    /// Rating writes down what each member put in, once; a claim reads that one number.
    function test_RateStoresEachMembersShare() public {
        vm.prank(alice);
        Batch b = Batch(factory.create("T", noFilter, new uint256[](0), 0, Batch.Arrangement.Deposit, Batch.Split.Equal, 14 days, _range(1, 10), 200, 300, ratingsOf(address(factory))));
        vm.prank(bob);
        factory.deposit(address(b), _range(81, 30));
        vm.prank(carol);
        factory.deposit(address(b), _range(161, 40));
        adapter.rate(address(b));
        assertEq(adapter.putIn(address(b), alice), A);
        assertEq(adapter.putIn(address(b), bob), B);
        assertEq(adapter.putIn(address(b), carol), C);
        (uint256 mine, uint256 total) = adapter.ratingOf(address(b), bob);
        assertEq(mine, B);
        assertEq(total, A + B + C);
    }

    /// A union whose 80 changed (its burn hour ran out, one member left, another filled it) is rated from scratch:
    /// whoever left is owed nothing, whoever came in is.
    function test_RerateClearsWhoLeft() public {
        vm.prank(alice);
        Batch b = Batch(factory.create("T", noFilter, new uint256[](0), 0, Batch.Arrangement.Deposit, Batch.Split.Equal, 14 days, _range(1, 10), 200, 300, ratingsOf(address(factory))));
        vm.prank(bob);
        factory.deposit(address(b), _range(81, 30));
        vm.prank(carol);
        factory.deposit(address(b), _range(161, 40));
        adapter.rate(address(b));
        vm.warp(block.timestamp + b.BURN_WINDOW() + 1);
        vm.prank(carol);
        b.withdraw(_range(161, 40));
        vm.prank(alice);
        factory.deposit(address(b), _range(11, 40)); // 11..50
        adapter.rate(address(b));
        assertEq(adapter.putIn(address(b), carol), 0, "left: owed nothing");
        assertEq(adapter.putIn(address(b), alice), A + 1220);
        (, uint256 total) = adapter.ratingOf(address(b), alice);
        assertEq(total, A + B + 1220);
    }

    /// Shares are final once the tokens exist: rating a converted union reverts.
    function test_NoRateAfterConversion() public {
        Batch b = _burned(Batch.Split.Equal);
        vm.expectRevert(TokenAdapter.AlreadyConverted.selector);
        adapter.rate(address(b));
    }

    /// A keeper pays only the members it lists (the ones worth a transaction); the fees go with the first call, and
    /// everyone else still claims.
    function test_DistributeToPaysOnlyThoseListed() public {
        Batch b = _burned(Batch.Split.Equal);
        (,, uint256 net, uint256 protocolFee,,,) = adapter.conversionOf(address(b));
        uint256 total = A + B + C;
        address[] memory members = adapter.membersOf(address(b));
        assertEq(members.length, 3);
        assertEq(members[0], alice);
        address[] memory who = new address[](2);
        who[0] = carol;
        who[1] = address(0xBEEF); // put nothing in: skipped
        adapter.distributeTo(address(b), who);
        assertEq(vault.balanceOf(carol), net * C / total);
        assertEq(vault.balanceOf(fee), protocolFee, "the fees go with it");
        assertEq(vault.balanceOf(bob), 0, "not listed: claims instead");
        assertEq(adapter.claimable(address(b), bob), net * B / total);
        adapter.distributeTo(address(b), who); // again: nothing more for carol
        assertEq(vault.balanceOf(carol), net * C / total);
        adapter.claim(address(b), bob);
        assertEq(vault.balanceOf(bob), net * B / total);
    }

    function test_FormatFollowsPick() public {
        vm.prank(alice);
        Batch b = Batch(factory.create("T", noFilter, new uint256[](0), 0, Batch.Arrangement.Deposit, Batch.Split.Equal, 14 days, _range(1, 10), 200, 300, ratingsOf(address(factory))));
        vm.prank(alice);
        formats.pick(address(b), 5); // Amortized
        vm.prank(bob);
        factory.deposit(address(b), _range(81, 40));
        vm.prank(carol);
        factory.deposit(address(b), _range(161, 30));
        adapter.rate(address(b));
        ready(b);
        b.assemble();
        assertEq(statements.formatOf(b.statementId()), 5);
    }

    function test_OnlyUnionsBurn() public {
        vm.expectRevert(TokenAdapter.NotAUnion.selector);
        adapter.assemble(_range(1, 80), 0);
    }

    function test_NothingBeforeTheBurn() public {
        vm.expectRevert(TokenAdapter.NotConverted.selector);
        adapter.distribute(address(0xBEEF));
        vm.expectRevert(TokenAdapter.NotConverted.selector);
        adapter.distributeNext(address(0xBEEF), 1);
    }

    function _exists(uint256 id) internal view returns (bool) {
        try credits.ownerOf(id) returns (address) {
            return true;
        } catch {
            return false;
        }
    }
}
