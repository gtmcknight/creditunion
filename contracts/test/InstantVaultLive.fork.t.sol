// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {Batch, IRatings} from "../src/Batch.sol";
import {BatchFactory} from "../src/BatchFactory.sol";
import {InstantVault} from "../src/InstantVault.sol";
import {TokenAdapter} from "../src/TokenAdapter.sol";
import {ICredits} from "../src/interfaces/ICredits.sol";

/// @notice The deployed InstantVault (0x0619…3bEe), as it is on mainnet, attacked and pushed: someone else's
///         approved Credits, the same Credit twice, a union of the other factory, a union that can't take the
///         Credit, a sale that fills the union, a union that never fills (the Safe takes the Credits back and
///         re-deposits them), and the vault's stock against what it is owed at every step.
///         MAINNET_RPC=<url> forge test --match-path test/InstantVaultLive.fork.t.sol
contract InstantVaultLiveForkTest is Test {
    InstantVault constant VAULT = InstantVault(0x0619972F1B63AfC804FE9F66107186F82F943bEe);
    ICredits constant CREDITS = ICredits(0x97630aA70AB14ed9883B41dAfccBc11349723043);
    IERC20 constant BALANCE = IERC20(0x3620540c994433D7B4a628C46d2ED5F92572eA07);
    BatchFactory constant TOKEN_FACTORY = BatchFactory(0x1Ea4b73dE4e946bc58A9A477a7291abe7D7417C1);
    BatchFactory constant MAIN_FACTORY = BatchFactory(0xcb06f9076e5fbF3cB052086b1EE7C0F3836aa051);
    TokenAdapter constant ADAPTER = TokenAdapter(0xe6492DCCB96D1468302843AEc42Bb39f0FD7BD1D);
    address constant STATEMENTS = 0x75Edd94b7e49b3bD5C8047b91F165A5e265a069b;
    address constant STRATEGY = 0x8e607209899b5d12Bd3167a6CD0E8E11FEB053d6;
    address constant POOL_MANAGER = 0x000000000004444c5dc75cB358380D2e3dE08A90;

    Batch mixed;
    address safe;
    address seller = makeAddr("seller");
    address victim = makeAddr("victim");
    address attacker = makeAddr("attacker");
    uint256[] pool; // Credits from the strategy for these tests

    function setUp() public {
        vm.createSelectFork(vm.envOr("MAINNET_RPC", string("https://ethereum-rpc.publicnode.com")));
        safe = VAULT.admin();
        assertEq(safe, TOKEN_FACTORY.feeRecipient());
        address[] memory bs = TOKEN_FACTORY.batches(0, 80);
        for (uint256 i; i < bs.length && address(mixed) == address(0); ++i) {
            Batch b = Batch(bs[i]);
            if (b.state() == Batch.State.Open && b.count() < 80 && b.filter().palettes == 0 && b.allowlistSize() == 0 && b.arrangement() == Batch.Arrangement.Deposit) mixed = b;
        }
        require(address(mixed) != address(0), "no open Mixed union");
        vm.prank(POOL_MANAGER);
        BALANCE.transfer(address(VAULT), 100_000 ether);
        uint256[] memory held = CREDITS.tokensOf(STRATEGY);
        uint256 need = 80 - mixed.count() + 6;
        for (uint256 i; i < held.length && pool.length < need; ++i) pool.push(held[i]);
    }

    function _give(address to, uint256 from, uint256 n) internal returns (uint256[] memory ids) {
        ids = new uint256[](n);
        for (uint256 i; i < n; ++i) {
            ids[i] = pool[from + i];
            vm.prank(STRATEGY);
            CREDITS.transferFrom(STRATEGY, to, ids[i]);
        }
        vm.prank(to);
        CREDITS.setApprovalForAll(address(VAULT), true);
    }

    function test_Live_CantSellSomeoneElsesApprovedCredits() public {
        uint256[] memory theirs = _give(victim, 0, 1); // the victim has approved the vault, as every seller has
        uint256 stock = VAULT.stock();
        vm.prank(attacker);
        vm.expectRevert();
        VAULT.sell(address(mixed), theirs, 0, attacker);
        assertEq(CREDITS.ownerOf(theirs[0]), victim);
        assertEq(VAULT.stock(), stock);
    }

    function test_Live_SameCreditTwice_RevertsWholeSale() public {
        uint256[] memory one = _give(seller, 0, 1);
        uint256[] memory twice = new uint256[](2);
        (twice[0], twice[1]) = (one[0], one[0]);
        uint256 stock = VAULT.stock();
        vm.prank(seller);
        vm.expectRevert();
        VAULT.sell(address(mixed), twice, 0, seller);
        assertEq(CREDITS.ownerOf(one[0]), seller);
        assertEq(VAULT.stock(), stock);
    }

    function test_Live_OtherFactoryUnion_Rejected() public {
        uint256[] memory ids = _give(seller, 0, 1);
        address[] memory bs = MAIN_FACTORY.batches(0, 1);
        vm.prank(seller);
        vm.expectRevert(InstantVault.NotBatch.selector);
        VAULT.sell(bs[0], ids, 0, seller);
    }

    function test_Live_UnionThatCantTakeIt_RevertsNothingPaid() public {
        // A pure-ink union takes only Credits printed in that one ink: find one and a Credit it refuses.
        address[] memory bs = TOKEN_FACTORY.batches(0, 80);
        Batch inkOnly;
        for (uint256 i; i < bs.length && address(inkOnly) == address(0); ++i) {
            Batch b = Batch(bs[i]);
            if (b.state() == Batch.State.Open && b.count() < 80 && b.filter().palettes != 0) inkOnly = b;
        }
        if (address(inkOnly) == address(0)) vm.skip(true);
        uint256 refused;
        for (uint256 i; i < pool.length && refused == 0; ++i) if (!inkOnly.passes(pool[i])) refused = pool[i];
        if (refused == 0) vm.skip(true);
        vm.prank(STRATEGY);
        CREDITS.transferFrom(STRATEGY, seller, refused);
        vm.prank(seller);
        CREDITS.setApprovalForAll(address(VAULT), true);
        uint256[] memory ids = new uint256[](1);
        ids[0] = refused;
        uint256 stock = VAULT.stock();
        vm.prank(seller);
        vm.expectRevert();
        VAULT.sell(address(inkOnly), ids, 0, seller);
        assertEq(CREDITS.ownerOf(refused), seller);
        assertEq(VAULT.stock(), stock);
    }

    function test_Live_SaleThatFillsTheUnion_ConvertsAndRepays() public {
        uint256 room = 80 - mixed.count();
        uint256[] memory ids = _give(seller, 0, room);
        uint256 stockBefore = VAULT.stock();
        // What the vault already put in this union (a real sale went in before this fork).
        (uint256 putBefore,) = ADAPTER.ratingOf(address(mixed), address(VAULT));
        assertEq(putBefore, 0); // not rated yet: ratings are written at the burn
        uint256 paid;
        for (uint256 i; i < room; i += 20) {
            uint256 n = room - i < 20 ? room - i : 20;
            uint256[] memory part = new uint256[](n);
            for (uint256 j; j < n; ++j) part[j] = ids[i + j];
            vm.prank(seller);
            paid += VAULT.sell(address(mixed), part, 0, seller);
        }
        assertEq(mixed.count(), 80);
        // Every Credit the vault ever put in this union, by the table, and what it paid for them (its earlier sale too).
        (uint256[] memory all, address[] memory who) = mixed.slots();
        uint256 vaultTenths;
        for (uint256 i; i < all.length; ++i) if (who[i] == address(VAULT)) vaultTenths += mixed.ratings().scoreOf(all[i]);
        uint256 paidForAll = vaultTenths * 1e17 * (10_000 - mixed.protocolFeeBps() - mixed.creatorFeeBps()) / 10_000;

        ADAPTER.rate(address(mixed));
        if (mixed.phase() == Batch.Phase.Countdown) vm.warp(mixed.lockAt());
        (bool ok, bytes memory opens) = STATEMENTS.staticcall(abi.encodeWithSignature("composeOpensAt()"));
        if (ok && opens.length == 32 && block.timestamp < abi.decode(opens, (uint256))) vm.warp(abi.decode(opens, (uint256)));
        mixed.assemble();
        uint256 owed = ADAPTER.claimable(address(mixed), address(VAULT));
        ADAPTER.claim(address(mixed), address(VAULT));
        assertEq(VAULT.stock(), stockBefore - paid + owed);
        assertGe(owed, paidForAll); // repaid at least what it paid for every Credit it put in
        emit log_named_decimal_uint("paid for all its Credits in the union", paidForAll, 18);
        emit log_named_decimal_uint("repaid", owed, 18);
    }

    function test_Live_UnionNeverFills_SafeMovesTheCreditsToAnother() public {
        // An attacker opens a Mixed union of their own and sells the vault Credits into it, so its stock waits there.
        uint256[] memory opener = _give(attacker, 0, 1);
        vm.startPrank(attacker);
        CREDITS.setApprovalForAll(address(TOKEN_FACTORY), true);
        Batch.Filter memory any;
        address theirs = TOKEN_FACTORY.create("Mine", any, new uint256[](0), 0, Batch.Arrangement.Deposit, Batch.Split.Equal, 14 days, opener, TOKEN_FACTORY.protocolFeeBps(), TOKEN_FACTORY.creatorFeeBps(), TOKEN_FACTORY.ratings());
        vm.stopPrank();
        uint256[] memory ids = _give(attacker, 1, 2);
        vm.prank(attacker);
        uint256 paid = VAULT.sell(theirs, ids, 0, attacker);
        assertGt(paid, 0); // they're paid fairly, as anyone is
        // Nobody but the vault can take its Credits out of that union.
        vm.prank(attacker);
        vm.expectRevert();
        Batch(theirs).withdraw(ids);
        // The Safe takes them back, and into the union filling, where they convert; the Safe is their depositor now.
        vm.prank(safe);
        VAULT.reclaim(theirs, ids);
        assertEq(CREDITS.ownerOf(ids[0]), address(VAULT));
        vm.prank(safe);
        VAULT.sendCredits(safe, ids);
        assertEq(CREDITS.ownerOf(ids[1]), safe);
    }

    function test_Live_OnlyTheSafeAdmins() public {
        uint256[] memory none = new uint256[](0);
        vm.startPrank(attacker);
        vm.expectRevert(InstantVault.NotAdmin.selector);
        VAULT.setPaused(true);
        vm.expectRevert(InstantVault.NotAdmin.selector);
        VAULT.sendToken(BALANCE, attacker, 1);
        vm.expectRevert(InstantVault.NotAdmin.selector);
        VAULT.sendCredits(attacker, none);
        vm.expectRevert(InstantVault.NotAdmin.selector);
        VAULT.reclaim(address(mixed), none);
        vm.stopPrank();
        // The Safe can take everything out.
        uint256 all = VAULT.stock();
        uint256 before = BALANCE.balanceOf(safe);
        vm.prank(safe);
        VAULT.sendToken(BALANCE, safe, all);
        assertEq(BALANCE.balanceOf(safe) - before, all);
        assertEq(VAULT.stock(), 0);
    }

    function test_Live_EthIsRefused() public {
        vm.deal(attacker, 1 ether);
        vm.prank(attacker);
        (bool ok,) = address(VAULT).call{value: 1 ether}("");
        assertFalse(ok);
    }

    function testFuzz_Live_QuoteIsTheUnionsPayout(uint256 seed) public view {
        uint256 id = pool[seed % pool.length];
        uint256[] memory ids = new uint256[](1);
        ids[0] = id;
        uint256 tenths = mixed.ratings().scoreOf(id);
        assertEq(VAULT.quote(address(mixed), ids), tenths * 1e17 * (10_000 - mixed.protocolFeeBps() - mixed.creatorFeeBps()) / 10_000);
    }
}
