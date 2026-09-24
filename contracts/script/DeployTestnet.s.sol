// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Script, console} from "forge-std/Script.sol";
import {BatchFactory} from "../src/BatchFactory.sol";
import {MockAssembler} from "../src/MockAssembler.sol";
import {ICredits} from "../src/interfaces/ICredits.sol";
import {MockCredits} from "../src/mocks/MockCredits.sol";
import {MockStatement} from "../src/mocks/MockStatement.sol";

/// @notice Local/Sepolia: mock Credits + mock Statement + factory. Mints MINT_EACH Credits to each of TESTERS.
/// forge script script/DeployTestnet.s.sol --rpc-url $RPC --broadcast --private-key $PK
contract DeployTestnet is Script {
    function run() external {
        address[] memory testers = vm.envOr("TESTERS", ",", new address[](0));
        uint256 each = vm.envOr("MINT_EACH", uint256(100));
        address feeTo = vm.envOr("FEE_RECIPIENT", msg.sender);

        vm.startBroadcast();
        MockCredits credits = new MockCredits();
        MockStatement statement = new MockStatement(ICredits(address(credits)));
        BatchFactory factory = new BatchFactory(ICredits(address(credits)), new MockAssembler(statement), feeTo, 10);
        credits.mint(msg.sender, each);
        for (uint256 i; i < testers.length; ++i) credits.mint(testers[i], each);
        vm.stopBroadcast();

        console.log("CREDITS", address(credits));
        console.log("STATEMENT", address(statement));
        console.log("FACTORY", address(factory));
    }
}
