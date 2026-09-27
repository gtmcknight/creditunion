// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {Ratings, DataStore} from "../../src/Ratings.sol";

/// @dev A three-Credit table: #1 = 80.0, #2 = 0x1234, #3 = 800.0, stored little-endian as the deployer writes it.
contract RatingsFormal is Test {
    Ratings internal ratings;
    address internal chunk;

    function setUp() public {
        chunk = DataStore.write(hex"2003" hex"3412" hex"401f");
        address[] memory c = new address[](1);
        c[0] = chunk;
        ratings = new Ratings(c, 3);
    }

    /// Unknown ids score 0, which Batch treats as "never admitted by a rating rule".
    function check_unknownIdScoresZero(uint256 id) public view {
        vm.assume(id == 0 || id > 3);
        assert(ratings.scoreOf(id) == 0);
    }

    /// Every known id reads back exactly the score stored for it. Halmos can't take a symbolic EXTCODECOPY
    /// offset, so the symbolic id is split into its three possible values before the read.
    function check_knownIdsReadExactly(uint256 id) public view {
        vm.assume(id >= 1 && id <= 3);
        uint256 k = id == 1 ? 1 : id == 2 ? 2 : 3;
        uint16 s = ratings.scoreOf(k);
        assert(k == 1 ? s == 800 : k == 2 ? s == 0x1234 : s == 8000);
    }

    /// The table can only be deployed with exactly the data it claims to cover (so no id maps past a chunk).
    function check_constructorRejectsWrongCount(uint256 n) public {
        address[] memory c = new address[](1);
        c[0] = chunk;
        try new Ratings(c, n) {
            assert(n == 3);
        } catch {}
    }
}
