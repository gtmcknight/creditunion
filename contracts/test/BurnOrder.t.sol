// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {IERC721Receiver} from "@openzeppelin/contracts/token/ERC721/IERC721Receiver.sol";
import {Batch, IRatings} from "../src/Batch.sol";
import {BatchFactory} from "../src/BatchFactory.sol";
import {IAssembler} from "../src/interfaces/IAssembler.sol";
import {ICredits} from "../src/interfaces/ICredits.sol";
import {MockCredits} from "../src/mocks/MockCredits.sol";
import {MockStatement} from "../src/mocks/MockStatement.sol";

/// @dev Burns in the order given and records exactly what the Batch handed it.
contract RecordingAssembler is IAssembler, IERC721Receiver {
    MockStatement public immutable target;
    ICredits public immutable credits;
    uint256[] internal _got;
    uint8 public gotArrangement;

    constructor(MockStatement target_) {
        target = target_;
        credits = target_.credits();
        credits.setApprovalForAll(address(target_), true);
    }

    function statement() external view returns (address) {
        return address(target);
    }

    function assemble(uint256[] calldata ids, uint8 arrangement) external returns (uint256 id) {
        _got = ids;
        gotArrangement = arrangement;
        for (uint256 i; i < ids.length; ++i) credits.transferFrom(msg.sender, address(this), ids[i]);
        id = target.make(ids);
        target.transferFrom(address(this), msg.sender, id);
    }

    function got() external view returns (uint256[] memory) {
        return _got;
    }

    function onERC721Received(address, address, uint256, bytes calldata) external pure returns (bytes4) {
        return this.onERC721Received.selector;
    }
}

