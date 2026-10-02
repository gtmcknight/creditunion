// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {IERC721} from "@openzeppelin/contracts/token/ERC721/IERC721.sol";
import {Batch, IRatings} from "../src/Batch.sol";
import {BatchFactory} from "../src/BatchFactory.sol";
import {LiveRatings, ICreditScore} from "../src/LiveRatings.sol";
import {TokenAdapter, ITokenUnions} from "../src/TokenAdapter.sol";
import {UnionFormats, IUnionFactory} from "../src/UnionFormats.sol";
import {IAssembler} from "../src/interfaces/IAssembler.sol";
import {ICredits} from "../src/interfaces/ICredits.sol";
import {IStatements} from "../src/interfaces/IStatements.sol";
import {MockStatementVault} from "../src/mocks/MockStatementVault.sol";

interface IStatementsParts {
    function art() external view returns (address);
    function score() external view returns (address);
}

/// @notice Token unions on a copy of mainnet: the real Credits and Statements contract, LiveRatings over its scorer,
///         a token factory with TokenAdapter, and a stand-in vault (the real one isn't built). Measures what each
///         step costs cold against the 16.78M per-transaction cap, for the heaviest sheet real Credits make, each
///         Credit from a different holder (80 members, the most a payout can have).
///     MAINNET_RPC=<url> forge test --match-path test/TokenAdapter.fork.t.sol -vv
contract TokenAdapterForkTest is Test {
    ICredits constant CREDITS = ICredits(0x97630aA70AB14ed9883B41dAfccBc11349723043);
    address constant STATEMENTS = 0x75Edd94b7e49b3bD5C8047b91F165A5e265a069b;
    uint256 constant FORK_BLOCK = 26100900; // Statements live, no Credit burned yet, so every one of the heaviest 80 exists
    uint256 constant TX_GAS_CAP = 16_777_216;

    /// @dev As in StatementAdapter.fork.t.sol: slipped CMYK misprints, the most ink a sheet can carry.
    uint256[80] HEAVIEST = [
        30964, 94670, 10444, 84020, 4295, 59389, 70281, 74206, 88049, 106034,
        9, 6512, 49450, 11704, 46402, 49781, 64541, 75008, 85930, 93480,
        99619, 121491, 36782, 104978, 36969, 95197, 100074, 101251, 110963, 9901,
        14018, 29197, 38645, 41755, 52668, 90468, 91102, 41113, 69639, 71168,
        87083, 90256, 90984, 15607, 37261, 38969, 41429, 50105, 56235, 75640,
        85440, 96079, 102077, 112151, 114108, 5843, 10099, 11881, 19649, 46601,
        50391, 76586, 77910, 84566, 93961, 101429, 107371, 118493, 120541, 28363,
        28420, 38711, 40950, 45631, 64016, 80901, 91456, 92088, 106035, 106302
    ];

    IStatements statements;
    BatchFactory factory;
    UnionFormats formats;
    MockStatementVault vault;
    TokenAdapter adapter;
    LiveRatings live;

    function setUp() public {
        vm.createSelectFork(vm.envString("MAINNET_RPC"), FORK_BLOCK);
        statements = IStatements(STATEMENTS);
        live = new LiveRatings(CREDITS, ICreditScore(IStatementsParts(STATEMENTS).score()), 122_154);
        factory = new BatchFactory(CREDITS, IRatings(address(live)), IAssembler(address(0)), address(this), address(0xFEE), 200, 0, 1);
        formats = new UnionFormats(IUnionFactory(address(factory)));
        vault = new MockStatementVault(IERC721(STATEMENTS), 1_000_000 ether);
        adapter = new TokenAdapter(CREDITS, statements, ITokenUnions(address(factory)), formats, vault);
        factory.proposeAssembler(adapter);
        vm.warp(block.timestamp + factory.ASSEMBLER_DELAY());
        factory.activateAssembler();
    }

    /// Each of the 80 handed to its own fresh wallet, which puts it in: 80 members.
    function _union() internal returns (Batch b) {
        Batch.Filter memory any;
        uint256[] memory one = new uint256[](1);
        for (uint256 i; i < 80; ++i) {
            uint256 id = HEAVIEST[i];
            address member = address(uint160(0xA000 + i));
            address holder = CREDITS.ownerOf(id);
            vm.prank(holder);
            IERC721(address(CREDITS)).transferFrom(holder, member, id);
            vm.startPrank(member);
            IERC721(address(CREDITS)).setApprovalForAll(address(factory), true);
            one[0] = id;
            if (i == 0) b = Batch(factory.create("Tokens", any, new uint256[](0), 0, Batch.Arrangement.Deposit, Batch.Split.Equal, 14 days, one, 200, 0, IRatings(address(live))));
            else factory.deposit(address(b), one);
            vm.stopPrank();
        }
        assertEq(b.count(), 80);
    }

    function _cool(address union) internal {
        vm.cool(address(CREDITS));
        vm.cool(STATEMENTS);
        vm.cool(IStatementsParts(STATEMENTS).art());
        vm.cool(IStatementsParts(STATEMENTS).score());
        vm.cool(address(live));
        vm.cool(address(adapter));
        vm.cool(address(vault));
        vm.cool(address(factory));
        vm.cool(union);
    }

    function test_GasRateBurnPayOut() public {
        Batch b = _union();

        _cool(address(b));
        uint256 g = gasleft();
        adapter.rate(address(b));
        uint256 rate = g - gasleft();

        // Into the burn hour.
        if (b.phase() == Batch.Phase.Countdown) vm.warp(b.lockAt());
        (bool ok, bytes memory opens) = STATEMENTS.staticcall(abi.encodeWithSignature("composeOpensAt()"));
        if (ok && opens.length == 32 && block.timestamp < abi.decode(opens, (uint256))) vm.warp(abi.decode(opens, (uint256)));
        assertEq(uint256(b.phase()), uint256(Batch.Phase.Burnable));

        _cool(address(b));
        g = gasleft();
        b.assemble();
        uint256 burn = g - gasleft();

        _cool(address(b));
        g = gasleft();
        adapter.distribute(address(b));
        uint256 pay = g - gasleft();

        emit log_named_uint("rate (80 scores, cold)", rate);
        emit log_named_uint("burn + vault deposit (heaviest sheet, cold)", burn);
        emit log_named_uint("pay out (80 members, cold)", pay);
        emit log_named_uint("left under the cap for the real vault's deposit", TX_GAS_CAP - burn);

        assertLt(rate, TX_GAS_CAP);
        assertLt(burn, TX_GAS_CAP);
        assertLt(pay, TX_GAS_CAP);
        assertEq(statements.ownerOf(b.statementId()), address(vault));
        assertGt(vault.balanceOf(address(0xA000)), 0);
    }
}
