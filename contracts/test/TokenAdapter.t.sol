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
        assertEq(vault.balanceOf(address(adapter)), PER, "the tokens wait in the adapter");
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
            assertLe(vault.balanceOf(address(adapter)), 3, "only rounding dust stays");
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
    }

    function _exists(uint256 id) internal view returns (bool) {
        try credits.ownerOf(id) returns (address) {
            return true;
        } catch {
            return false;
        }
    }
}
