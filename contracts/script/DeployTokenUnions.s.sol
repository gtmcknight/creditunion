// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Script, console2} from "forge-std/Script.sol";
import {IERC721} from "@openzeppelin/contracts/token/ERC721/IERC721.sol";
import {BatchFactory} from "../src/BatchFactory.sol";
import {IRatings} from "../src/Batch.sol";
import {Sweeper} from "../src/Sweeper.sol";
import {TokenAdapter, ITokenUnions} from "../src/TokenAdapter.sol";
import {UnionFormats, IUnionFactory} from "../src/UnionFormats.sol";
import {IAssembler} from "../src/interfaces/IAssembler.sol";
import {ICredits} from "../src/interfaces/ICredits.sol";
import {ICreditStrategy} from "../src/interfaces/ICreditStrategy.sol";
import {IFWAMarket} from "../src/interfaces/IFWAMarket.sol";
import {ISeaport} from "../src/interfaces/ISeaport.sol";
import {IStatements} from "../src/interfaces/IStatements.sol";
import {IStatementVault} from "../src/interfaces/IStatementVault.sol";
import {MockStatementVault} from "../src/mocks/MockStatementVault.sol";

/// @notice Token unions, in two stages, like the first factory.
///
///   Stage 1 (pooling opens before the vault exists): the token factory with no assembler, its UnionFormats and its
///   own Sweeper (a Sweeper deposits into one factory). Every union takes any Credit; members can leave until the
///   adapter is active.
///     SETTER=… FEE_RECIPIENT=… forge script script/DeployTokenUnions.s.sol --rpc-url $MAINNET_RPC --account deployer --broadcast
///   RATINGS defaults to the live factory's table; PROTOCOL_FEE_BPS 600 (6% of each conversion), CREATOR_FEE_BPS 0,
///   SWEEP_FEE_BPS 200.
///
///   Stage 2 (the vault ships): FACTORY, FORMATS and VAULT set deploy TokenAdapter; then, from the setter,
///     cast send $FACTORY "proposeAssembler(address)" $ADAPTER   // 30 minutes' notice
///     cast send $FACTORY "activateAssembler()"                  // anyone, after
///   MOCK_VAULT=1 (forks only) deploys a test vault paying a fixed amount per Statement and proposes it here.
contract DeployTokenUnions is Script {
    ICredits constant CREDITS = ICredits(0x97630aA70AB14ed9883B41dAfccBc11349723043);
    IStatements constant STATEMENTS = IStatements(0x75Edd94b7e49b3bD5C8047b91F165A5e265a069b);
    BatchFactory constant MAIN_FACTORY = BatchFactory(0xcb06f9076e5fbF3cB052086b1EE7C0F3836aa051);
    ISeaport constant SEAPORT = ISeaport(0x0000000000000068F116a894984e2DB1123eB395);
    ICreditStrategy constant CREDIT_STRATEGY = ICreditStrategy(0x8e607209899b5d12Bd3167a6CD0E8E11FEB053d6);
    IFWAMarket constant FWA_MARKET = IFWAMarket(0x2b019Cfb591988D28C64C4f4be6a24b1592BBF25);

    function run() external {
        address factoryAddr = vm.envOr("FACTORY", address(0));
        vm.startBroadcast();
        if (factoryAddr == address(0)) {
            address setter = vm.envAddress("SETTER");
            address feeTo = vm.envAddress("FEE_RECIPIENT");
            IRatings ratings = IRatings(vm.envOr("RATINGS", address(MAIN_FACTORY.ratings())));
            BatchFactory factory = new BatchFactory(
                CREDITS, ratings, IAssembler(address(0)), setter, feeTo, vm.envOr("PROTOCOL_FEE_BPS", uint256(600)), vm.envOr("CREATOR_FEE_BPS", uint256(0)), 1
            );
            UnionFormats formats = new UnionFormats(IUnionFactory(address(factory)));
            Sweeper sweeper = new Sweeper(SEAPORT, factory, vm.envOr("SWEEP_FEE_BPS", uint256(200)), FWA_MARKET, CREDIT_STRATEGY);
            console2.log("TOKEN_FACTORY", address(factory));
            console2.log("TOKEN_FORMATS", address(formats));
            console2.log("TOKEN_SWEEPER", address(sweeper));
        } else {
            BatchFactory factory = BatchFactory(factoryAddr);
            IStatementVault vault = IStatementVault(vm.envOr("VAULT", address(0)));
            bool mock = vm.envOr("MOCK_VAULT", false);
            if (mock) {
                require(vm.envOr("FORK", false), "mock vault: forks only (FORK=1)");
                vault = new MockStatementVault(IERC721(address(STATEMENTS)), vm.envOr("PER_STATEMENT", uint256(1_000_000 ether)));
            }
            require(address(vault).code.length > 0, "no vault");
            TokenAdapter adapter = new TokenAdapter(CREDITS, STATEMENTS, ITokenUnions(factoryAddr), UnionFormats(vm.envAddress("FORMATS")), vault);
            if (mock) factory.proposeAssembler(adapter);
            console2.log("VAULT", address(vault));
            console2.log("TOKEN_ADAPTER", address(adapter));
        }
        vm.stopBroadcast();
    }
}
