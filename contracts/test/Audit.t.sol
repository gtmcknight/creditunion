// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {IERC721Receiver} from "@openzeppelin/contracts/token/ERC721/IERC721Receiver.sol";
import {Batch, IRatings} from "../src/Batch.sol";
import {BatchFactory} from "../src/BatchFactory.sol";
import {MockAssembler} from "../src/MockAssembler.sol";
import {IAssembler} from "../src/interfaces/IAssembler.sol";
import {ICredits} from "../src/interfaces/ICredits.sol";
import {MockCredits} from "../src/mocks/MockCredits.sol";
import {MockStatement} from "../src/mocks/MockStatement.sol";

/// @dev An honest adapter with one innocent-looking storage variable. Under the old DELEGATECALL design
///      its slot 0 was Batch.factory; with a plain call its storage is its own.
contract CounterAssembler is IAssembler, IERC721Receiver {
    MockStatement immutable st;
    ICredits immutable credits;
    uint256 public assembled;

    constructor(MockStatement st_) {
        st = st_;
        credits = st_.credits();
        credits.setApprovalForAll(address(st_), true);
    }

    function statement() external view returns (address) {
        return address(st);
    }

    function assemble(uint256[] calldata ids, uint8) external returns (uint256 id) {
        for (uint256 i; i < ids.length; ++i) credits.transferFrom(msg.sender, address(this), ids[i]);
        id = st.make(ids);
        st.transferFrom(address(this), msg.sender, id);
        ++assembled;
    }

    function onERC721Received(address, address, uint256, bytes calldata) external pure returns (bytes4) {
        return this.onERC721Received.selector;
    }
}

