// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {IRatings} from "./Batch.sol";
import {ICredits} from "./interfaces/ICredits.sol";

/// @notice The Statements contract's scorer: a Credit's score from its seed and payment second, in
///         ten-thousandths (80.0000 → 800,000). Pure; it never changes.
interface ICreditScore {
    function scoreOf(bytes21 seed, uint64 paidAt) external pure returns (uint256);
}

/// @title LiveRatings
/// @notice Every Credit's score as the Statements contract computes it, worked out when asked rather than stored,
///         in the form batches read (×10, 80.0 → 800). The same number a Statement's Credit Rating adds up, cut to
///         tenths. Batches opened while it is the factory's table check their rating rules against it; each batch
///         keeps the table it opened with.
contract LiveRatings is IRatings {
    ICredits public immutable credits;
    ICreditScore public immutable scorer;
    uint256 public immutable count;
    string public constant version = "statements";

    error BadCount();

    /// @param count_ The edition's size, which the factory requires to match the table it replaces.
    constructor(ICredits credits_, ICreditScore scorer_, uint256 count_) {
        if (count_ == 0) revert BadCount();
        credits = credits_;
        scorer = scorer_;
        count = count_;
    }

    /// @notice Score ×10 for a Credit number (tenths, rounded down), or 0 for an unknown id.
    function scoreOf(uint256 id) public view returns (uint16) {
        if (id == 0 || id > count) return 0;
        return uint16(scorer.scoreOf(credits.seedOf(id), credits.timestampOf(id)) / 1000);
    }

    /// @notice Scores ×10 for several ids, in order.
    function scoresOf(uint256[] calldata ids) external view returns (uint16[] memory out) {
        out = new uint16[](ids.length);
        for (uint256 i; i < ids.length; ++i) out[i] = scoreOf(ids[i]);
    }
}
