// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {IERC721Receiver} from "@openzeppelin/contracts/token/ERC721/IERC721Receiver.sol";
import {IAssembler} from "./interfaces/IAssembler.sol";
import {ICredits} from "./interfaces/ICredits.sol";
import {MockStatement} from "./mocks/MockStatement.sol";

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

    /// @dev Sorts for the MintTime and Number arrangements; Deposit and Creator orders pass through.
    function assemble(uint256[] calldata ids, uint8 arrangement) external returns (uint256 id) {
        uint256[] memory order = ids;
        if (arrangement == 1 || arrangement == 2) {
            uint256[] memory key = new uint256[](order.length);
            for (uint256 i; i < order.length; ++i) key[i] = arrangement == 1 ? credits.timestampOf(order[i]) : order[i];
            for (uint256 i = 1; i < order.length; ++i) {
                // insertion sort; n is 80
                uint256 k = key[i];
                uint256 v = order[i];
                uint256 j = i;
                while (j > 0 && (key[j - 1] > k || (key[j - 1] == k && order[j - 1] > v))) {
                    key[j] = key[j - 1];
                    order[j] = order[j - 1];
                    --j;
                }
                key[j] = k;
                order[j] = v;
            }
        }
        for (uint256 i; i < order.length; ++i) credits.transferFrom(msg.sender, address(this), order[i]);
        id = target.make(order);
        target.transferFrom(address(this), msg.sender, id);
    }

    function onERC721Received(address, address, uint256, bytes calldata) external pure returns (bytes4) {
        return this.onERC721Received.selector;
    }
}
