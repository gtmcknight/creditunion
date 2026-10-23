// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {Batch} from "../src/Batch.sol";
import {BatchFactory} from "../src/BatchFactory.sol";
import {InstantVault} from "../src/InstantVault.sol";
import {TokenAdapter} from "../src/TokenAdapter.sol";
import {ICredits} from "../src/interfaces/ICredits.sol";

/// @notice Against mainnet, the live system end to end: a vault on the live token factory, funded with real BALANCE,
///         buys real Credits into the live Mixed union filling now, the union fills, converts through the live
///         TokenAdapter and Jack's contract, and pays the vault back. The vault must get back at least what it paid.
///         MAINNET_RPC=<url> forge test --match-path test/InstantVault.fork.t.sol
contract InstantVaultForkTest is Test {
    ICredits constant CREDITS = ICredits(0x97630aA70AB14ed9883B41dAfccBc11349723043);
    IERC20 constant BALANCE = IERC20(0x3620540c994433D7B4a628C46d2ED5F92572eA07);
    BatchFactory constant TOKEN_FACTORY = BatchFactory(0x1Ea4b73dE4e946bc58A9A477a7291abe7D7417C1);
    TokenAdapter constant ADAPTER = TokenAdapter(0xe6492DCCB96D1468302843AEc42Bb39f0FD7BD1D);
    address constant STATEMENTS = 0x75Edd94b7e49b3bD5C8047b91F165A5e265a069b;
    /// Where the test's Credits come from: CreditStrategy holds thousands.
    address constant STRATEGY = 0x8e607209899b5d12Bd3167a6CD0E8E11FEB053d6;
    /// Where the test's BALANCE comes from: Uniswap v4's PoolManager holds the pool's (a deal() breaks the token's
    /// per-wallet ink, so it's moved from a real holder).
    address constant POOL_MANAGER = 0x000000000004444c5dc75cB358380D2e3dE08A90;

    InstantVault vault;
    Batch batch;
    address safe;
    address seller = makeAddr("seller");
    uint256[] stash; // Credits handed to the seller

    function setUp() public {
        vm.createSelectFork(vm.envOr("MAINNET_RPC", string("https://ethereum-rpc.publicnode.com")));
        vault = new InstantVault(TOKEN_FACTORY, BALANCE);
        safe = TOKEN_FACTORY.feeRecipient();
        // The open Mixed union with room: any Credit, no allowlist, deposit order.
        address[] memory bs = TOKEN_FACTORY.batches(0, 60);
        for (uint256 i; i < bs.length && address(batch) == address(0); ++i) {
            Batch b = Batch(bs[i]);
            if (b.state() == Batch.State.Open && b.count() < 80 && b.filter().palettes == 0 && b.allowlistSize() == 0 && b.arrangement() == Batch.Arrangement.Deposit) batch = b;
        }
        require(address(batch) != address(0), "no open Mixed union");
        vm.prank(POOL_MANAGER);
        BALANCE.transfer(address(vault), 100_000 ether);
        // Enough Credits to fill the union, each one the strategy holds.
        uint256[] memory held = CREDITS.tokensOf(STRATEGY);
        uint256 need = 80 - batch.count();
        for (uint256 i; i < held.length && stash.length < need; ++i) {
            vm.prank(STRATEGY);
            CREDITS.transferFrom(STRATEGY, seller, held[i]);
            stash.push(held[i]);
        }
        vm.prank(seller);
        CREDITS.setApprovalForAll(address(vault), true);
    }

    function _ids(uint256 from, uint256 n) internal view returns (uint256[] memory ids) {
        ids = new uint256[](n);
        for (uint256 i; i < n; ++i) ids[i] = stash[from + i];
    }

    function test_Fork_SellPaysNow_DepositsInTheVaultsName() public {
        uint256[] memory ids = _ids(0, 3);
        uint256 q = vault.quote(address(batch), ids);
        uint256 before = BALANCE.balanceOf(seller);
        uint256 count = batch.count();

        vm.prank(seller);
        uint256 paid = vault.sell(address(batch), ids, q, seller);

        assertEq(paid, q);
        assertGt(q, 0);
        assertEq(BALANCE.balanceOf(seller) - before, q);
        assertEq(batch.count(), count + 3);
        for (uint256 i; i < 3; ++i) {
            assertEq(batch.depositorOf(ids[i]), address(vault));
            assertEq(CREDITS.ownerOf(ids[i]), address(batch));
        }
        // What it pays is the union's own payout: the table's rating less its fee (6% on token unions).
        uint256 tenths;
        for (uint256 i; i < 3; ++i) tenths += batch.ratings().scoreOf(ids[i]);
        assertEq(q, tenths * 1e17 * (10_000 - batch.protocolFeeBps() - batch.creatorFeeBps()) / 10_000);
    }

    function test_Fork_FullCycle_VaultRepaidAtLeastWhatItPaid() public {
        uint256 start = BALANCE.balanceOf(address(vault));
        uint256 paid;
        for (uint256 i; i < stash.length; i += 20) {
            uint256 n = stash.length - i < 20 ? stash.length - i : 20;
            vm.prank(seller);
            paid += vault.sell(address(batch), _ids(i, n), 0, seller);
        }
        assertEq(batch.count(), 80);
        assertEq(BALANCE.balanceOf(address(vault)), start - paid);

        // Converts as the keeper does it: rate, the burn (lock delay 0 on token unions, Jack's compose window), pay out.
        ADAPTER.rate(address(batch));
        if (batch.phase() == Batch.Phase.Countdown) vm.warp(batch.lockAt());
        (bool ok, bytes memory opens) = STATEMENTS.staticcall(abi.encodeWithSignature("composeOpensAt()"));
        if (ok && opens.length == 32 && block.timestamp < abi.decode(opens, (uint256))) vm.warp(abi.decode(opens, (uint256)));
        batch.assemble();
        uint256 owed = ADAPTER.claimable(address(batch), address(vault));
        ADAPTER.claim(address(batch), address(vault));

        uint256 back = BALANCE.balanceOf(address(vault)) - (start - paid);
        emit log_named_decimal_uint("vault paid sellers", paid, 18);
        emit log_named_decimal_uint("vault paid back", back, 18);
        assertEq(back, owed);
        assertGe(back, paid); // Jack's score converts a hair above the table's: never short
    }

    function test_Fork_ShortOfStock_Reverts() public {
        uint256 all = BALANCE.balanceOf(address(vault));
        vm.prank(safe);
        vault.sendToken(BALANCE, safe, all);
        uint256[] memory ids = _ids(0, 1);
        vm.prank(seller);
        vm.expectRevert();
        vault.sell(address(batch), ids, 0, seller);
        assertEq(CREDITS.ownerOf(ids[0]), seller); // nothing moved
    }

    function test_Fork_Paused_And_AdminOnly() public {
        vm.expectRevert(InstantVault.NotAdmin.selector);
        vault.setPaused(true);
        vm.prank(safe);
        vault.setPaused(true);
        uint256[] memory ids = _ids(0, 1);
        vm.prank(seller);
        vm.expectRevert(InstantVault.IsPaused.selector);
        vault.sell(address(batch), ids, 0, seller);
    }

    function test_Fork_MinOut_Holds() public {
        uint256[] memory ids = _ids(0, 2);
        uint256 q = vault.quote(address(batch), ids);
        vm.prank(seller);
        vm.expectRevert(abi.encodeWithSelector(InstantVault.TooLittle.selector, q));
        vault.sell(address(batch), ids, q + 1, seller);
    }

    function test_Fork_Reclaim_BringsCreditsBack() public {
        uint256[] memory ids = _ids(0, 2);
        vm.prank(seller);
        vault.sell(address(batch), ids, 0, seller);
        vm.prank(safe);
        vault.reclaim(address(batch), ids);
        assertEq(CREDITS.ownerOf(ids[0]), address(vault));
        vm.prank(safe);
        vault.sendCredits(safe, ids);
        assertEq(CREDITS.ownerOf(ids[1]), safe);
    }

    function test_Fork_NotATokenUnion_Reverts() public {
        uint256[] memory ids = _ids(0, 1);
        vm.prank(seller);
        vm.expectRevert(InstantVault.NotBatch.selector);
        vault.sell(address(0xBEEF), ids, 0, seller);
    }
}
