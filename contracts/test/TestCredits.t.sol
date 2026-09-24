// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {Batch} from "../src/Batch.sol";
import {BatchFactory} from "../src/BatchFactory.sol";
import {MockAssembler} from "../src/MockAssembler.sol";
import {ICredits} from "../src/interfaces/ICredits.sol";
import {TestCredits} from "../src/mocks/TestCredits.sol";
import {MockStatement} from "../src/mocks/MockStatement.sol";
import {CreditArt} from "../src/vendor/credits/CreditArt.sol";

contract TestCreditsTest is Test {
    TestCredits credits;
    address alice = makeAddr("alice");

    function setUp() public {
        credits = new TestCredits();
    }

    function test_MintGivesValidSeedsTimesAndArt() public {
        credits.mint(alice, 5);
        assertEq(credits.balanceOf(alice), 5);
        assertEq(credits.tokensOf(alice).length, 5);
        CreditArt art = credits.art();
        for (uint256 id = 1; id <= 5; ++id) {
            bytes21 seed = credits.seedOf(id);
            assertTrue(art.valid(seed));
            assertEq(credits.tokenOf(seed), id);
            uint64 t = credits.timestampOf(id);
            assertGe(t, 1789998000);
            assertLt(t, 1789998000 + 183000);
            CreditArt.Read memory r = art.describe(seed, t);
            assertGt(bytes(r.colors).length, 0);
        }
        string memory uri = credits.tokenURI(1);
        assertGt(bytes(uri).length, 1000); // full onchain JSON with the SVG
    }

    function test_MintBounds() public {
        vm.expectRevert(TestCredits.TooMany.selector);
        credits.mint(alice, 41);
        vm.expectRevert(TestCredits.TooMany.selector);
        credits.mint(alice, 0);
    }

    function test_BurnRuleMatchesCredits() public {
        credits.mint(alice, 3);
        uint256[] memory ids = new uint256[](2);
        ids[0] = 1;
        ids[1] = 2;
        vm.expectRevert(TestCredits.NotApproved.selector);
        credits.burn(alice, ids);
        vm.prank(alice);
        credits.burn(alice, ids);
        assertEq(credits.tokensOf(alice).length, 1);
        assertEq(credits.tokensOf(alice)[0], 3);
    }

    function test_TransferKeepsOwnedIndex() public {
        credits.mint(alice, 3);
        vm.prank(alice);
        credits.transferFrom(alice, address(this), 1);
        assertEq(credits.tokensOf(alice).length, 2);
        assertEq(credits.tokensOf(address(this))[0], 1);
    }

    /// Full flow on TestCredits: a filtered batch, 80 deposits, burn into a Statement.
    function test_BatchToStatement() public {
        MockStatement st = new MockStatement(ICredits(address(credits)));
        BatchFactory f = new BatchFactory(ICredits(address(credits)), new MockAssembler(st), address(0xFEE), 100, 10);
        for (uint256 i; i < 2; ++i) credits.mint(alice, 40);
        vm.startPrank(alice);
        credits.setApprovalForAll(address(f), true);
        uint256[] memory first = new uint256[](40);
        uint256[] memory rest = new uint256[](40);
        for (uint256 i; i < 40; ++i) {
            first[i] = i + 1;
            rest[i] = i + 41;
        }
        Batch b = Batch(f.create("Test", Batch.Filter(0, 0, 0, 0), 0, 0, 14 days, first));
        f.deposit(address(b), rest);
        vm.stopPrank();
        b.assemble();
        assertEq(st.ownerOf(1), address(b));
        assertEq(credits.balanceOf(address(b)), 0);
    }

    /// A trait filter accepts exactly the Credits the real art says match.
    function test_FilterUsesRealTraits() public {
        MockStatement st = new MockStatement(ICredits(address(credits)));
        BatchFactory f = new BatchFactory(ICredits(address(credits)), new MockAssembler(st), address(0xFEE), 100, 1);
        credits.mint(alice, 40);
        CreditArt art = credits.art();
        string memory want = art.describe(credits.seedOf(1), credits.timestampOf(1)).colors;
        Batch.Filter memory fl;
        fl.colors = keccak256(bytes(want));
        uint256[] memory one = new uint256[](1);
        one[0] = 1;
        vm.startPrank(alice);
        credits.setApprovalForAll(address(f), true);
        Batch b = Batch(f.create("Match", fl, 0, 0, 14 days, one));
        vm.stopPrank();
        for (uint256 id = 2; id <= 40; ++id) {
            bool same = keccak256(bytes(art.describe(credits.seedOf(id), credits.timestampOf(id)).colors))
                == keccak256(bytes(want));
            assertEq(b.passes(id), same);
        }
    }
}
