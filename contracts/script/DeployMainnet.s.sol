// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Script, console} from "forge-std/Script.sol";
import {BatchFactory} from "../src/BatchFactory.sol";
import {Sweeper} from "../src/Sweeper.sol";
import {ISeaport} from "../src/interfaces/ISeaport.sol";
import {IAssembler} from "../src/interfaces/IAssembler.sol";
import {ICredits} from "../src/interfaces/ICredits.sol";

/// @notice Mainnet. PROTOCOL_FEE_BPS (auction, default 100) and SWEEP_FEE_BPS (OpenSea buys, default 100),
///         each capped at 500 in the contracts. Blocked until Jack's Statement contract is published and an audited
///         assembler for it is deployed (ASSEMBLER). Everything below is immutable once deployed.
contract DeployMainnet is Script {
    ICredits constant CREDITS = ICredits(0x97630aA70AB14ed9883B41dAfccBc11349723043);
    ISeaport constant SEAPORT = ISeaport(0x0000000000000068F116a894984e2DB1123eB395); // Seaport 1.6

    function run() external {
        IAssembler assembler = IAssembler(vm.envAddress("ASSEMBLER"));
        address feeTo = vm.envAddress("FEE_RECIPIENT");
        require(address(assembler).code.length > 0, "assembler not deployed");
        require(CREDITS.isSealed(), "credits not sealed");

        vm.startBroadcast();
        BatchFactory factory = new BatchFactory(CREDITS, assembler, feeTo, vm.envOr("PROTOCOL_FEE_BPS", uint256(100)), 10);
        Sweeper sweeper = new Sweeper(SEAPORT, factory, vm.envOr("SWEEP_FEE_BPS", uint256(100)));
        vm.stopBroadcast();
        console.log("FACTORY", address(factory));
        console.log("SWEEPER", address(sweeper));
    }
}
