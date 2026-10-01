// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Batch} from "./Batch.sol";

/// @notice The factory's one answer this needs: whether an address is one of its Credit Unions.
interface IUnionFactory {
    function isBatch(address) external view returns (bool);
}

/// @title UnionFormats
/// @notice Each Credit Union's Statement format, picked by its creator before it burns: an index into the Statement
///         contract's format list (0 Issued, 1 Consolidated, 2 Assessed, 3 Reconciled, 4 Accrued, 5 Amortized,
///         6 Liquidated, 7 Recorded). The burn contract reads it when the union burns. With no pick, or a pick the
///         Statement contract doesn't have, a union burns in its default: Consolidated for a picture, Issued for
///         everything else.
///         The creator picks while every member can still leave: while the union fills, while it waits for burning
///         to open, or after a burn hour lapses unused. From the countdown on the pick is fixed, so nobody burns into
///         a format they didn't see. No owner, no admin; it holds nothing.
contract UnionFormats {
    IUnionFactory public immutable factory;

    /// Each union's pick + 1; 0 until its creator picks.
    mapping(address union => uint16) private _picked;

    event FormatPicked(address indexed union, uint8 format);

    error NotAUnion();
    error NotTheCreator();
    error FormatFixed(Batch.Phase phase);

    constructor(IUnionFactory factory_) {
        factory = factory_;
    }

    /// @notice The union's creator picks its format (see the contract notes for when).
    function pick(address union, uint8 format) external {
        if (!factory.isBatch(union)) revert NotAUnion();
        if (msg.sender != Batch(union).creator()) revert NotTheCreator();
        Batch.Phase p = Batch(union).phase();
        if (p != Batch.Phase.Open && p != Batch.Phase.Waiting && p != Batch.Phase.Expired) revert FormatFixed(p);
        _picked[union] = uint16(format) + 1;
        emit FormatPicked(union, format);
    }

    /// @notice The creator's pick; `picked` is false until there is one.
    function pickOf(address union) external view returns (bool picked, uint8 format) {
        uint16 v = _picked[union];
        if (v != 0) (picked, format) = (true, uint8(v - 1));
    }
}
