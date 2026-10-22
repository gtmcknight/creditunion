// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Script, console2} from "forge-std/Script.sol";
import {BatchFactory} from "../src/BatchFactory.sol";
import {Sweeper} from "../src/Sweeper.sol";
import {ICCController, ICCCore} from "../src/interfaces/ICCController.sol";
import {ICreditStrategy} from "../src/interfaces/ICreditStrategy.sol";
import {IFWAMarket} from "../src/interfaces/IFWAMarket.sol";
import {ISeaport} from "../src/interfaces/ISeaport.sol";

/// @notice New Sweepers for both live factories with the $CC engine's pile as a fourth source beside Seaport, FWA and
///         CreditStrategy (sweepEvery into a batch, buyEvery to a wallet): one for the first factory (picture unions,
///         and every buy to a wallet on the site), one for the token factory (the $BALANCE batches). Nothing else
///         changes: each factory's depositFor takes any caller's Credits, and the old Sweepers (no owner, no admin)
///         just stop being used once the site points at these.
///     forge script script/DeploySweepers.s.sol --rpc-url $MAINNET_RPC --account deployer --broadcast
///   SWEEP_FEE_BPS 200 for both (the live ones'), each fee to its factory's fee recipient, as before.
///   Then in web/wrangler.jsonc: SWEEPER and TOKEN_SWEEPER = the printed addresses, CC_CORE set. Each buy asks $CC's
///   Core for its controller then, so a controller swap on their side needs nothing here.
contract DeploySweepers is Script {
    BatchFactory constant FACTORY = BatchFactory(0xcb06f9076e5fbF3cB052086b1EE7C0F3836aa051);
    BatchFactory constant TOKEN_FACTORY = BatchFactory(0x1Ea4b73dE4e946bc58A9A477a7291abe7D7417C1);
    ISeaport constant SEAPORT = ISeaport(0x0000000000000068F116a894984e2DB1123eB395);
    ICreditStrategy constant CREDIT_STRATEGY = ICreditStrategy(0x8e607209899b5d12Bd3167a6CD0E8E11FEB053d6);
    IFWAMarket constant FWA_MARKET = IFWAMarket(0x2b019Cfb591988D28C64C4f4be6a24b1592BBF25);
    ICCCore constant CC = ICCCore(0xcdb1889ae12074d750CD9B8531B692015465e0dD);

    function run() external {
        uint256 fee = vm.envOr("SWEEP_FEE_BPS", uint256(200));
        vm.startBroadcast();
        Sweeper sweeper = new Sweeper(SEAPORT, FACTORY, fee, FWA_MARKET, CREDIT_STRATEGY, CC);
        Sweeper tokenSweeper = new Sweeper(SEAPORT, TOKEN_FACTORY, fee, FWA_MARKET, CREDIT_STRATEGY, CC);
        vm.stopBroadcast();
        console2.log("SWEEPER", address(sweeper));
        console2.log("TOKEN_SWEEPER", address(tokenSweeper));
        console2.log("fee bps", fee);
        console2.log("fee recipients", sweeper.feeRecipient(), tokenSweeper.feeRecipient());
    }
}
