// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {ERC721} from "@openzeppelin/contracts/token/ERC721/ERC721.sol";
import {ICredits} from "../interfaces/ICredits.sol";
import {IStatements} from "../interfaces/IStatements.sol";

/// NOT JACK'S STATEMENT CONTRACT. A test stand-in so the tests and testnets can run a burn end to end. Its
/// Statements are worthless test tokens; it is never deployed to mainnet.
/// @notice Stand-in for Jack's Statement until it is published: burns 80 of the caller's Credits, mints one.
contract MockStatement is ERC721, IStatements {
    uint256 public constant CAP = 1526;
    ICredits public immutable credits;
    uint256 public totalSupply;

    constructor(ICredits credits_) ERC721("Statement", "STATEMENT") {
        credits = credits_;
    }

    /// @notice When composing opens; 0 means now. Jack's opens Oct 2 2026 00:00 UTC. Tests move it.
    uint256 public opensAt;
    /// @notice Each Statement's direction and the order its 80 were burned in, as Jack's contract would keep them.
    mapping(uint256 => uint8) public directionOf;
    mapping(uint256 => uint256[]) internal _order;

    function setOpensAt(uint256 t) external {
        opensAt = t;
    }

    /// @notice Our guess of Jack's call (IStatements), for StatementAdapter: burns the caller's 80, mints it one.
    function compose(uint256[] calldata ids, uint8 direction) external returns (uint256 id) {
        require(block.timestamp >= opensAt, "not open");
        require(direction < 4, "direction");
        require(ids.length == 80, "need 80");
        require(totalSupply < CAP, "cap");
        credits.burn(msg.sender, ids);
        id = ++totalSupply;
        directionOf[id] = direction;
        _order[id] = ids;
        _safeMint(msg.sender, id);
    }

    function orderOf(uint256 id) external view returns (uint256[] memory) {
        return _order[id];
    }

    function make(uint256[] calldata ids) external virtual returns (uint256 id) {
        require(ids.length == 80, "need 80");
        require(totalSupply < CAP, "cap");
        credits.burn(msg.sender, ids);
        id = ++totalSupply;
        _safeMint(msg.sender, id);
    }
}
