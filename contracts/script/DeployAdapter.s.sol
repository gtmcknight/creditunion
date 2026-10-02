// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Script, console2} from "forge-std/Script.sol";
import {ADAPTER_READY, StatementAdapter, IUnions} from "../src/StatementAdapter.sol";
import {ICredits} from "../src/interfaces/ICredits.sol";
import {IStatements} from "../src/interfaces/IStatements.sol";
import {UnionFormats} from "../src/UnionFormats.sol";

/// @notice Deploys the StatementAdapter. It doesn't propose it: the Safe does that right after, with the proposal
///         signed ahead for the deployer's next address (RUNBOOK.md). Refuses mainnet while ADAPTER_READY is false, which it stays until the fork test passes
///         against Jack's deployed, verified contract.
///     STATEMENTS=<Jack's contract> FORMATS=<UnionFormats> forge script script/DeployAdapter.s.sol --rpc-url $MAINNET_RPC --broadcast --verify
contract DeployAdapter is Script {
    ICredits constant CREDITS = ICredits(0x97630aA70AB14ed9883B41dAfccBc11349723043);
    address constant FACTORY = 0xcb06f9076e5fbF3cB052086b1EE7C0F3836aa051;

    function run() external returns (StatementAdapter adapter) {
        require(block.chainid != 1 || ADAPTER_READY, "not ready: pass the fork test against Jack's deployed contract first");
        address jack = vm.envAddress("STATEMENTS");
        require(jack.code.length > 0, "STATEMENTS has no code");
        UnionFormats formats = UnionFormats(vm.envAddress("FORMATS"));
        require(address(formats).code.length > 0 && address(formats.factory()) == FACTORY, "FORMATS isn't UnionFormats for this factory");

        vm.startBroadcast();
        adapter = new StatementAdapter(CREDITS, IStatements(jack), IUnions(FACTORY), formats);
        vm.stopBroadcast();

        // EXPECT=<the address the Safe proposed>: anything else reverts here, before a transaction is sent.
        address expect = vm.envOr("EXPECT", address(0));
        require(expect == address(0) || address(adapter) == expect, "not the address the Safe proposed: nothing sent");
        console2.log("StatementAdapter", address(adapter));
        console2.log("Next (RUNBOOK.md): the Safe executes factory.proposeAssembler(adapter), signed ahead for this address");
    }
}
