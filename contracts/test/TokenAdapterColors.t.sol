// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {Clones} from "@openzeppelin/contracts/proxy/Clones.sol";
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC721} from "@openzeppelin/contracts/token/ERC721/IERC721.sol";
import {ratingsOf} from "../script/RatingsOf.sol";
import {Batch} from "../src/Batch.sol";
import {BatchFactory} from "../src/BatchFactory.sol";
import {IAssembler} from "../src/interfaces/IAssembler.sol";
import {ICredits} from "../src/interfaces/ICredits.sol";
import {IStatements} from "../src/interfaces/IStatements.sol";
import {IStatementVault} from "../src/interfaces/IStatementVault.sol";
import {MockCredits} from "../src/mocks/MockCredits.sol";
import {MockStatement} from "../src/mocks/MockStatement.sol";
import {TokenAdapter, ITokenUnions} from "../src/TokenAdapter.sol";
import {UnionFormats, IUnionFactory} from "../src/UnionFormats.sol";
import {IdRatings} from "./TokenAdapter.t.sol";
import {ready} from "./utils/Ready.sol";

/// NOT A REAL VAULT. A token with colors, as the BALANCE design describes them: each wallet holds a CMYK palette,
/// a surrender pays tokens in its Statement's palette, and every transfer mixes the sender's palette into the
/// receiver's, weighted by amount. Palettes here are given per deposit, in order, by the test.
contract ColorVault is IStatementVault, ERC20 {
    IERC721 public immutable statements;
    uint256 public constant PER = 1_000_000 ether;
    mapping(address => uint256[4]) internal _palette;
    uint256[4][] internal _queue;
    uint256 internal _deposits;
    uint256[4] internal _minting;

    constructor(IERC721 statements_) ERC20("Colors", "CLR") {
        statements = statements_;
    }

    function queue(uint256[4] calldata p) external {
        _queue.push(p);
    }

    /// @notice For tests: tokens of any color, straight to a wallet (a troll's black ones, say).
    function mintTo(address to, uint256 amount, uint256[4] calldata p) external {
        _minting = p;
        _mint(to, amount);
    }

    function paletteOf(address who) external view returns (uint256[4] memory) {
        return _palette[who];
    }

    function quote(uint256) external pure returns (uint256) {
        return PER;
    }

    function withdraw(uint256 statementId, uint256 expectedAmount) external returns (uint256) {
        require(statements.ownerOf(statementId) == msg.sender && expectedAmount == PER, "withdraw");
        statements.transferFrom(msg.sender, address(this), statementId);
        _minting = _queue[_deposits++];
        _mint(msg.sender, PER);
        return PER;
    }

    function _update(address from, address to, uint256 value) internal override {
        if (to != address(0) && value != 0) {
            uint256[4] memory src = from == address(0) ? _minting : _palette[from];
            uint256 held = balanceOf(to);
            for (uint256 k; k < 4; ++k) _palette[to][k] = (_palette[to][k] * held + src[k] * value) / (held + value);
        }
        super._update(from, to, value);
    }
}

