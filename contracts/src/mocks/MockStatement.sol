// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {ERC721} from "@openzeppelin/contracts/token/ERC721/ERC721.sol";
import {ICredits} from "../interfaces/ICredits.sol";

/// NOT JACK'S STATEMENT CONTRACT. A test stand-in so the tests and testnets can run a burn end to end. Its
/// Statements are worthless test tokens; it is never deployed to mainnet.
/// @notice Stand-in for Jack's Statement until it is published: burns 80 of the caller's Credits, mints one.
contract MockStatement is ERC721 {
    uint256 public constant CAP = 1526;
    ICredits public immutable credits;
    uint256 public totalSupply;

    constructor(ICredits credits_) ERC721("Statement", "STATEMENT") {
        credits = credits_;
    }

    function make(uint256[] calldata ids) external virtual returns (uint256 id) {
        require(ids.length == 80, "need 80");
        require(totalSupply < CAP, "cap");
        credits.burn(msg.sender, ids);
        id = ++totalSupply;
        _safeMint(msg.sender, id);
    }
}
