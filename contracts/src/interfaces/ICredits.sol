// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {IERC721} from "@openzeppelin/contracts/token/ERC721/IERC721.sol";

/// @notice The parts of Jack Butcher's Credits (0x9763…3043) that Credit Union uses.
interface ICredits is IERC721 {
    function art() external view returns (ICreditArt);
    function seedOf(uint256 id) external view returns (bytes21);
    function timestampOf(uint256 id) external view returns (uint64);
    function isSealed() external view returns (bool);
    function tokensOf(address owner) external view returns (uint256[] memory);
    /// @dev Caller must be `owner` or an operator for it. Every id must belong to `owner`.
    function burn(address owner, uint256[] calldata ids) external returns (bytes21[] memory);
}

/// @notice Credits' art contract. `describe` is pure and returns the traits shown on OpenSea.
interface ICreditArt {
    struct Read {
        bytes32 hash;
        uint256 marks;
        uint256 capacity;
        uint256 plates;
        string colors; // "Colors", e.g. "CMY"
        uint256 eights;
        string tier;
        string weight; // "Weight"
        string register; // "Print"
        string eightsLabel; // "Eights"
    }

    function describe(bytes21 seed, uint64 paidAt) external pure returns (Read memory);
}
