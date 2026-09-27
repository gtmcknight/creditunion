// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {IERC721} from "@openzeppelin/contracts/token/ERC721/IERC721.sol";
import {
    AdvancedOrder, CriteriaResolver, Execution, FulfillmentComponent, ItemType, ReceivedItem
} from "../../src/interfaces/ISeaport.sol";

/// @dev Minimal Seaport for the formal suite: each order sells its one ERC721 for its consideration items in
///      ETH (startAmount), paid to their recipients; an order whose offerer no longer holds the Credit is
///      skipped as unavailable; unspent ETH goes back to the caller. Same return shape as Seaport 1.6.
contract FormalSeaport {
    function fulfillAvailableAdvancedOrders(
        AdvancedOrder[] calldata orders,
        CriteriaResolver[] calldata,
        FulfillmentComponent[][] calldata,
        FulfillmentComponent[][] calldata,
        bytes32,
        address recipient,
        uint256
    ) external payable returns (bool[] memory available, Execution[] memory executions) {
        available = new bool[](orders.length);
        uint256 nc;
        for (uint256 i; i < orders.length; ++i) nc += orders[i].parameters.consideration.length;
        executions = new Execution[](nc + orders.length);
        uint256 k;
        uint256 spent;
        for (uint256 i; i < orders.length; ++i) {
            address seller = orders[i].parameters.offerer;
            IERC721 token = IERC721(orders[i].parameters.offer[0].token);
            uint256 id = orders[i].parameters.offer[0].identifierOrCriteria;
            if (token.ownerOf(id) != seller) continue;
            available[i] = true;
            token.transferFrom(seller, recipient, id);
            executions[k++].item = ReceivedItem(ItemType.ERC721, address(token), id, 1, payable(recipient));
            for (uint256 j; j < orders[i].parameters.consideration.length; ++j) {
                uint256 amt = orders[i].parameters.consideration[j].startAmount;
                address payable to = orders[i].parameters.consideration[j].recipient;
                spent += amt; // reverts (underflow below) if the caller sent too little
                (bool ok,) = to.call{value: amt}("");
                require(ok);
                executions[k++].item = ReceivedItem(ItemType.NATIVE, address(0), 0, amt, to);
            }
        }
        assembly {
            mstore(executions, k)
        }
        (bool back,) = msg.sender.call{value: msg.value - spent}("");
        require(back);
    }
}
