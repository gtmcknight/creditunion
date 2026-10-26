// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Script, console2} from "forge-std/Script.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {BarRouter, IPoolManager} from "../src/BarRouter.sol";
import {IBars} from "../src/interfaces/IBars.sol";
import {ISeaport} from "../src/interfaces/ISeaport.sol";
import {StandInBars} from "../src/mocks/StandInBars.sol";

/// @notice BarRouter against a Bars edition: BARS names the real one; without it (local copies of mainnet only) a
///         stand-in edition opens for WINDOW_HOURS (24) from now, priced by count when STEP (wei per number) is set.
///         FEE_RECIPIENT takes the router's fee, FEE_BPS (100).
///     FEE_RECIPIENT=… BARS=… forge script script/DeployBars.s.sol --rpc-url $MAINNET_RPC --account deployer --broadcast
contract DeployBars is Script {
    IERC20 constant BALANCE = IERC20(0x3620540c994433D7B4a628C46d2ED5F92572eA07);
    IPoolManager constant POOL_MANAGER = IPoolManager(0x000000000004444c5dc75cB358380D2e3dE08A90);
    ISeaport constant SEAPORT = ISeaport(0x0000000000000068F116a894984e2DB1123eB395);
    address constant LBP_HOOK = 0x2EEF0e2a9a652d755AccAD95a24541A98B5CA000;

    function run() external {
        address bars = vm.envOr("BARS", address(0));
        vm.startBroadcast();
        if (bars == address(0)) {
            require(block.chainid == 1 && vm.envOr("FORK", false), "BARS, or FORK=true on a local copy");
            uint64 start = uint64(block.timestamp);
            bars = address(new StandInBars(BALANCE, start, start + uint64(vm.envOr("WINDOW_HOURS", uint256(24)) * 1 hours), vm.envOr("STEP", uint256(0))));
        }
        BarRouter router = new BarRouter(
            IBars(bars), BALANCE, POOL_MANAGER, SEAPORT, vm.envAddress("FEE_RECIPIENT"), vm.envOr("FEE_BPS", uint256(100)), 3000, 30, LBP_HOOK
        );
        vm.stopBroadcast();
        console2.log("BARS_EDITION", bars);
        console2.log("BAR_ROUTER", address(router));
    }
}
