// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {Ratings} from "../src/Ratings.sol";
import {RatingsDeploy} from "../script/DeployRatings.s.sol";

contract RatingsTest is Test {
    Ratings r;

    function setUp() public {
        r = RatingsDeploy.deploy(vm.readFileBinary("data/scores.bin"));
    }

    /// Values verified against jack.art's rating API (score ×10).
    function test_KnownScores() public view {
        assertEq(r.count(), 122154);
        assertEq(r.scoreOf(1), 1322); // 132.24
        assertEq(r.scoreOf(11469), 8000); // rank 1
        assertEq(r.scoreOf(96844), 1256); // 125.58
        assertEq(r.scoreOf(122154), 6771); // 677.05 rounds to 677.1
    }

    function test_ChunkBoundariesAndRange() public view {
        assertGt(r.scoreOf(12000), 799);
        assertGt(r.scoreOf(12001), 799);
        assertGt(r.scoreOf(24000), 799);
        assertGt(r.scoreOf(24001), 799);
        assertEq(r.scoreOf(0), 0);
        assertEq(r.scoreOf(122155), 0);
        assertEq(r.chunks().length, 11);
    }

    function test_BatchRead() public view {
        uint256[] memory ids = new uint256[](3);
        ids[0] = 1;
        ids[1] = 11469;
        ids[2] = 96844;
        uint16[] memory s = r.scoresOf(ids);
        assertEq(s[0], 1322);
        assertEq(s[1], 8000);
        assertEq(s[2], 1256);
    }
}
