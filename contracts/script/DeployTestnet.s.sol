// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Script, console} from "forge-std/Script.sol";
import {BatchFactory} from "../src/BatchFactory.sol";
import {IRatings} from "../src/Batch.sol";
import {Ratings} from "../src/Ratings.sol";
import {RatingsDeploy} from "./DeployRatings.s.sol";
import {MockAssembler} from "../src/MockAssembler.sol";
import {Sweeper} from "../src/Sweeper.sol";
import {IAssembler} from "../src/interfaces/IAssembler.sol";
import {ICredits} from "../src/interfaces/ICredits.sol";
import {ISeaport} from "../src/interfaces/ISeaport.sol";
import {MockStatement} from "../src/mocks/MockStatement.sol";
import {TestCredits} from "../src/mocks/TestCredits.sol";

/// @notice Sepolia: TestCredits (real Credits art, anyone can mint) + mock Statement + factory + Sweeper.
/// forge script script/DeployTestnet.s.sol --rpc-url $RPC --broadcast --private-key $PK
contract DeployTestnet is Script {
    function run() external {
        address feeTo = vm.envOr("FEE_RECIPIENT", msg.sender);

        vm.startBroadcast();
        // The frozen mainnet score table, deployed here too so rating rules can be tried on test Credits
        // (test ids line up with mainnet ids; the scores are the real ones for those numbers).
        Ratings ratings = RatingsDeploy.deploy(vm.readFileBinary("data/scores.bin"));
        TestCredits credits = new TestCredits();
        MockStatement statement = new MockStatement(ICredits(address(credits)));
        // STAGED=1 mirrors the mainnet launch: no assembler at deploy, the deployer proposes it later.
        MockAssembler asm = new MockAssembler(statement);
        bool staged = vm.envOr("STAGED", false);
        BatchFactory factory = new BatchFactory(ICredits(address(credits)), IRatings(address(ratings)), staged ? IAssembler(address(0)) : asm, staged ? msg.sender : address(0), feeTo, 200, 0, 1
        );
        // Seaport 1.6 has the same address on Sepolia; buy-in only matters where OpenSea lists these.
        Sweeper sweeper = new Sweeper(ISeaport(0x0000000000000068F116a894984e2DB1123eB395), factory, 200);
        vm.stopBroadcast();

        console.log("CREDITS", address(credits));
        console.log("STATEMENT", address(statement));
        console.log("FACTORY", address(factory));
        console.log("SWEEPER", address(sweeper));
        console.log("ASSEMBLER", address(asm));
        console.log("RATINGS", address(ratings));
    }
}
