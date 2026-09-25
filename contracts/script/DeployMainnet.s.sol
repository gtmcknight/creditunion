// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Script, console} from "forge-std/Script.sol";
import {BatchFactory} from "../src/BatchFactory.sol";
import {Sweeper} from "../src/Sweeper.sol";
import {IAssembler} from "../src/interfaces/IAssembler.sol";
import {ICredits} from "../src/interfaces/ICredits.sol";
import {ISeaport} from "../src/interfaces/ISeaport.sol";

/// @notice Mainnet, in two stages.
///
///   Stage 1 (pooling): ASSEMBLER unset. SETTER (a multisig, ideally) is the one address that can later
///   propose the adapter. FEE_RECIPIENT required. PROTOCOL_FEE_BPS / SWEEP_FEE_BPS default 100 (1%),
///   capped at 500 in the contracts.
///     FEE_RECIPIENT=… SETTER=… forge script script/DeployMainnet.s.sol --broadcast
///
///   Stage 2 (after Jack's Statement contract ships and the adapter is reviewed): from the setter,
///     cast send $FACTORY "proposeAssembler(address)" $ASSEMBLER      // opens the 3-day exit window
///     cast send $FACTORY "activateAssembler()"                        // anyone, 3 days later
///
///   Or, if the adapter already exists at deploy, set ASSEMBLER and it is active from the start.
contract DeployMainnet is Script {
    ICredits constant CREDITS = ICredits(0x97630aA70AB14ed9883B41dAfccBc11349723043);
    ISeaport constant SEAPORT = ISeaport(0x0000000000000068F116a894984e2DB1123eB395); // Seaport 1.6

    function run() external {
        IAssembler assembler = IAssembler(vm.envOr("ASSEMBLER", address(0)));
        address setter = vm.envOr("SETTER", address(0));
        address feeTo = vm.envAddress("FEE_RECIPIENT");
        require(address(assembler) != address(0) || setter != address(0), "need ASSEMBLER or SETTER");
        if (address(assembler) != address(0)) require(address(assembler).code.length > 0, "assembler not deployed");
        require(CREDITS.isSealed(), "credits not sealed");

        vm.startBroadcast();
        BatchFactory factory = new BatchFactory(
            CREDITS, assembler, setter, feeTo, vm.envOr("PROTOCOL_FEE_BPS", uint256(100)), 1
        );
        Sweeper sweeper = new Sweeper(SEAPORT, factory, vm.envOr("SWEEP_FEE_BPS", uint256(100)));
        vm.stopBroadcast();
        console.log("FACTORY", address(factory));
        console.log("SWEEPER", address(sweeper));
    }
}