/// @notice Adversarial review of Batch. Each test asserts the property Batch should have; a failing test
///         is a demonstrated issue against the current code.
contract AuditTest is Test {
    MockCredits credits;
    MockStatement statement;
    BatchFactory factory;
    address fee = makeAddr("fee");
    address alice = makeAddr("alice");
    address bob = makeAddr("bob");
    address carol = makeAddr("carol");
    Batch.Filter noFilter;

    function setUp() public {
        credits = new MockCredits();
        statement = new MockStatement(ICredits(address(credits)));
        factory = new BatchFactory(ICredits(address(credits)), IRatings(address(0)), new MockAssembler(statement), address(0), fee, 100, 0, 10);
        credits.mint(alice, 50); // 1..50
        credits.mint(bob, 50); // 51..100
        for (uint256 i; i < 3; ++i) {
            address u = [alice, bob, carol][i];
            vm.prank(u);
            credits.setApprovalForAll(address(factory), true);
            vm.deal(u, 100 ether);
        }
    }

    function _range(uint256 from, uint256 n) internal pure returns (uint256[] memory a) {
        a = new uint256[](n);
        for (uint256 i; i < n; ++i) a[i] = from + i;
    }

    function _one(uint256 id) internal pure returns (uint256[] memory a) {
        a = new uint256[](1);
        a[0] = id;
    }

    function _open(address who, uint256[] memory ids) internal returns (Batch) {
        vm.prank(who);
        return Batch(factory.create("Audit", noFilter, new uint256[](0), 0, Batch.Arrangement.Deposit, Batch.Split.Equal, 14 days, ids, 100, 0));
    }

    // ---------------------------------------------------------------- F1: delegatecall storage exposure

    /// @dev An assembler that burns correctly, returns the right Statement, and passes every post-check
    ///      in assemble() must not be able to touch Batch storage. Under the old delegatecall design its
    ///      `++assembled` rewrote slot 0 (factory) and settle() reverted forever with the ETH stuck.
    function test_Audit_BuggyAssemblerStorageWriteBricksSettle() public {
        BatchFactory f2 = new BatchFactory(ICredits(address(credits)), IRatings(address(0)), new CounterAssembler(statement), address(0), fee, 100, 0, 10);
        vm.prank(alice);
        credits.setApprovalForAll(address(f2), true);
        vm.prank(bob);
        credits.setApprovalForAll(address(f2), true);
        vm.prank(alice);
        Batch b = Batch(f2.create("Bug", noFilter, new uint256[](0), 0, Batch.Arrangement.Deposit, Batch.Split.Equal, 14 days, _range(1, 40), 100, 0));
        vm.prank(bob);
        f2.deposit(address(b), _range(51, 40));

        // A fixed Batch may either reject this assembler outright (fine) or isolate it from storage.
        try b.assemble() {}
        catch {
            return;
        }
        assertEq(statement.ownerOf(1), address(b)); // every post-condition in assemble() passed

        vm.prank(carol);
        b.bid{value: 5 ether}(); // accepted: bid() never reads factory
        skip(1 days);

        // The assembler's storage is its own: Batch.factory is intact and the auction settles.
        assertEq(address(b.factory()), address(f2), "assembler rewrote Batch.factory");
        b.settle();
        assertEq(statement.ownerOf(1), carol);
    }

    // ---------------------------------------------------------------- F2: stray Credits

    /// @dev A Credit moved in with plain transferFrom (what Seaport/OpenSea delivery and most wallet
    ///      "send" flows use) fires no hook: not recorded, not withdrawable, not adoptable. ERC721 gives no
    ///      attribution for it, so the recovery path is rescue() to the fee recipient as lost-and-found.
    function test_Audit_StrayCreditPlainTransferGoesToLostAndFound() public {
        Batch b = _open(alice, _range(1, 10));
        vm.prank(bob);
        credits.transferFrom(bob, address(b), 60);

        assertEq(b.count(), 10);
        assertEq(b.depositorOf(60), address(0));

        vm.prank(bob);
        vm.expectRevert(abi.encodeWithSelector(Batch.NotDepositor.selector, 60));
        b.withdraw(_one(60));

        vm.prank(bob);
        vm.expectRevert(); // factory tries transferFrom(bob, b, 60); bob no longer owns it
        factory.deposit(address(b), _one(60));

        vm.expectRevert(Batch.NotFactory.selector);
        b.depositFrom(bob, _one(60));

        skip(365 days); // however long it waits, a stray is never withdrawable
        vm.prank(bob);
        vm.expectRevert(abi.encodeWithSelector(Batch.NotDepositor.selector, 60));
        b.withdraw(_one(60));

        // rescue() never touches pooled Credits...
        vm.expectRevert(Batch.NotStray.selector);
        b.rescue(address(credits), 1);
        // ...but forwards the stray to the fee recipient, who can return it off-chain.
        b.rescue(address(credits), 60);
        assertEq(credits.ownerOf(60), fee);
    }

    /// @dev `data` on safeTransferFrom names the beneficiary: an escrow delivering for bob credits bob.
    function test_Audit_HookHonorsBeneficiaryInData() public {
        Batch b = _open(alice, _range(1, 10));
        vm.prank(bob);
        credits.safeTransferFrom(bob, address(b), 61, abi.encode(carol));
        assertEq(b.depositorOf(61), carol);
        assertEq(b.sharesOf(carol), 1);
        vm.prank(carol);
        b.withdraw(_one(61));
        assertEq(credits.ownerOf(61), carol);
    }

    /// @dev The assembler's operator approval exists only inside assemble(); afterwards it is revoked.
    function test_Audit_AssemblerApprovalIsScoped() public {
        Batch b = _open(alice, _range(1, 40));
        vm.prank(bob);
        factory.deposit(address(b), _range(51, 40));
        address asm = address(factory.assembler());
        assertFalse(credits.isApprovedForAll(address(b), asm));
        b.assemble();
        assertFalse(credits.isApprovedForAll(address(b), asm));
    }

    /// @dev rescue() can never take the Statement, before or after the sale.
    function test_Audit_RescueCannotTakeStatement() public {
        Batch b = _open(alice, _range(1, 40));
        vm.prank(bob);
        factory.deposit(address(b), _range(51, 40));
        b.assemble();
        uint256 sid = b.statementId();
        vm.expectRevert(Batch.NotStray.selector);
        b.rescue(address(statement), sid);
    }
}
