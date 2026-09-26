// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Script, console} from "forge-std/Script.sol";
import {BatchFactory} from "../src/BatchFactory.sol";
import {IRatings} from "../src/Batch.sol";
import {IAssembler} from "../src/interfaces/IAssembler.sol";
import {ICredits} from "../src/interfaces/ICredits.sol";

/// @notice Sepolia: a new factory (and so a new Batch implementation) over the existing test Credits and Ratings,
///         so everyone's minted test Credits carry over. Staged like mainnet: no assembler, the setter proposes it.
/// CREDITS=0x… RATINGS=0x… [SETTER=0x…] [FEE_RECIPIENT=0x…] \
///   forge script script/DeployFactory.s.sol --rpc-url $RPC --broadcast --private-key $PK
contract DeployFactory is Script {
    function run() external {
        address credits = vm.envAddress("CREDITS");
        address ratings = vm.envAddress("RATINGS");
        address setter = vm.envOr("SETTER", msg.sender);
        address feeTo = vm.envOr("FEE_RECIPIENT", msg.sender);

        vm.startBroadcast();
        BatchFactory factory = new BatchFactory(ICredits(credits), IRatings(ratings), IAssembler(address(0)), setter, feeTo, 200, 0, 1);
        vm.stopBroadcast();

        console.log("FACTORY", address(factory));
        console.log("SETTER", setter);
        console.log("FEE_RECIPIENT", feeTo);
    }
}
