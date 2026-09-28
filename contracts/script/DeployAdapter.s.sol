// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Script, console2} from "forge-std/Script.sol";
import {ADAPTER_READY, StatementAdapter, IUnions} from "../src/StatementAdapter.sol";
import {ICredits} from "../src/interfaces/ICredits.sol";
import {IStatements} from "../src/interfaces/IStatements.sol";

/// @notice Deploys the StatementAdapter. It doesn't propose it: the Safe does that at 7:30pm ET on burn day
///         (RUNBOOK.md). Refuses mainnet while ADAPTER_READY is false, which it stays until `_compose` is
///         written against Jack's published contract and the fork test passes against it.
///     STATEMENTS=<Jack's contract> forge script script/DeployAdapter.s.sol --rpc-url $MAINNET_RPC --broadcast --verify
contract DeployAdapter is Script {
    ICredits constant CREDITS = ICredits(0x97630aA70AB14ed9883B41dAfccBc11349723043);
    address constant FACTORY = 0xcb06f9076e5fbF3cB052086b1EE7C0F3836aa051;

    function run() external returns (StatementAdapter adapter) {
        require(block.chainid != 1 || ADAPTER_READY, "draft adapter: finish _compose and the fork test first");
        address jack = vm.envAddress("STATEMENTS");
        require(jack.code.length > 0, "STATEMENTS has no code");

        vm.startBroadcast();
        adapter = new StatementAdapter(CREDITS, IStatements(jack), IUnions(FACTORY));
        vm.stopBroadcast();

        console2.log("StatementAdapter", address(adapter));
        console2.log("Next (RUNBOOK.md): verify it, publish the address, then at 7:30pm ET the Safe calls");
        console2.log("  factory.proposeAssembler(adapter)");
    }
}
