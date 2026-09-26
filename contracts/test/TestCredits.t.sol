// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {Batch, IRatings} from "../src/Batch.sol";
import {BatchFactory} from "../src/BatchFactory.sol";
import {MockAssembler} from "../src/mocks/MockAssembler.sol";
import {ICredits} from "../src/interfaces/ICredits.sol";
import {TestCredits} from "../src/mocks/TestCredits.sol";
import {MockStatement} from "../src/mocks/MockStatement.sol";
import {CreditArt} from "../src/vendor/credits/CreditArt.sol";
import {ready} from "./utils/Ready.sol";

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
        BatchFactory f = new BatchFactory(ICredits(address(credits)), IRatings(address(0)), new MockAssembler(st), address(0), address(0xFEE), 100, 0, 10);
        for (uint256 i; i < 2; ++i) credits.mint(alice, 40);
        vm.startPrank(alice);
        credits.setApprovalForAll(address(f), true);
        uint256[] memory first = new uint256[](40);
        uint256[] memory rest = new uint256[](40);
        for (uint256 i; i < 40; ++i) {
            first[i] = i + 1;
            rest[i] = i + 41;
        }
        Batch b = Batch(f.create("Test", Batch.Filter(0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0), new uint256[](0), 0, Batch.Arrangement.Deposit, Batch.Split.Equal, 14 days, first, 100, 0));
        f.deposit(address(b), rest);
        vm.stopPrank();
        ready(b);
        b.assemble();
        assertEq(st.ownerOf(1), address(b));
        assertEq(credits.balanceOf(address(b)), 0);
    }

    function _mask(string memory colors) internal pure returns (uint256 m) {
        bytes memory b = bytes(colors);
        for (uint256 i; i < b.length; ++i) {
            if (b[i] == "C") m |= 1;
            else if (b[i] == "M") m |= 2;
            else if (b[i] == "Y") m |= 4;
            else if (b[i] == "K") m |= 8;
        }
    }

    /// Sets: a filter accepting two palettes admits Credits of either and nothing else.
    function test_FilterAcceptsSets() public {
        MockStatement st = new MockStatement(ICredits(address(credits)));
        BatchFactory f = new BatchFactory(ICredits(address(credits)), IRatings(address(0)), new MockAssembler(st), address(0), address(0xFEE), 100, 0, 1);
        credits.mint(alice, 40);
        credits.mint(alice, 40);
        CreditArt art = credits.art();
        string memory a = art.describe(credits.seedOf(1), credits.timestampOf(1)).colors;
        uint256 second;
        for (uint256 id = 2; id <= 60 && second == 0; ++id) {
            if (_mask(art.describe(credits.seedOf(id), credits.timestampOf(id)).colors) != _mask(a)) second = id;
        }
        string memory b2 = art.describe(credits.seedOf(second), credits.timestampOf(second)).colors;
        Batch.Filter memory fl;
        fl.palettes = uint16((1 << _mask(a)) | (1 << _mask(b2)));
        uint256[] memory one = new uint256[](1);
        one[0] = 1;
        vm.startPrank(alice);
        credits.setApprovalForAll(address(f), true);
        Batch b = Batch(f.create("Two", fl, new uint256[](0), 0, Batch.Arrangement.Deposit, Batch.Split.Equal, 14 days, one, 100, 0));
        vm.stopPrank();
        for (uint256 id = 2; id <= 60; ++id) {
            uint256 m = _mask(art.describe(credits.seedOf(id), credits.timestampOf(id)).colors);
            assertEq(b.passes(id), m == _mask(a) || m == _mask(b2));
        }
        // prints and eights sets too: Registered or Nudge, and any Credit with no eights
        Batch.Filter memory g;
        g.prints = 3;
        g.eights = 1;
        uint256[] memory seed = _first(art);
        vm.prank(alice);
        Batch c = Batch(f.create("PE", g, new uint256[](0), 0, Batch.Arrangement.Deposit, Batch.Split.Equal, 14 days, seed, 100, 0));
        for (uint256 id = 2; id <= 60; ++id) {
            CreditArt.Read memory r = art.describe(credits.seedOf(id), credits.timestampOf(id));
            bool pr = keccak256(bytes(r.register)) == keccak256("Registered") || keccak256(bytes(r.register)) == keccak256("Nudge");
            assertEq(c.passes(id), pr && r.eights == 0);
        }
    }

    function _first(CreditArt art) internal view returns (uint256[] memory one) {
        one = new uint256[](1);
        for (uint256 id = 2; id <= 60; ++id) {
            CreditArt.Read memory r = art.describe(credits.seedOf(id), credits.timestampOf(id));
            bool pr = keccak256(bytes(r.register)) == keccak256("Registered") || keccak256(bytes(r.register)) == keccak256("Nudge");
            if (pr && r.eights == 0 && credits.ownerOf(id) == alice) {
                one[0] = id;
                return one;
            }
        }
        revert("no fit");
    }

    /// A trait filter accepts exactly the Credits the real art says match.
    function test_FilterUsesRealTraits() public {
        MockStatement st = new MockStatement(ICredits(address(credits)));
        BatchFactory f = new BatchFactory(ICredits(address(credits)), IRatings(address(0)), new MockAssembler(st), address(0), address(0xFEE), 100, 0, 1);
        credits.mint(alice, 40);
        CreditArt art = credits.art();
        string memory want = art.describe(credits.seedOf(1), credits.timestampOf(1)).colors;
        Batch.Filter memory fl;
        fl.palettes = uint16(1 << _mask(want));
        uint256[] memory one = new uint256[](1);
        one[0] = 1;
        vm.startPrank(alice);
        credits.setApprovalForAll(address(f), true);
        Batch b = Batch(f.create("Match", fl, new uint256[](0), 0, Batch.Arrangement.Deposit, Batch.Split.Equal, 14 days, one, 100, 0));
        vm.stopPrank();
        for (uint256 id = 2; id <= 40; ++id) {
            bool same = keccak256(bytes(art.describe(credits.seedOf(id), credits.timestampOf(id)).colors))
                == keccak256(bytes(want));
            assertEq(b.passes(id), same);
        }
    }

    /// Bits: a range on Jack's "Bits" (marks across active plates) admits exactly the Credits inside it,
    /// and a backwards range is rejected.
    function test_FilterOnBits() public {
        MockStatement st = new MockStatement(ICredits(address(credits)));
        BatchFactory f = new BatchFactory(ICredits(address(credits)), IRatings(address(0)), new MockAssembler(st), address(0), address(0xFEE), 100, 0, 1);
        credits.mint(alice, 40);
        CreditArt art = credits.art();
        uint256 m1 = art.describe(credits.seedOf(1), credits.timestampOf(1)).marks;
        Batch.Filter memory fl;
        fl.bitsFrom = uint16(m1 > 10 ? m1 - 10 : 0);
        fl.bitsTo = uint16(m1 + 10);
        uint256[] memory one = new uint256[](1);
        one[0] = 1;
        vm.startPrank(alice);
        credits.setApprovalForAll(address(f), true);
        Batch b = Batch(f.create("Bits", fl, new uint256[](0), 0, Batch.Arrangement.Deposit, Batch.Split.Equal, 14 days, one, 100, 0));
        uint256 inside;
        uint256 outside;
        for (uint256 id = 2; id <= 40; ++id) {
            uint256 m = art.describe(credits.seedOf(id), credits.timestampOf(id)).marks;
            bool want = m >= fl.bitsFrom && m <= fl.bitsTo;
            assertEq(b.passes(id), want);
            want ? ++inside : ++outside;
        }
        assertGt(inside + outside, 0);
        Batch.Filter memory bad;
        bad.bitsFrom = 100;
        bad.bitsTo = 50;
        vm.expectRevert(Batch.BadFilter.selector);
        f.create("Backwards", bad, new uint256[](0), 0, Batch.Arrangement.Deposit, Batch.Split.Equal, 14 days, _next(art), 100, 0);
        vm.stopPrank();
    }

    function _next(CreditArt) internal pure returns (uint256[] memory one) {
        one = new uint256[](1);
        one[0] = 2;
    }
}
