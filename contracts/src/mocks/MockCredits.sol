// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {ERC721} from "@openzeppelin/contracts/token/ERC721/ERC721.sol";
import {ICreditArt} from "../interfaces/ICredits.sol";

/// @notice Test stand-in for Credits: same burn rule (caller is owner or operator; all ids one owner).
contract MockCredits is ERC721 {
    MockArt public immutable art = new MockArt();
    bool public isSealed = true;
    uint256 public supply;
    mapping(uint256 => bytes21) public seedOf;
    mapping(uint256 => uint64) public timestampOf;
    mapping(address => uint256[]) private _owned;

    constructor() ERC721("Credits", "CREDIT") {}

    function mint(address to, uint256 n) external returns (uint256 first) {
        first = supply + 1;
        for (uint256 i; i < n; ++i) {
            uint256 id = ++supply;
            seedOf[id] = bytes21(keccak256(abi.encode(id)));
            timestampOf[id] = uint64(id);
            _mint(to, id);
        }
    }

    function burn(address owner_, uint256[] calldata ids) external returns (bytes21[] memory seeds) {
        require(msg.sender == owner_ || isApprovedForAll(owner_, msg.sender), "NotApproved");
        seeds = new bytes21[](ids.length);
        for (uint256 i; i < ids.length; ++i) {
            require(_ownerOf(ids[i]) == owner_, "NotOwner");
            seeds[i] = seedOf[ids[i]];
            _burn(ids[i]);
        }
    }

    /// @dev Unindexed, test only.
    function tokensOf(address owner_) external view returns (uint256[] memory out) {
        uint256 n = balanceOf(owner_);
        out = new uint256[](n);
        uint256 k;
        for (uint256 id = 1; id <= supply && k < n; ++id) {
            if (_ownerOf(id) == owner_) out[k++] = id;
        }
    }
}

/// @notice Traits by id parity so filters are testable: even ids are "CMY", odd are "K".
contract MockArt {
    /// @dev Placeholder art: an 8×8 grid from the seed, tinted by the mock Colors trait.
    function svg(bytes21 seed, uint64 paidAt) external pure returns (string memory out) {
        bytes32 h = keccak256(abi.encode(seed));
        string memory ink = paidAt % 2 == 0 ? "#00a0e0" : "#111";
        out = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 80 80"><rect width="80" height="80" fill="#fff"/>';
        for (uint256 i; i < 64; ++i) {
            if ((uint256(h) >> i) & 1 == 0) continue;
            out = string.concat(
                out,
                '<rect x="', _u(8 + (i % 8) * 8), '" y="', _u(8 + (i / 8) * 8), '" width="7" height="7" fill="', ink, '"/>'
            );
        }
        out = string.concat(out, "</svg>");
    }

    function _u(uint256 v) private pure returns (string memory) {
        if (v == 0) return "0";
        bytes memory b;
        while (v > 0) {
            b = abi.encodePacked(bytes1(uint8(48 + v % 10)), b);
            v /= 10;
        }
        return string(b);
    }

    function describe(bytes21, uint64 paidAt) external pure returns (ICreditArt.Read memory r) {
        r.colors = paidAt % 2 == 0 ? "CMY" : "K";
        r.eights = (paidAt / 2) % 3; // 0, 1 or 2, so Eights layouts are testable
        r.register = "Registered";
        r.weight = "even";
        r.eightsLabel = "0";
    }
}