/// @notice Each token union converts and pays out from its own pocket, so a union's colors reach its members unmixed
///         even when another union converted in between. Through one shared wallet they would arrive blended.
contract TokenAdapterColorsTest is Test {
    MockCredits credits;
    MockStatement statements;
    ColorVault vault;
    BatchFactory factory;
    TokenAdapter adapter;
    Batch.Filter noFilter;
    address alice = makeAddr("colors-alice");
    address bob = makeAddr("colors-bob");
    address dave = makeAddr("colors-dave");
    address erin = makeAddr("colors-erin");
    address fee = makeAddr("colors-fee");
    uint256[4] CYAN = [uint256(1e18), 0, 0, 0];
    uint256[4] MAGENTA = [uint256(0), 1e18, 0, 0];

    function setUp() public {
        credits = new MockCredits();
        statements = new MockStatement(ICredits(address(credits)));
        vault = new ColorVault(IERC721(address(statements)));
        factory = new BatchFactory(ICredits(address(credits)), new IdRatings(), IAssembler(address(0)), address(this), fee, 200, 0, 1);
        UnionFormats formats = new UnionFormats(IUnionFactory(address(factory)));
        adapter = new TokenAdapter(ICredits(address(credits)), IStatements(address(statements)), ITokenUnions(address(factory)), formats, vault);
        factory.proposeAssembler(adapter);
        skip(factory.ASSEMBLER_DELAY());
        factory.activateAssembler();
        address[4] memory who = [alice, bob, dave, erin];
        for (uint256 i; i < 4; ++i) {
            credits.mint(who[i], 40);
            vm.prank(who[i]);
            credits.setApprovalForAll(address(factory), true);
        }
    }

    function _range(uint256 from, uint256 n) internal pure returns (uint256[] memory a) {
        a = new uint256[](n);
        for (uint256 i; i < n; ++i) a[i] = from + i;
    }

    function _union(address x, uint256 xFrom, address y, uint256 yFrom) internal returns (Batch b) {
        vm.prank(x);
        b = Batch(factory.create("C", noFilter, new uint256[](0), 0, Batch.Arrangement.Deposit, Batch.Split.Equal, 14 days, _range(xFrom, 40), 200, 0, ratingsOf(address(factory))));
        vm.prank(y);
        factory.deposit(address(b), _range(yFrom, 40));
    }

    function _burn(Batch b) internal {
        adapter.rate(address(b));
        ready(b);
        b.assemble();
    }

    function _assertPalette(address who, uint256[4] memory want, string memory what) internal view {
        uint256[4] memory got = vault.paletteOf(who);
        for (uint256 k; k < 4; ++k) assertEq(got[k], want[k], what);
    }

    function test_EachUnionPaysItsOwnColors() public {
        Batch cyan = _union(alice, 1, bob, 41);
        Batch magenta = _union(dave, 81, erin, 121);
        vault.queue(CYAN);
        vault.queue(MAGENTA);
        // Both convert before either pays out: the worst case for a shared wallet.
        _burn(cyan);
        _burn(magenta);
        assertTrue(adapter.pocketOf(address(cyan)) != adapter.pocketOf(address(magenta)), "a pocket each");
        _assertPalette(adapter.pocketOf(address(cyan)), CYAN, "cyan's pocket is cyan");
        _assertPalette(adapter.pocketOf(address(magenta)), MAGENTA, "magenta's pocket is magenta");

        adapter.distribute(address(magenta));
        adapter.distribute(address(cyan));
        _assertPalette(alice, CYAN, "alice gets cyan");
        _assertPalette(bob, CYAN, "bob gets cyan");
        _assertPalette(dave, MAGENTA, "dave gets magenta");
        _assertPalette(erin, MAGENTA, "erin gets magenta");
        assertGt(vault.balanceOf(alice), 0);
        assertGt(vault.balanceOf(dave), 0);
        assertEq(vault.balanceOf(address(adapter)), 0, "nothing passes through the adapter");
    }

    /// Tokens sent to a union's pocket ahead of its burn, to tint its colors with someone else's, go to the fee
    /// recipient before the vault pays: the pocket is empty when its own tokens arrive, and the members get pure cyan.
    function test_TokensSentAheadDontTint() public {
        Batch cyan = _union(alice, 1, bob, 41);
        address troll = makeAddr("colors-troll");
        vault.mintTo(troll, 10_000 ether, [uint256(0), 0, 0, 1e18]); // black
        address pocket = Clones.predictDeterministicAddress(adapter.pocketImplementation(), bytes32(uint256(uint160(address(cyan)))), address(adapter));
        vm.prank(troll);
        vault.transfer(pocket, 10_000 ether);
        vault.queue(CYAN);
        _burn(cyan);
        assertEq(adapter.pocketOf(address(cyan)), pocket);
        assertEq(vault.balanceOf(fee), 10_000 ether, "the troll's tokens went to the fee recipient");
        _assertPalette(pocket, CYAN, "the pocket is pure cyan");
        (, uint256 amount,,,,,) = adapter.conversionOf(address(cyan));
        assertEq(amount, vault.PER(), "only the vault's tokens count as converted");
        adapter.distribute(address(cyan));
        _assertPalette(alice, CYAN, "alice gets pure cyan");
        _assertPalette(bob, CYAN, "bob gets pure cyan");
    }

    /// A member of two unions mixes the two in their own wallet, as the design intends; no one else's do.
    function test_AMemberOfBothMixesInTheirOwnWallet() public {
        credits.mint(bob, 40); // 161..200: bob's second 40
        Batch cyan = _union(alice, 1, bob, 41);
        Batch magenta = _union(dave, 81, bob, 161); // bob is in both
        vault.queue(CYAN);
        vault.queue(MAGENTA);
        _burn(cyan);
        _burn(magenta);
        adapter.distribute(address(cyan));
        adapter.distribute(address(magenta));
        _assertPalette(alice, CYAN, "alice stays cyan");
        _assertPalette(dave, MAGENTA, "dave stays magenta");
        uint256[4] memory mixed = vault.paletteOf(bob);
        assertGt(mixed[0], 0, "bob has cyan");
        assertGt(mixed[1], 0, "and magenta");
    }
}
