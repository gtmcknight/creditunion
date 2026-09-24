// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {IAssembler} from "./interfaces/IAssembler.sol";
import {ICredits} from "./interfaces/ICredits.sol";
import {MockStatement} from "./mocks/MockStatement.sol";

/// @notice Testnet assembler for MockStatement. Stateless; runs by delegatecall from a Batch.
///         Replaced by the Jack Statement assembler for mainnet.
/// @dev Credits.burn only accepts the owner or an operator as caller, so the Batch approves the
///      Statement contract for exactly this call and revokes it after.
contract MockAssembler is IAssembler {
    MockStatement public immutable target;

    constructor(MockStatement target_) {
        target = target_;
    }

    function assemble(address credits, uint256[] calldata ids) external returns (address, uint256) {
        ICredits(credits).setApprovalForAll(address(target), true);
        uint256 id = target.make(ids);
        ICredits(credits).setApprovalForAll(address(target), false);
        return (address(target), id);
    }
}
