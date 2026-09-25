// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Script, console} from "forge-std/Script.sol";
import {Batch} from "../src/Batch.sol";
import {BatchFactory} from "../src/BatchFactory.sol";
import {MockAssembler} from "../src/MockAssembler.sol";
import {ICredits} from "../src/interfaces/ICredits.sol";
import {MockCredits} from "../src/mocks/MockCredits.sol";
import {MockStatement} from "../src/mocks/MockStatement.sol";

/// @notice Local anvil only: deploys mocks and leaves batches in every state for UI work.
contract SeedDemo is Script {
    // anvil default keys 0..4
    uint256[5] keys = [
        0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80,
        0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d,
        0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a,
        0x7c852118294e51e653712a81e05800f419141751be58f605c371e15141b007a6,
        0x47e179ec197488593b187f80a00eb0da91f1b9d0b13f8733639f19c30a34926a
    ];

    function run() external {
        address[5] memory who;
        for (uint256 i; i < 5; ++i) who[i] = vm.addr(keys[i]);

        vm.startBroadcast(keys[0]);
        MockCredits credits = new MockCredits();
        MockStatement statement = new MockStatement(ICredits(address(credits)));
        BatchFactory f = new BatchFactory(ICredits(address(credits)), new MockAssembler(statement), address(0), who[0], 100, 1);
        for (uint256 i; i < 4; ++i) credits.mint(who[i], 200); // ids 1..800
        vm.stopBroadcast();

        for (uint256 i; i < 4; ++i) {
            vm.broadcast(keys[i]);
            credits.setApprovalForAll(address(f), true);
        }
        Batch.Filter memory none;

        // 1. Settled: 80 → burned → sold
        address b1 = _open(f, keys[0], "First Light", none, 0.5 ether, _r(1, 40));
        _dep(f, keys[1], b1, _r(201, 40));
        vm.broadcast(keys[2]);
        Batch(b1).assemble();
        vm.broadcast(keys[4]);
        Batch(b1).bid{value: 3.2 ether}();
        console.log("CREDITS", address(credits));
        console.log("FACTORY", address(f));
        console.log("SETTLE_ME", b1);
    }

    /// @dev Run after advancing time 1 day and settling SETTLE_ME.
    function later(BatchFactory f) external {
        Batch.Filter memory none;
        Batch.Filter memory cyan;
        cyan.colors = keccak256("CMY");

        // 2. Auction running with bids
        address b2 = _open(f, keys[1], "Registered", none, 0, 250, _r(241, 30));
        _dep(f, keys[2], b2, _r(401, 30));
        _dep(f, keys[3], b2, _r(601, 20));
        vm.broadcast(keys[3]);
        Batch(b2).assemble();
        vm.broadcast(keys[4]);
        Batch(b2).bid{value: 2.4 ether}();
        vm.broadcast(keys[0]);
        Batch(b2).bid{value: 2.75 ether}();

        // 3. Full, ready to burn
        address b3 = _open(f, keys[2], "Eighty Eights", none, 1 ether, _r(431, 40));
        _dep(f, keys[3], b3, _r(621, 40));

        // 4. Open, mostly filled, filtered (even ids only in the mock art)
        uint256[] memory evens = new uint256[](26);
        for (uint256 i; i < 26; ++i) evens[i] = 42 + 2 * i;
        address b4 = _open(f, keys[0], "All Cyan", cyan, 0, 500, evens);
        uint256[] memory evens2 = new uint256[](38);
        for (uint256 i; i < 38; ++i) evens2[i] = 272 + 2 * i;
        _dep(f, keys[1], b4, evens2);

        // 5. Open, just started
        _open(f, keys[3], "Slow Burn", none, 0, _r(661, 12));

        // 6. Full, Creator's order, unburned: the creator (key 0) sees the arranger
        vm.broadcast(keys[0]);
        address b6 = f.create("Hand Arranged", none, new uint256[](0), 0, 0, Batch.Arrangement.Creator, 30 days, _r(101, 40));
        _dep(f, keys[2], b6, _r(481, 40));
        console.log("ARRANGE_ME", b6);

        // 7. Open, time window + number range: the eligibility line on cards
        Batch.Filter memory win;
        win.paidFrom = 700;
        win.paidTo = 760;
        win.idFrom = 700;
        vm.broadcast(keys[3]);
        f.create("Minute Seven", win, new uint256[](0), 0, 0, Batch.Arrangement.MintTime, 30 days, _r(701, 12));
    }

    function _open(BatchFactory f, uint256 k, string memory n, Batch.Filter memory fl, uint256 res, uint256[] memory ids)
        internal
        returns (address b)
    {
        b = _open(f, k, n, fl, res, 0, ids);
    }

    function _open(
        BatchFactory f,
        uint256 k,
        string memory n,
        Batch.Filter memory fl,
        uint256 res,
        uint256 creatorFee,
        uint256[] memory ids
    ) internal returns (address b) {
        vm.broadcast(k);
        b = f.create(n, fl, new uint256[](0), res, creatorFee, Batch.Arrangement.Deposit, 30 days, ids);
    }

    function _dep(BatchFactory f, uint256 k, address b, uint256[] memory ids) internal {
        vm.broadcast(k);
        f.deposit(b, ids);
    }

    function _r(uint256 from, uint256 n) internal pure returns (uint256[] memory a) {
        a = new uint256[](n);
        for (uint256 i; i < n; ++i) a[i] = from + i;
    }
}
