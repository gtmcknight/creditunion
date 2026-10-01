// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Script, console2} from "forge-std/Script.sol";
import {UnionFormats, IUnionFactory} from "../src/UnionFormats.sol";

/// @notice Deploys UnionFormats, where each union's creator picks its Statement format. Deploy it before the adapter:
///         the adapter reads it at burn time.
///     forge script script/DeployUnionFormats.s.sol --rpc-url $MAINNET_RPC --account deployer --sender <deployer> --broadcast --verify
contract DeployUnionFormats is Script {
    address constant FACTORY = 0xcb06f9076e5fbF3cB052086b1EE7C0F3836aa051;

    function run() external returns (UnionFormats formats) {
        require(FACTORY.code.length > 0, "no factory on this chain");
        vm.startBroadcast();
        formats = new UnionFormats(IUnionFactory(FACTORY));
        vm.stopBroadcast();
        console2.log("UnionFormats", address(formats));
    }
}
