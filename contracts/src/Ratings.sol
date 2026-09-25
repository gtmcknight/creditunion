// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

/// @title Ratings
/// @notice Jack Butcher's official Credit rating (methodology v3.4.0) for every Credit, frozen onchain so a
///         batch can require a minimum score. Scores are stored ×10 (80.00 → 800, 800.00 → 8000) as
///         little-endian uint16s in data contracts (SSTORE2 style: a STOP byte then raw bytes), read with
///         EXTCODECOPY. Immutable: the edition is sealed and the rating is a pure function of it.
contract Ratings {
    uint256 public constant PER_CHUNK = 12_000; // ids per data contract (24 000 bytes)
    uint256 public immutable count;
    address[] internal _chunks;

    error BadChunk(uint256 index);

    /// @param chunks_ Data contracts in id order, each `0x00` + PER_CHUNK×2 bytes (the last may be shorter).
    constructor(address[] memory chunks_, uint256 count_) {
        for (uint256 i; i < chunks_.length; ++i) {
            uint256 need = i + 1 < chunks_.length ? PER_CHUNK * 2 + 1 : (count_ - i * PER_CHUNK) * 2 + 1;
            if (chunks_[i].code.length != need) revert BadChunk(i);
        }
        _chunks = chunks_;
        count = count_;
    }

    function chunks() external view returns (address[] memory) {
        return _chunks;
    }

    /// @notice Score ×10 for a Credit number, or 0 for an unknown id.
    function scoreOf(uint256 id) public view returns (uint16 s) {
        if (id == 0 || id > count) return 0;
        uint256 i = id - 1;
        address chunk = _chunks[i / PER_CHUNK];
        uint256 offset = 1 + (i % PER_CHUNK) * 2;
        assembly {
            let p := mload(0x40)
            extcodecopy(chunk, p, offset, 2)
            let w := mload(p)
            // little-endian uint16
            s := or(shr(248, w), shl(8, and(shr(240, w), 0xff)))
        }
    }

    /// @notice Scores ×10 for several ids, in order.
    function scoresOf(uint256[] calldata ids) external view returns (uint16[] memory out) {
        out = new uint16[](ids.length);
        for (uint256 i; i < ids.length; ++i) out[i] = scoreOf(ids[i]);
    }
}

/// @notice Deploys a data contract whose code is `0x00` followed by `data` (SSTORE2 pattern).
library DataStore {
    function write(bytes memory data) internal returns (address at) {
        // init code: 0x600B5981380380925939F3 copies everything after itself (the 0x00 + data) as runtime code
        bytes memory code = abi.encodePacked(hex"600B5981380380925939F3", hex"00", data);
        assembly {
            at := create(0, add(code, 32), mload(code))
        }
        require(at != address(0), "DataStore: create failed");
    }
}
