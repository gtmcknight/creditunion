// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC721} from "@openzeppelin/contracts/token/ERC721/IERC721.sol";
import {Batch, IRatings} from "../src/Batch.sol";
import {BatchFactory} from "../src/BatchFactory.sol";
import {LiveRatings, ICreditScore} from "../src/LiveRatings.sol";
import {TokenAdapter, ITokenUnions} from "../src/TokenAdapter.sol";
import {UnionFormats, IUnionFactory} from "../src/UnionFormats.sol";
import {IAssembler} from "../src/interfaces/IAssembler.sol";
import {ICredits} from "../src/interfaces/ICredits.sol";
import {IStatements} from "../src/interfaces/IStatements.sol";
import {IStatementVault} from "../src/interfaces/IStatementVault.sol";
import {MockStatementVault} from "../src/mocks/MockStatementVault.sol";

interface IStatementsParts {
    function art() external view returns (address);
    function score() external view returns (address);
}

interface IStatementsInk {
    function creditScoreOf(uint256 id) external view returns (uint256);
    function inkOf(uint256 id) external view returns (uint256[240] memory);
}

/// @notice A heavy stand-in vault: it keeps the Statement, reads the page's ink, and mints its Credit Rating as an
///         18-decimal token. Every transfer moves a share of four tracked amounts from sender to receiver, and the
///         first payment to a wallet also stores a record for it (owner, count, id). Paying a new wallet costs about
///         230k gas, so 80 new members can't all be paid in one transaction.
contract HeavyVault is ERC20, IStatementVault {
    IStatementsInk public immutable statements;
    mapping(address => uint256[4]) public amountsOf;
    mapping(uint256 => address) public recordOwner;
    mapping(address => uint256) public recordOf;
    mapping(address => uint256) public recordCount;
    uint256 public records;
    uint256 internal _shares; // the page's four shares of 1e18, while its tokens are minted

    event Recorded(address indexed to, uint256 indexed id);

    constructor(IStatementsInk statements_) ERC20("Heavy", "HEAVY") {
        statements = statements_;
    }

    function quote(uint256 statementId) public view returns (uint256) {
        return statements.creditScoreOf(statementId) * 1e14; // ten-thousandths of a point, to 18 decimals
    }

    function withdraw(uint256 statementId, uint256 expectedAmount) external returns (uint256 amount) {
        require(IERC721(address(statements)).ownerOf(statementId) == msg.sender, "not owner");
        amount = quote(statementId);
        require(amount == expectedAmount, "score changed");
        IERC721(address(statements)).transferFrom(msg.sender, address(this), statementId);
        uint256[240] memory ink = statements.inkOf(statementId);
        uint256[4] memory n;
        for (uint256 i; i < 240; ++i) n[i & 3] += _bits(ink[i]);
        uint256 t = n[0] + n[1] + n[2] + n[3];
        for (uint256 p; p < 4; ++p) _shares |= (n[p] * 1e18 / (t == 0 ? 1 : t)) << (64 * p);
        _mint(msg.sender, amount);
        _shares = 0;
    }

    function _update(address from, address to, uint256 value) internal override {
        uint256 fromBefore = from == address(0) ? 0 : balanceOf(from);
        super._update(from, to, value);
        if (to == address(0) || value == 0) return;
        for (uint256 p; p < 4; ++p) {
            uint256 moved = from == address(0)
                ? value * ((_shares >> (64 * p)) & type(uint64).max) / 1e18
                : amountsOf[from][p] * value / fromBefore;
            if (from != address(0)) amountsOf[from][p] -= moved;
            amountsOf[to][p] += moved;
        }
        if (recordOf[to] != 0) return;
        uint256 id = ++records;
        recordOwner[id] = to;
        recordOf[to] = id;
        recordCount[to] = 1;
        emit Recorded(to, id);
    }

    function _bits(uint256 x) internal pure returns (uint256) {
        unchecked {
            x = x - ((x >> 1) & 0x5555555555555555555555555555555555555555555555555555555555555555);
            x = (x & 0x3333333333333333333333333333333333333333333333333333333333333333)
                + ((x >> 2) & 0x3333333333333333333333333333333333333333333333333333333333333333);
            x = (x + (x >> 4)) & 0x0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f;
            x = (x & 0x00ff00ff00ff00ff00ff00ff00ff00ff00ff00ff00ff00ff00ff00ff00ff00ff)
                + ((x >> 8) & 0x00ff00ff00ff00ff00ff00ff00ff00ff00ff00ff00ff00ff00ff00ff00ff00ff);
            return (x * 0x0001000100010001000100010001000100010001000100010001000100010001) >> 240;
        }
    }
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
    uint256 constant CALL_GAS = TX_GAS_CAP - 30_000; // what a transaction at the cap leaves the call

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
        vault = new MockStatementVault(IERC721(STATEMENTS), 1_000_000 ether);
        _deploy(vault);
    }

    /// A token factory whose unions convert into `v`.
    function _deploy(IStatementVault v) internal {
        factory = new BatchFactory(CREDITS, IRatings(address(live)), IAssembler(address(0)), address(this), address(0xFEE), 200, 0, 1);
        formats = new UnionFormats(IUnionFactory(address(factory)));
        adapter = new TokenAdapter(CREDITS, statements, ITokenUnions(address(factory)), formats, v);
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
        address v = address(adapter.vault());
        vm.cool(address(CREDITS));
        vm.cool(STATEMENTS);
        vm.cool(IStatementsParts(STATEMENTS).art());
        vm.cool(IStatementsParts(STATEMENTS).score());
        vm.cool(address(live));
        vm.cool(address(adapter));
        vm.cool(adapter.pocketOf(union));
        vm.cool(v);
        vm.cool(address(factory));
        vm.cool(union);
    }

    /// Into the burn hour.
    function _burnHour(Batch b) internal {
        if (b.phase() == Batch.Phase.Countdown) vm.warp(b.lockAt());
        (bool ok, bytes memory opens) = STATEMENTS.staticcall(abi.encodeWithSignature("composeOpensAt()"));
        if (ok && opens.length == 32 && block.timestamp < abi.decode(opens, (uint256))) vm.warp(abi.decode(opens, (uint256)));
        assertEq(uint256(b.phase()), uint256(Batch.Phase.Burnable));
    }

    function test_GasRateBurnPayOut() public {
        Batch b = _union();

        _cool(address(b));
        uint256 g = gasleft();
        adapter.rate(address(b));
        uint256 rate = g - gasleft();

        _burnHour(b);

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

    /// A heavy token: one call can't pay 80 new members under the cap, and it reverts instead of skipping anyone; two
    /// calls of 40 pay everyone.
    function test_HeavyTokenPaysInParts() public {
        HeavyVault heavy = new HeavyVault(IStatementsInk(STATEMENTS));
        _deploy(heavy);
        Batch b = _union();
        adapter.rate(address(b));
        _burnHour(b);

        _cool(address(b));
        uint256 g = gasleft();
        b.assemble();
        uint256 burn = g - gasleft();

        _cool(address(b));
        vm.expectRevert(TokenAdapter.PayoutGasTooLow.selector);
        adapter.distribute{gas: CALL_GAS}(address(b));

        _cool(address(b));
        g = gasleft();
        adapter.distributeNext{gas: CALL_GAS}(address(b), 40);
        uint256 first = g - gasleft();
        _cool(address(b));
        g = gasleft();
        adapter.distributeNext{gas: CALL_GAS}(address(b), 40);
        uint256 second = g - gasleft();

        emit log_named_uint("heavy token: burn + deposit (heaviest sheet, cold)", burn);
        emit log_named_uint("heavy token: pay out members 1-40 (cold)", first);
        emit log_named_uint("heavy token: pay out members 41-80 (cold)", second);

        assertLt(burn, TX_GAS_CAP);
        for (uint256 i; i < 80; ++i) assertGt(heavy.balanceOf(address(uint160(0xA000 + i))), 0);
        assertLe(heavy.balanceOf(adapter.pocketOf(address(b))), 80, "only rounding dust stays");
        assertEq(heavy.balanceOf(address(adapter)), 0, "never in the adapter");
    }
}
