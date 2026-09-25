// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Script, console} from "forge-std/Script.sol";
import {Ratings} from "../src/Ratings.sol";
import {ICredits} from "../src/interfaces/ICredits.sol";

/// @notice Post-deploy check: the onchain score table is byte-for-byte `data/scores.bin`, and it covers
///         exactly the sealed edition. Read-only; run with `--sig "run(address,address)" $RATINGS $CREDITS`.
contract CheckRatings is Script {
    function run(Ratings ratings, ICredits credits) external view {
        bytes memory want = vm.readFileBinary("data/scores.bin");
        address[] memory chunks = ratings.chunks();
        bytes memory got;
        for (uint256 i; i < chunks.length; ++i) {
            bytes memory code = chunks[i].code;
            require(code.length > 1 && code[0] == 0x00, "chunk: bad prefix");
            bytes memory body = new bytes(code.length - 1);
            for (uint256 j; j < body.length; ++j) body[j] = code[j + 1];
            got = bytes.concat(got, body);
        }
        require(keccak256(got) == keccak256(want), "table differs from data/scores.bin");
        require(ratings.count() * 2 == want.length, "count != table size");
        require(credits.isSealed(), "Credits not sealed");
        (bool ok, bytes memory r) = address(credits).staticcall(abi.encodeWithSignature("totalSupply()"));
        if (ok && r.length == 32) require(abi.decode(r, (uint256)) == ratings.count(), "count != Credits.totalSupply()");
        require(ratings.scoreOf(11469) == 8000, "#11469 should be 800.0");
        console.log("OK: %s chunks, %s ids, table matches data/scores.bin", chunks.length, ratings.count());
    }
}
