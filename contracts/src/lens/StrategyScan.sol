// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

/// @title StrategyScan
/// @notice Never deployed: the Worker runs its creation code in an eth_call. The constructor reads a Credit
///         strategy's nftForSale for ids from..to-1 and returns the ones for sale, each packed as
///         (id << 128) | price, so the strategy's whole book is a few calls with no indexer or event history.
contract StrategyScan {
    constructor(address strategy, uint256 from, uint256 to) {
        assembly {
            let out := mload(0x40)
            let n := 0
            mstore(0x00, shl(224, 0x90ba7a32)) // nftForSale(uint256)
            for { let id := from } lt(id, to) { id := add(id, 1) } {
                mstore(0x04, id)
                if staticcall(gas(), strategy, 0x00, 0x24, 0x40, 0x20) {
                    let price := mload(0x40)
                    if and(iszero(lt(returndatasize(), 0x20)), gt(price, 0)) {
                        n := add(n, 1)
                        mstore(add(out, add(0x40, mul(n, 0x20))), or(shl(128, id), and(price, 0xffffffffffffffffffffffffffffffff)))
                    }
                }
                mstore(0x40, out) // the call wrote over the free memory pointer; put it back
            }
            mstore(add(out, 0x20), 0x20)
            mstore(add(out, 0x40), n)
            return(add(out, 0x20), add(0x40, mul(n, 0x20)))
        }
    }
}
