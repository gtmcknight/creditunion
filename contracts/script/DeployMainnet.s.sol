// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Script, console} from "forge-std/Script.sol";
import {BatchFactory} from "../src/BatchFactory.sol";
import {IRatings} from "../src/Batch.sol";
import {Ratings} from "../src/Ratings.sol";
import {RatingsDeploy} from "./DeployRatings.s.sol";
import {Sweeper} from "../src/Sweeper.sol";
import {IAssembler} from "../src/interfaces/IAssembler.sol";
import {ICredits} from "../src/interfaces/ICredits.sol";
import {ISeaport} from "../src/interfaces/ISeaport.sol";

/// @notice Mainnet, in two stages.
///
///   Stage 1 (pooling): ASSEMBLER unset. SETTER (a multisig, ideally) is the one address that can later
///   propose the adapter. FEE_RECIPIENT required. PROTOCOL_FEE_BPS / SWEEP_FEE_BPS default 200 (2%),
///   CREATOR_FEE_BPS default 0; capped at 500 / 500 / 1000. The fee recipient can change them later
///   (within the caps) for batches opened afterwards.
///     FEE_RECIPIENT=… SETTER=… forge script script/DeployMainnet.s.sol --broadcast
///
///   Stage 2 (after Jack's Statement contract ships and the adapter is reviewed): from the setter,
///     cast send $FACTORY "proposeAssembler(address)" $ASSEMBLER      // starts the 30-minute notice (nothing is locked before activation)
///     cast send $FACTORY "activateAssembler()"                        // anyone, 30 minutes later
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
        // RATINGS: an already deployed score table (DeployRatings), or deploy it here (~55M gas over 12 txs).
        address ratingsAddr = vm.envOr("RATINGS", address(0));
        if (ratingsAddr == address(0)) ratingsAddr = address(RatingsDeploy.deploy(vm.readFileBinary("data/scores.bin")));
        BatchFactory factory = new BatchFactory(
            CREDITS, IRatings(ratingsAddr), assembler, setter, feeTo, vm.envOr("PROTOCOL_FEE_BPS", uint256(200)), vm.envOr("CREATOR_FEE_BPS", uint256(0)), 1
        );
        Sweeper sweeper = new Sweeper(SEAPORT, factory, vm.envOr("SWEEP_FEE_BPS", uint256(200)));
        vm.stopBroadcast();
        console.log("RATINGS", ratingsAddr);
        console.log("FACTORY", address(factory));
        console.log("SWEEPER", address(sweeper));
    }
}
