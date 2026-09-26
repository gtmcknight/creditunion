// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {IERC721Receiver} from "@openzeppelin/contracts/token/ERC721/IERC721Receiver.sol";
import {IAssembler} from "../interfaces/IAssembler.sol";
import {ICredits} from "../interfaces/ICredits.sol";
import {MockStatement} from "./MockStatement.sol";

/// @notice Testnet adapter for MockStatement. Models the worst case for the mainnet adapter: the
///         Statement contract insists that its caller owns the Credits, so the adapter pulls them from
///         the Batch (which approved it as operator), mints, and hands the Statement back.
///         Stateless apart from immutables; anyone may call it, but it can only move the caller's Credits.
contract MockAssembler is IAssembler, IERC721Receiver {
    MockStatement public immutable target;
    ICredits public immutable credits;

    constructor(MockStatement target_) {
        target = target_;
        credits = target_.credits();
        credits.setApprovalForAll(address(target_), true); // lets the Statement contract burn what we hold
    }

    function statement() external view returns (address) {
        return address(target);
    }

    /// @dev Burns `ids` in the order given; the Batch has already decided it (Batch.burnOrder()).
    function assemble(uint256[] calldata ids, uint8) external returns (uint256 id) {
        for (uint256 i; i < ids.length; ++i) credits.transferFrom(msg.sender, address(this), ids[i]);
        id = target.make(ids);
        target.transferFrom(address(this), msg.sender, id);
    }

    function onERC721Received(address, address, uint256, bytes calldata) external pure returns (bytes4) {
        return this.onERC721Received.selector;
    }
}
