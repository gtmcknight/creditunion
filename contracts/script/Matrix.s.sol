// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Script, console} from "forge-std/Script.sol";
import {Batch, IRatings} from "../src/Batch.sol";
import {BatchFactory} from "../src/BatchFactory.sol";
import {IAssembler} from "../src/interfaces/IAssembler.sol";
import {ICredits, ICreditArt} from "../src/interfaces/ICredits.sol";
import {TestCredits} from "../src/mocks/TestCredits.sol";
import {Ratings} from "../src/Ratings.sol";
import {RatingsDeploy} from "./DeployRatings.s.sol";

/// @notice End-to-end test matrix on a fresh local anvil: every filter type, several combinations, every
///         arrangement, and painted layouts for every layout trait (open slots, fully painted, nearly full with
///         values used up). Filter values are picked from the minted Credits' real traits so every party has
///         Credits of the tester that fit and Credits that don't. Driven by web/scripts/e2e-matrix.mjs, which
///         runs both stages and then tests the real site against the parties (see the header there).
///
///         Stage 1 (`run`): deploy TestCredits (real CreditArt), the real rating table, a factory with no
///         assembler (parties never lock, so withdrawals always work) and minOpen 0; mint 400 Credits to the
///         tester (anvil account 0) and 400 to the party creator (account 1), interleaved 40 at a time.
///         Stage 2 (`parties(credits, factory)`): a separate run, because minted seeds depend on the block's
///         prevrandao and only exist once stage 1 has landed. Reads every Credit's traits back from the chain,
///         then opens the parties (account 1) and seeds some with the creator's Credits.
///
///   anvil --gas-limit 60000000 --port 8546
///   forge script script/Matrix.s.sol --rpc-url http://127.0.0.1:8546 --broadcast --slow
///   forge script script/Matrix.s.sol --rpc-url http://127.0.0.1:8546 --broadcast --slow \
///     --sig "parties(address,address)" $CREDITS $FACTORY
///   Each party is logged as `PARTY <address> <name>`; the name says what it tests.
contract Matrix is Script {
    uint256 constant K0 = 0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80; // tester
    uint256 constant K1 = 0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d; // party creator
    uint256 constant ROUNDS = 10; // 40 each per round

    function run() external {
        address a0 = vm.addr(K0);
        address a1 = vm.addr(K1);
        vm.startBroadcast(K0);
        TestCredits c = new TestCredits();
        Ratings r = RatingsDeploy.deploy(vm.readFileBinary("data/scores.bin"));
        BatchFactory f = new BatchFactory(ICredits(address(c)), IRatings(address(r)), IAssembler(address(0)), a0, a0, 200, 0, 0);
        for (uint256 i; i < ROUNDS; ++i) {
            c.mint(a0, 40);
            c.mint(a1, 40);
        }
        vm.stopBroadcast();
        vm.broadcast(K1);
        c.setApprovalForAll(address(f), true);
        console.log("CREDITS", address(c));
        console.log("FACTORY", address(f));
        console.log("RATINGS", address(r));
    }

    // ---------------------------------------------------------------- stage 2

    /// One Credit's traits as the batch reads them. key[t] is its slot value for layout trait t (Batch._keyOf).
    struct T {
        uint256 id;
        uint256 mask; // palette bit (C=1 M=2 Y=4 K=8)
        uint256 print; // 0..5
        uint256 weight; // 0..3
        uint256 eights;
        uint256 paid;
        uint256 marks;
        uint256 score;
        uint256[5] key;
    }

    BatchFactory f;
    T[] internal A; // the tester's
    T[] internal B; // the creator's
    mapping(uint256 => bool) internal spent; // creator Credits already put in a party

    function parties(address credits, address factory) external {
        f = BatchFactory(factory);
        ICredits c = ICredits(credits);
        IRatings ratings = f.ratings();
        _load(c, ratings, c.tokensOf(vm.addr(K0)), true);
        _load(c, ratings, c.tokensOf(vm.addr(K1)), false);

        Batch.Filter memory x;
        uint256[] memory none = new uint256[](0);

        // ---- no filter, and each filter type alone
        _make("M any", x, none, Batch.Arrangement.Deposit, 3);
        x = _empty();
        x.palettes = uint16(_pickSet(_hist(0)));
        _make("M palettes", x, none, Batch.Arrangement.Deposit, 2);
        x = _empty();
        x.eights = uint32(_pickSet(_hist(1)));
        _make("M eights", x, none, Batch.Arrangement.Deposit, 2);
        x = _empty();
        x.prints = uint8(_pickSet(_hist(2)));
        _make("M prints", x, none, Batch.Arrangement.Deposit, 2);
        x = _empty();
        x.weights = uint8(_pickSet(_hist(3)));
        _make("M weights", x, none, Batch.Arrangement.Deposit, 2);
        x = _empty();
        (x.paidFrom, x.paidTo) = (uint64(_pct(5, 30)), uint64(_pct(5, 70)));
        _make("M paid window", x, none, Batch.Arrangement.Deposit, 1);
        x = _empty();
        (x.idFrom, x.idTo) = (60, 260);
        _make("M id range", x, none, Batch.Arrangement.Deposit, 2);
        x = _empty();
        x.minScore = uint16(_pct(7, 50));
        _make("M min rating", x, none, Batch.Arrangement.Deposit, 1);
        x = _empty();
        x.maxScore = uint16(_pct(7, 50));
        _make("M max rating", x, none, Batch.Arrangement.Deposit, 1);
        x = _empty();
        (x.minScore, x.maxScore) = (uint16(_pct(7, 25)), uint16(_pct(7, 75)));
        _make("M rating range", x, none, Batch.Arrangement.Deposit, 1);
        x = _empty();
        uint256[] memory list = _list();
        _make("M allowlist", x, list, Batch.Arrangement.Deposit, 2);
        x = _empty();
        (x.bitsFrom, x.bitsTo) = (uint16(_pct(6, 30)), uint16(_pct(6, 70)));
        _make("M bits range", x, none, Batch.Arrangement.Deposit, 1);

        // ---- combinations
        x = _empty();
        x.palettes = uint16(_pickSet(_hist(0)));
        x.eights = uint32(_pickSet(_hist(1)));
        _make("M palettes+eights", x, none, Batch.Arrangement.Deposit, 1);
        x = _empty();
        x.prints = uint8(_wideSet(_hist(2)));
        x.weights = uint8(_wideSet(_hist(3)));
        x.minScore = uint16(_pct(7, 20));
        _make("M prints+weights+rating", x, none, Batch.Arrangement.Deposit, 1);
        x = _empty();
        (x.idFrom, x.idTo) = (60, 260);
        x.palettes = uint16(_wideSet(_hist(0)));
        _make("M id range+palettes", x, none, Batch.Arrangement.Deposit, 1);
        x = _empty();
        x.palettes = uint16(_wideSet(_hist(0)));
        _make("M allowlist+palettes", x, list, Batch.Arrangement.Deposit, 1);

        // ---- arrangements
        x = _empty();
        x.palettes = uint16(_wideSet(_hist(0)));
        _make("M by number", x, none, Batch.Arrangement.Number, 4);
        x = _empty();
        _make("M number desc, early", x, none, Batch.Arrangement.NumberDesc, 4);

        // ---- painted layouts, every trait: open slots, fully painted, nearly full with values used up
        string[5] memory tn = ["colors", "eights", "print", "weight", "plates"];
        for (uint8 t; t < 5; ++t) {
            _open(string.concat("L open ", tn[t]), t);
            _full(string.concat("L full ", tn[t]), t);
            _nearly(string.concat("L nearly ", tn[t]), t);
        }
        // ---- painted with rules on top
        _colorsWithPalettes();
        _printWithWeights();
    }

    // ---------------------------------------------------------------- painted parties

    /// 20 open slots. The tester's rarest value gets 8 slots more than the tester has of it (so the tester can't
    /// fill the sheet: capacity, not room, binds); the rest go to the commonest values first.
    function _open(string memory name, uint8 t) internal {
        uint256[16] memory n;
        uint256[16] memory h = _keyHist(t, true);
        uint256[] memory order = _desc(h, _top(t));
        uint256 rare = order[order.length - 1];
        n[rare] = h[rare] + 8 > 30 ? 30 : h[rare] + 8;
        uint256 left = 60 - n[rare];
        for (uint256 i; i + 1 < order.length && left > 0; ++i) {
            uint256 k = h[order[i]] / 3 + 1;
            if (k > left) k = left;
            n[order[i]] += k;
            left -= k;
        }
        n[order[0]] += left;
        _paint(name, t, n, _empty(), 3);
    }

    /// All 80 painted. The tester's rarest value gets none ("no slot on this sheet"), the next rarest 5 more slots
    /// than the tester has, the commonest about half of what the tester has.
    function _full(string memory name, uint8 t) internal {
        uint256[16] memory n;
        uint256[16] memory h = _keyHist(t, true);
        uint256[] memory order = _desc(h, _top(t));
        uint256 left = 80;
        uint256 len = order.length;
        if (len == 1) {
            n[order[0]] = 40;
            n[order[0] == 1 ? 2 : 1] = 40;
        } else {
            uint256 last = len - 1; // order[last] stays unpainted
            if (len >= 3) {
                --last;
                n[order[last]] = h[order[last]] + 5 > 30 ? 30 : h[order[last]] + 5;
                left -= n[order[last]];
            }
            for (uint256 i; i < last && left > 0; ++i) {
                uint256 k = h[order[i]] / 2 + 1;
                if (k > left) k = left;
                n[order[i]] += k;
                left -= k;
            }
            n[order[0]] += left;
        }
        _paint(name, t, n, _empty(), 2);
    }

    /// 6 open slots. The creator fills the commonest value of theirs plus every open slot, so that value is used
    /// up; a second value is left with 2 slots.
    function _nearly(string memory name, uint8 t) internal {
        uint256[16] memory n;
        uint256[16] memory hb = _keyHist(t, false);
        uint256[16] memory ha = _keyHist(t, true);
        uint256 top = _top(t);
        uint256[] memory ob = _desc(hb, top);
        uint256 X = ob[0];
        uint256 sx = hb[X] > 36 ? 30 : hb[X] > 7 ? hb[X] - 6 : 1;
        n[X] = sx;
        uint256 left = 74 - sx;
        uint256[] memory oa = _desc(ha, top);
        uint256 Y;
        for (uint256 i; i < oa.length && left > 0; ++i) {
            if (oa[i] == X) continue;
            if (Y == 0) Y = oa[i];
            uint256 k = ha[oa[i]] / 2 + 1;
            if (k > left) k = left;
            n[oa[i]] += k;
            left -= k;
        }
        if (Y == 0) Y = X == 1 ? 2 : 1; // the tester has nothing but X: paint an absent value
        n[Y] += left;
        address bt = _paint(name, t, n, _empty(), 0);
        // Creator: all of X it can place (its slots, then the open ones), then Y up to 2 short.
        uint256[] memory ids = new uint256[](B.length);
        uint256 m;
        uint256 wantX = sx + 6;
        uint256 wantY = n[Y] > 2 ? n[Y] - 2 : 0;
        for (uint256 i; i < B.length; ++i) {
            uint256 k = B[i].key[t];
            if (spent[B[i].id]) continue;
            if (k == X && wantX > 0) {
                ids[m++] = B[i].id;
                --wantX;
            } else if (k == Y && wantY > 0) {
                ids[m++] = B[i].id;
                --wantY;
            }
        }
        _deposit(bt, ids, m);
        console.log("  nearly: X", X, sx);
        console.log("  nearly: Y", Y, n[Y]);
    }

    /// Colors layout under a palette rule: only masks the rule admits are painted, plus 10 open slots.
    function _colorsWithPalettes() internal {
        Batch.Filter memory x = _empty();
        uint256 p = _wideSet(_hist(0));
        x.palettes = uint16(p);
        uint256[16] memory h = _keyHist(0, true);
        uint256[16] memory n;
        uint256 left = 70;
        uint256[] memory order = _desc(h, 15);
        uint256 first;
        for (uint256 i; i < order.length && left > 0; ++i) {
            if ((p >> order[i]) & 1 == 0) continue;
            if (first == 0) first = order[i];
            uint256 k = h[order[i]] / 2 + 1;
            if (k > left) k = left;
            n[order[i]] += k;
            left -= k;
        }
        n[first] += left;
        _paint("L colors+palettes", 0, n, x, 2);
    }

    /// Print layout under a weight rule (which doesn't touch print values), 10 open slots.
    function _printWithWeights() internal {
        Batch.Filter memory x = _empty();
        x.weights = uint8(_wideSet(_hist(3)));
        uint256[16] memory h = _keyHist(2, true);
        uint256[16] memory n;
        uint256 left = 70;
        uint256[] memory order = _desc(h, 6);
        for (uint256 i; i < order.length && left > 0; ++i) {
            uint256 k = h[order[i]] / 4 + 1;
            if (k > left) k = left;
            n[order[i]] += k;
            left -= k;
        }
        n[order[0]] += left;
        _paint("L print+weights", 2, n, x, 2);
    }

    /// Lays `n[v]` slots of each value in order (open slots last) and opens the party.
    function _paint(string memory name, uint8 t, uint256[16] memory n, Batch.Filter memory x, uint256 seed)
        internal
        returns (address)
    {
        uint256 i;
        for (uint256 v = 1; v < 16; ++v) {
            for (uint256 k; k < n[v]; ++k) {
                if (i < 64) x.layout0 |= v << (4 * i);
                else x.layout1 |= uint64(v << (4 * (i - 64)));
                ++i;
            }
        }
        require(i <= 80, "overpainted");
        x.layoutTrait = t;
        return _make(name, x, new uint256[](0), Batch.Arrangement.Layout, seed);
    }

    // ---------------------------------------------------------------- helpers

    function _empty() internal pure returns (Batch.Filter memory x) {}

    /// Opens a party as the creator and seeds it with the first `seed` of the creator's Credits that land.
    function _make(string memory name, Batch.Filter memory x, uint256[] memory list, Batch.Arrangement arr, uint256 seed)
        internal
        returns (address bt)
    {
        vm.broadcast(K1);
        bt = f.create(name, x, list, 0, arr, arr == Batch.Arrangement.NumberDesc ? Batch.Split.Early : Batch.Split.Equal, 30 days, new uint256[](0), 200, 0);
        console.log("PARTY", bt, name);
        if (seed == 0) return bt;
        // Candidates: the next 120 unspent (canTake reads the art twice per Credit; all 400 would pass 60M gas).
        uint256[] memory all = new uint256[](120);
        uint256 n;
        for (uint256 i; i < B.length && n < 120; ++i) if (!spent[B[i].id]) all[n++] = B[i].id;
        assembly {
            mstore(all, n)
        }
        bool[] memory ok = Batch(bt).canTake(all);
        uint256[] memory ids = new uint256[](seed);
        uint256 m;
        for (uint256 i; i < n && m < seed; ++i) if (ok[i]) ids[m++] = all[i];
        _deposit(bt, ids, m);
    }

    function _deposit(address bt, uint256[] memory ids, uint256 m) internal {
        for (uint256 i; i < m; i += 20) {
            uint256 len = m - i < 20 ? m - i : 20;
            uint256[] memory chunk = new uint256[](len);
            for (uint256 j; j < len; ++j) {
                chunk[j] = ids[i + j];
                spent[chunk[j]] = true;
            }
            vm.broadcast(K1);
            f.deposit(bt, chunk);
        }
    }

    function _load(ICredits c, IRatings ratings, uint256[] memory ids, bool tester) internal {
        ICreditArt art = c.art();
        for (uint256 i; i < ids.length; ++i) {
            ICreditArt.Read memory r = art.describe(c.seedOf(ids[i]), c.timestampOf(ids[i]));
            T memory t;
            t.id = ids[i];
            t.mask = _mask(r.colors);
            t.print = _index(r.register, 0);
            t.weight = _index(r.weight, 1);
            t.eights = r.eights;
            t.paid = c.timestampOf(ids[i]);
            t.marks = r.marks;
            t.score = ratings.scoreOf(ids[i]);
            t.key = [t.mask, r.eights < 14 ? r.eights + 1 : 15, t.print + 1, t.weight + 1, bytes(r.colors).length];
            if (tester) A.push(t);
            else B.push(t);
        }
    }

    function _mask(string memory colors) internal pure returns (uint256 m) {
        bytes memory b = bytes(colors);
        for (uint256 i; i < b.length; ++i) {
            if (b[i] == "C") m |= 1;
            else if (b[i] == "M") m |= 2;
            else if (b[i] == "Y") m |= 4;
            else if (b[i] == "K") m |= 8;
        }
    }

    function _index(string memory v, uint256 which) internal pure returns (uint256) {
        bytes32 h = keccak256(bytes(v));
        string[6] memory prints = ["Registered", "Nudge", "Slip", "Skew", "Drift", "Loose"];
        string[6] memory weights = ["even", "lean", "sparse", "extreme", "", ""];
        for (uint256 i; i < 6; ++i) {
            if (keccak256(bytes(which == 0 ? prints[i] : weights[i])) == h) return i;
        }
        revert("unknown trait value");
    }

    /// Histogram of the tester's Credits: 0 palette mask, 1 eights, 2 print, 3 weight (as filter bit indexes).
    function _hist(uint256 kind) internal view returns (uint256[32] memory h) {
        for (uint256 i; i < A.length; ++i) {
            T storage t = A[i];
            uint256 v = kind == 0 ? t.mask : kind == 1 ? t.eights : kind == 2 ? t.print : t.weight;
            if (v < 32) ++h[v];
        }
    }

    /// Slot values for layout trait `t` over the tester's (or the creator's) Credits.
    function _keyHist(uint8 t, bool tester) internal view returns (uint256[16] memory h) {
        T[] storage s = tester ? A : B;
        for (uint256 i; i < s.length; ++i) ++h[s[i].key[t]];
    }

    function _top(uint8 t) internal pure returns (uint256) {
        return t == 0 ? 15 : t == 1 || t == 2 ? 6 : 4;
    }

    /// Values 1..top present in `h`, commonest first.
    function _desc(uint256[16] memory h, uint256 top) internal pure returns (uint256[] memory out) {
        uint256 n;
        for (uint256 v = 1; v <= top; ++v) if (h[v] > 0) ++n;
        out = new uint256[](n);
        uint256 k;
        for (uint256 v = 1; v <= top; ++v) if (h[v] > 0) out[k++] = v;
        for (uint256 i = 1; i < n; ++i) {
            for (uint256 j = i; j > 0 && h[out[j]] > h[out[j - 1]]; --j) (out[j], out[j - 1]) = (out[j - 1], out[j]);
        }
    }

    /// A value set that admits roughly 40% of the tester's Credits and never all of them: commonest values first,
    /// or everything but a dominant value.
    function _pickSet(uint256[32] memory h) internal view returns (uint256 set) {
        return _coverSet(h, (A.length * 40) / 100);
    }

    /// Same, wider (about 70%), for rules that are combined with others.
    function _wideSet(uint256[32] memory h) internal view returns (uint256 set) {
        return _coverSet(h, (A.length * 70) / 100);
    }

    function _coverSet(uint256[32] memory h, uint256 want) internal view returns (uint256 set) {
        uint256 present;
        uint256 top;
        uint256 topV;
        for (uint256 v; v < 32; ++v) {
            if (h[v] == 0) continue;
            ++present;
            if (h[v] > top) (top, topV) = (h[v], v);
        }
        require(present > 1, "trait has one value");
        if (top * 100 > A.length * 85) {
            for (uint256 v; v < 32; ++v) if (h[v] > 0 && v != topV) set |= 1 << v;
            return set;
        }
        uint256 covered;
        uint256 used;
        while (covered < want && used + 1 < present) {
            uint256 best;
            uint256 bestV;
            for (uint256 v; v < 32; ++v) {
                if (h[v] > best && (set >> v) & 1 == 0) (best, bestV) = (h[v], v);
            }
            set |= 1 << bestV;
            covered += best;
            ++used;
        }
    }

    /// The q-th percentile of the tester's 5 paid time, 6 marks, 7 rating (nonzero ratings only).
    function _pct(uint256 kind, uint256 q) internal view returns (uint256) {
        uint256[] memory v = new uint256[](A.length);
        uint256 n;
        for (uint256 i; i < A.length; ++i) {
            uint256 x = kind == 5 ? A[i].paid : kind == 6 ? A[i].marks : A[i].score;
            if (kind == 7 && x == 0) continue;
            v[n++] = x;
        }
        for (uint256 i = 1; i < n; ++i) {
            for (uint256 j = i; j > 0 && v[j] < v[j - 1]; --j) (v[j], v[j - 1]) = (v[j - 1], v[j]);
        }
        uint256 r = v[(n * q) / 100];
        return r == 0 ? 1 : r;
    }

    /// 100 named Credits: every other one of the tester's first 160, and 20 of the creator's.
    function _list() internal view returns (uint256[] memory l) {
        l = new uint256[](100);
        for (uint256 i; i < 80; ++i) l[i] = A[2 * i].id;
        for (uint256 i; i < 20; ++i) l[80 + i] = B[i].id;
    }
}