/// @notice The adapter receives exactly `burnOrder()`, and `burnOrder()` is the intended order for every
///         arrangement, including after withdraw and re-deposit churn.
contract BurnOrderTest is Test {
    uint256 constant CMY = 7; // MockCredits: even ids print CMY
    uint256 constant K = 8; // odd ids print K
    MockCredits credits;
    MockStatement statement;
    RecordingAssembler asm_;
    BatchFactory factory;
    Batch.Filter noFilter;
    address alice = makeAddr("alice");
    address bob = makeAddr("bob");
    address fee = makeAddr("fee");

    function setUp() public {
        credits = new MockCredits();
        statement = new MockStatement(ICredits(address(credits)));
        asm_ = new RecordingAssembler(statement);
        factory = new BatchFactory(ICredits(address(credits)), IRatings(address(0)), asm_, address(0), fee, 100, 0, 1);
        credits.mint(alice, 100); // 1..100
        credits.mint(bob, 100); // 101..200
        for (uint256 i; i < 2; ++i) {
            address u = [alice, bob][i];
            vm.prank(u);
            credits.setApprovalForAll(address(factory), true);
        }
    }

    // ------------------------------------------------------------ helpers

    function _range(uint256 from, uint256 n) internal pure returns (uint256[] memory a) {
        a = new uint256[](n);
        for (uint256 i; i < n; ++i) a[i] = from + i;
    }

    function _create(Batch.Arrangement how, Batch.Filter memory f, uint256[] memory ids) internal returns (Batch) {
        vm.prank(bob);
        return Batch(factory.create("B", f, new uint256[](0), 0, how, Batch.Split.Equal, 14 days, ids, 100, 0));
    }

    /// Churn: bob opens with 151..190, alice adds 1..30, bob leaves with 160..164, alice adds 31..45.
    /// Final deposit order: 151..159, 165..190, 1..45 (80 ids; deposit order is not id order).
    function _churned(Batch.Arrangement how) internal returns (Batch b, uint256[] memory dep) {
        b = _create(how, noFilter, _range(151, 40));
        vm.prank(alice);
        factory.deposit(address(b), _range(1, 30));
        vm.prank(bob);
        b.withdraw(_range(160, 5));
        vm.prank(alice);
        factory.deposit(address(b), _range(31, 15));
        assertEq(uint256(b.state()), uint256(Batch.State.Full));
        dep = new uint256[](80);
        uint256 k;
        for (uint256 id = 151; id <= 190; ++id) if (id < 160 || id > 164) dep[k++] = id;
        for (uint256 id = 1; id <= 45; ++id) dep[k++] = id;
        assertEq(k, 80);
    }

    function _sorted(uint256[] memory a, bool desc) internal pure returns (uint256[] memory out) {
        out = new uint256[](a.length);
        for (uint256 i; i < a.length; ++i) out[i] = a[i];
        for (uint256 i; i < out.length; ++i) {
            for (uint256 j = i + 1; j < out.length; ++j) {
                if (desc ? out[j] > out[i] : out[j] < out[i]) (out[i], out[j]) = (out[j], out[i]);
            }
        }
    }

    /// Assemble and check the adapter got exactly burnOrder(), told Deposit (pass through), and all 80 burned.
    function _burnMatches(Batch b) internal returns (uint256[] memory order) {
        order = b.burnOrder();
        assertEq(order.length, 80);
        skip(b.LOCK_DELAY()); // countdown over: burnable
        assertEq(b.burnOrder(), order);
        b.assemble();
        assertEq(asm_.got(), order, "adapter got burnOrder()");
        assertEq(asm_.gotArrangement(), uint8(Batch.Arrangement.Deposit), "adapter told pass through");
        assertEq(uint256(b.state()), uint256(Batch.State.Auction));
    }

    // ------------------------------------------------------------ arrangements

    function test_DepositBurnsInDepositOrder() public {
        (Batch b, uint256[] memory dep) = _churned(Batch.Arrangement.Deposit);
        uint256[] memory order = _burnMatches(b);
        assertEq(order, dep);
        assertEq(order[0], 151);
        assertEq(order[9], 165); // 160..164 left; the rest moved up
        assertEq(order[79], 45);
    }

    function test_NumberBurnsLowToHigh() public {
        (Batch b, uint256[] memory dep) = _churned(Batch.Arrangement.Number);
        uint256[] memory order = _burnMatches(b);
        assertEq(order, _sorted(dep, false));
        for (uint256 i = 1; i < 80; ++i) assertLt(order[i - 1], order[i]);
        assertEq(order[0], 1);
        assertEq(order[79], 190);
    }

    function test_NumberDescBurnsHighToLow() public {
        (Batch b, uint256[] memory dep) = _churned(Batch.Arrangement.NumberDesc);
        uint256[] memory order = _burnMatches(b);
        assertEq(order, _sorted(dep, true));
        for (uint256 i = 1; i < 80; ++i) assertGt(order[i - 1], order[i]);
        assertEq(order[0], 190);
        assertEq(order[79], 1);
    }

    /// Sorting re-runs over whatever is held: a leave and rejoin moves the id in deposit order, not in the sheet.
    function test_SortedOrderIgnoresRejoin() public {
        (Batch b,) = _churned(Batch.Arrangement.Number);
        uint256[] memory before = b.burnOrder();
        // In the countdown alice leaves with 1 and rejoins it (now last in deposit order).
        vm.prank(alice);
        b.withdraw(_range(1, 1));
        vm.prank(alice);
        factory.deposit(address(b), _range(1, 1));
        assertEq(b.burnOrder(), before);
        _burnMatches(b);
        assertEq(asm_.got()[0], 1);
    }

    /// Any deposit order: Number/NumberDesc burn the same 80 ids strictly sorted, and the adapter gets burnOrder().
    function testFuzz_SortAnyDepositOrder(uint256 seed, bool desc) public {
        uint256[] memory ids = _range(101, 80);
        for (uint256 i = 79; i > 0; --i) {
            uint256 j = uint256(keccak256(abi.encode(seed, i))) % (i + 1);
            (ids[i], ids[j]) = (ids[j], ids[i]);
        }
        Batch b = _create(desc ? Batch.Arrangement.NumberDesc : Batch.Arrangement.Number, noFilter, ids);
        uint256[] memory order = _burnMatches(b);
        assertEq(order, _sorted(ids, desc));
    }

    function test_LayoutBurnsLayoutOrder() public {
        // Checkered CMY/K, 40 of each. Churn: open with 40 odd (K), add 30 even, leave 5 odd, add 5 odd + 10 even.
        Batch.Filter memory f;
        for (uint256 i; i < 80; ++i) {
            uint256 m = ((i / 8 + i % 8) % 2 == 0) ? CMY : K;
            if (i < 64) f.layout0 |= m << (4 * i);
            else f.layout1 |= uint64(m << (4 * (i - 64)));
        }
        uint256[] memory odd = new uint256[](40);
        for (uint256 i; i < 40; ++i) odd[i] = 101 + 2 * i; // bob's 101..179 odd
        Batch b = _create(Batch.Arrangement.Layout, f, odd);
        uint256[] memory even = new uint256[](30);
        for (uint256 i; i < 30; ++i) even[i] = 2 + 2 * i; // alice's 2..60
        vm.prank(alice);
        factory.deposit(address(b), even);
        uint256[] memory out = new uint256[](5);
        for (uint256 i; i < 5; ++i) out[i] = 101 + 2 * i;
        vm.prank(bob);
        b.withdraw(out);
        uint256[] memory more = new uint256[](15);
        for (uint256 i; i < 5; ++i) more[i] = 1 + 2 * i; // alice's odd 1..9
        for (uint256 i; i < 10; ++i) more[5 + i] = 62 + 2 * i; // alice's even 62..80
        vm.prank(alice);
        factory.deposit(address(b), more);
        assertEq(uint256(b.state()), uint256(Batch.State.Full));

        uint256[] memory order = b.burnOrder();
        assertEq(order, b.layoutOrder());
        uint8[80] memory slots = b.layout();
        for (uint256 i; i < 80; ++i) assertEq(order[i] % 2 == 0 ? CMY : K, slots[i], "slot palette");
        _burnMatches(b);
    }

    /// A MintTime batch opened before the retirement: the new implementation can't create one, so flip a Number
    /// batch's stored arrangement (slot 20, byte 0) to MintTime. It burns by Credit number, low to high, which on
    /// mainnet is payment order.
    function test_LegacyMintTimeBurnsByNumber() public {
        (Batch b, uint256[] memory dep) = _churned(Batch.Arrangement.Number);
        bytes32 raw = vm.load(address(b), bytes32(uint256(20)));
        assertEq(uint8(uint256(raw)), uint8(Batch.Arrangement.Number));
        vm.store(address(b), bytes32(uint256(20)), bytes32((uint256(raw) & ~uint256(0xff)) | uint256(Batch.Arrangement.MintTime)));
        assertEq(uint256(b.arrangement()), uint256(Batch.Arrangement.MintTime));
        uint256[] memory order = _burnMatches(b);
        assertEq(order, _sorted(dep, false));
    }

    // ------------------------------------------------------------ initialize

    function test_InitializeRejectsRetired() public {
        vm.prank(bob);
        vm.expectRevert(Batch.ArrangementRetired.selector);
        factory.create("x", noFilter, new uint256[](0), 0, Batch.Arrangement.MintTime, Batch.Split.Equal, 14 days, _range(101, 1), 100, 0);
        vm.prank(bob);
        vm.expectRevert(Batch.ArrangementRetired.selector);
        factory.create("x", noFilter, new uint256[](0), 0, Batch.Arrangement.Creator, Batch.Split.Equal, 14 days, _range(101, 1), 100, 0);
    }

    function test_InitializeAcceptsNumberDesc() public {
        Batch b = _create(Batch.Arrangement.NumberDesc, noFilter, _range(101, 3));
        assertEq(uint256(b.arrangement()), uint256(Batch.Arrangement.NumberDesc));
        assertEq(uint256(Batch.Arrangement.NumberDesc), 5);
        uint256[] memory order = b.burnOrder(); // readable while Open too
        assertEq(order[0], 103);
        assertEq(order[2], 101);
    }
}
