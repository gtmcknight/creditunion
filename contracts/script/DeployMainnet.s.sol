// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Script, console} from "forge-std/Script.sol";
import {BatchFactory} from "../src/BatchFactory.sol";
import {IAssembler} from "../src/interfaces/IAssembler.sol";
import {ICredits} from "../src/interfaces/ICredits.sol";

/// @notice Mainnet. Blocked until Jack's Statement contract is published and an audited
///         assembler for it is deployed (ASSEMBLER). Everything below is immutable once deployed.
contract DeployMainnet is Script {
    ICredits constant CREDITS = ICredits(0x97630aA70AB14ed9883B41dAfccBc11349723043);

    function run() external {
        IAssembler assembler = IAssembler(vm.envAddress("ASSEMBLER"));
        address feeTo = vm.envAddress("FEE_RECIPIENT");
        require(address(assembler).code.length > 0, "assembler not deployed");
        require(CREDITS.isSealed(), "credits not sealed");

        vm.startBroadcast();
        BatchFactory factory = new BatchFactory(CREDITS, assembler, feeTo, 10);
        vm.stopBroadcast();
        console.log("FACTORY", address(factory));
    }
}
