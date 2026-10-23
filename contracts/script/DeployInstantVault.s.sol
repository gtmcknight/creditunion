// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Script, console2} from "forge-std/Script.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {BatchFactory} from "../src/BatchFactory.sol";
import {InstantVault} from "../src/InstantVault.sol";

/// @notice The InstantVault on the live token factory (the $BALANCE batches), paying in $BALANCE. Its admin is the
///         factory's fee recipient (the Safe), read at deploy. It starts empty: send it $BALANCE to open sales.
///     forge script script/DeployInstantVault.s.sol --rpc-url $MAINNET_RPC --account deployer --sender <deployer> --broadcast --verify
///   Then in web/wrangler.jsonc: INSTANT_VAULT = the printed address.
contract DeployInstantVault is Script {
    BatchFactory constant TOKEN_FACTORY = BatchFactory(0x1Ea4b73dE4e946bc58A9A477a7291abe7D7417C1);
    IERC20 constant BALANCE = IERC20(0x3620540c994433D7B4a628C46d2ED5F92572eA07);

    function run() external {
        vm.startBroadcast();
        InstantVault vault = new InstantVault(TOKEN_FACTORY, BALANCE);
        vm.stopBroadcast();
        console2.log("INSTANT_VAULT", address(vault));
        console2.log("admin", vault.admin());
    }
}
