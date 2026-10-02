// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {ERC721} from "@openzeppelin/contracts/token/ERC721/ERC721.sol";
import {ICredits} from "../interfaces/ICredits.sol";
import {IStatements} from "../interfaces/IStatements.sol";

/// NOT JACK'S STATEMENT CONTRACT. A test stand-in so the tests and testnets can run a burn end to end. Its
/// Statements are worthless test tokens; it is never deployed to mainnet. The adapter tests run against Jack's
/// real contract (test/utils/JackStatements.sol); this only keeps its call shape for testnets.
/// @notice Stand-in for Jack's Statements: burns 80 of the caller's Credits, mints one.
contract MockStatement is ERC721, IStatements {
    ICredits public immutable credits;
    uint256 public supply;

    constructor(ICredits credits_) ERC721("Statement", "STATEMENT") {
        credits = credits_;
    }

    mapping(uint256 => uint8) public formatOf;
    mapping(uint256 => uint32[80]) internal _from;

    /// @notice Jack's call shape: the caller's own 80, in cell order, one of his eight formats. Mints with `_mint`.
    function compose(uint256[80] calldata creditIds, uint8 format) external returns (uint256 id) {
        return _compose(creditIds, format, msg.sender);
    }

    /// @notice As compose, minting to `to`.
    function compose(uint256[80] calldata creditIds, uint8 format, address to) external returns (uint256 id) {
        return _compose(creditIds, format, to);
    }

    function _compose(uint256[80] calldata creditIds, uint8 format, address to) internal returns (uint256 id) {
        require(format < 8, "format");
        uint256[] memory ids = new uint256[](80);
        id = ++supply;
        for (uint256 i; i < 80; ++i) {
            ids[i] = creditIds[i];
            _from[id][i] = uint32(creditIds[i]);
        }
        credits.burn(msg.sender, ids);
        formatOf[id] = format;
        _mint(to, id);
    }

    function formatCount() external pure returns (uint256) {
        return 8;
    }

    function formatName(uint8 format) external pure returns (string memory) {
        string[8] memory names =
            ["Issued", "Consolidated", "Assessed", "Reconciled", "Accrued", "Amortized", "Liquidated", "Recorded"];
        return names[format];
    }

    function composedFrom(uint256 id) external view returns (uint32[80] memory) {
        return _from[id];
    }

    /// @notice For MockAssembler: burns the caller's 80, mints one.
    function make(uint256[] calldata ids) external virtual returns (uint256 id) {
        require(ids.length == 80, "need 80");
        credits.burn(msg.sender, ids);
        id = ++supply;
        _safeMint(msg.sender, id);
    }
}
