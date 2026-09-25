// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Script, console} from "forge-std/Script.sol";
import {DataStore, Ratings} from "../src/Ratings.sol";

/// @notice Deploys the frozen score table from data/scores.bin (uint16 LE, score×10 per id).
///   forge script script/DeployRatings.s.sol --rpc-url $RPC --private-key $PK --broadcast --slow
library RatingsDeploy {
    function deploy(bytes memory data) internal returns (Ratings r) {
        uint256 count = data.length / 2;
        uint256 per = 12_000 * 2;
        uint256 n = (data.length + per - 1) / per;
        address[] memory chunks = new address[](n);
        for (uint256 i; i < n; ++i) {
            uint256 start = i * per;
            uint256 len = data.length - start < per ? data.length - start : per;
            bytes memory part = new bytes(len);
            for (uint256 j; j < len; ++j) part[j] = data[start + j];
            chunks[i] = DataStore.write(part);
        }
        r = new Ratings(chunks, count);
    }
}

contract DeployRatings is Script {
    function run() external {
        bytes memory data = vm.readFileBinary("data/scores.bin");
        vm.startBroadcast();
        Ratings r = RatingsDeploy.deploy(data);
        vm.stopBroadcast();
        console.log("RATINGS", address(r));
        console.log("count", r.count());
    }
}
