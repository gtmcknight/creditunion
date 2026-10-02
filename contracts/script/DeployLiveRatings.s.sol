// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Script, console2} from "forge-std/Script.sol";
import {LiveRatings, ICreditScore} from "../src/LiveRatings.sol";
import {ICredits} from "../src/interfaces/ICredits.sol";

interface IStatementsScore {
    function score() external view returns (address);
}

/// @notice Deploys LiveRatings over the Statements contract's scorer. Then the Safe calls factory.proposeRatings(it);
///         30 minutes later anyone calls activateRatings(), and batches opened after that check rating rules against it.
///     forge script script/DeployLiveRatings.s.sol --rpc-url $MAINNET_RPC --account deployer --sender <deployer> --broadcast --verify
contract DeployLiveRatings is Script {
    address constant CREDITS = 0x97630aA70AB14ed9883B41dAfccBc11349723043;
    address constant STATEMENTS = 0x75Edd94b7e49b3bD5C8047b91F165A5e265a069b;
    uint256 constant COUNT = 122_154;

    function run() external returns (LiveRatings r) {
        address scorer = IStatementsScore(STATEMENTS).score();
        require(scorer.code.length > 0, "no scorer on this chain");
        vm.startBroadcast();
        r = new LiveRatings(ICredits(CREDITS), ICreditScore(scorer), COUNT);
        vm.stopBroadcast();
        require(r.scoreOf(9) == 7970 && r.scoreOf(1) == 1324, "unexpected scores");
        console2.log("LiveRatings", address(r));
    }
}
