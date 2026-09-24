// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

/// @dev Shared, deterministic CMYK renderer. Coordinates use 20 units per hash pixel.
///      A half-pixel centering adjustment is exactly representable as 10 units.
library CreditDrawing {
    struct Buffer {
        bytes data;
        uint256 used;
        bytes scratch;
    }

    function put(Buffer memory out, string memory value) internal pure {
        bytes memory source = bytes(value);
        uint256 length = source.length;
        uint256 used = out.used;
        require(used + length <= out.data.length, "SVG capacity");
        bytes memory target = out.data;
        assembly ("memory-safe") {
            mcopy(add(add(target, 32), used), add(source, 32), length)
        }
        out.used = used + length;
    }

    function finish(Buffer memory out) internal pure returns (string memory) {
        bytes memory data = out.data;
        uint256 used = out.used;
        assembly ("memory-safe") { mstore(data, used) }
        return string(data);
    }

    // Fixed three-digit coordinates avoid thousands of temporary strings in a Statement.
    // SVG numbers allow leading zeros. All callers use coordinates/dimensions <= 320.
    function rect(Buffer memory out, uint256 x, uint256 y, uint256 w, uint256 h, uint24 color) internal pure {
        require(x < 1000 && y < 1000 && w < 1000 && h < 1000, "SVG coordinate");
        require(out.used + 64 <= out.data.length, "SVG capacity");
        bytes memory data = out.data;
        uint256 used = out.used;
        assembly ("memory-safe") {
            function decimal3(at, n) {
                mstore8(at, add(48, div(n, 100)))
                mstore8(add(at, 1), add(48, mod(div(n, 10), 10)))
                mstore8(add(at, 2), add(48, mod(n, 10)))
            }
            let at := add(add(data, 32), used)
            mstore(at, 0x3c7265637420783d223030302220793d22303030222077696474683d22303030)
            mstore(add(at, 32), 0x22206865696768743d22303030222066696c6c3d2223303030303030222f3e00)
            decimal3(add(at, 9), x)
            decimal3(add(at, 17), y)
            decimal3(add(at, 29), w)
            decimal3(add(at, 42), h)
            let hexits := "0123456789abcdef"
            for { let i := 0 } lt(i, 6) { i := add(i, 1) } {
                mstore8(add(add(at, 54), i), byte(and(shr(mul(sub(5, i), 4), color), 15), hexits))
            }
        }
        out.used = used + 63;
    }

    /// @notice Payment UTC Unix second selects one of the 15 nonempty CMYK masks.
    function platesAt(uint64 paidAt) internal pure returns (bool[4] memory enabled) {
        uint256 mask = uint256(paidAt) % 15 + 1;
        for (uint256 i; i < 4; ++i) {
            enabled[i] = mask & (1 << i) != 0;
        }
    }

    function eights(bytes21 seed) internal pure returns (uint256 n) {
        for (uint256 i; i < 21; ++i) {
            if (seed[i] == 0x38) ++n;
        }
    }

    function palette() internal pure returns (uint24[16] memory colors) {
        uint24[4] memory inks = [uint24(0x00B5E2), uint24(0xE4007C), uint24(0xFFD100), uint24(0x111111)];
        for (uint256 mask; mask < 16; ++mask) {
            uint256 r = 255;
            uint256 g = 255;
            uint256 b = 255;
            for (uint256 layer; layer < 4; ++layer) {
                if (mask & (1 << layer) == 0) continue;
                uint24 ink = inks[layer];
                r = (r * ((ink >> 16) & 255) + 127) / 255;
                g = (g * ((ink >> 8) & 255) + 127) / 255;
                b = (b * (ink & 255) + 127) / 255;
            }
            colors[mask] = uint24((r << 16) | (g << 8) | b);
        }
    }

    // Four 8x8 plates fit in a 12x12 raster even at the maximum two-pixel slip.
    function raster(bytes32 hash, int8[4] memory dx, int8[4] memory dy, bool[4] memory enabled)
        internal
        pure
        returns (bytes memory pixels)
    {
        pixels = new bytes(144);
        assembly ("memory-safe") {
            for { let layer := 0 } lt(layer, 4) { layer := add(layer, 1) } {
                if mload(add(enabled, mul(layer, 32))) {
                    let offsetX := add(2, mload(add(dx, mul(layer, 32))))
                    let offsetY := add(2, mload(add(dy, mul(layer, 32))))
                    for { let y := 0 } lt(y, 8) { y := add(y, 1) } {
                        for { let x := 0 } lt(x, 8) { x := add(x, 1) } {
                            let bitIndex := add(mul(layer, 64), add(mul(y, 8), x))
                            if and(shr(sub(255, bitIndex), hash), 1) {
                                let index := add(mul(add(y, offsetY), 12), add(x, offsetX))
                                let at := add(add(pixels, 32), index)
                                let word := mload(add(add(pixels, 32), and(index, not(31))))
                                mstore8(at, or(byte(and(index, 31), word), shl(layer, 1)))
                            }
                        }
                    }
                }
            }
        }
    }

    function paths(Buffer memory out, bytes memory pixels, int256 ox, int256 oy, uint24[16] memory colors)
        internal
        pure
    {
        // Reuse 16 scratch lanes across all 80 Credits; one raster pass groups paths.
        // A lane holds 144 * 19 bytes plus 32 bytes of safe word-store padding.
        bytes memory scratch = out.scratch;
        require(scratch.length >= 16 * 2768, "SVG scratch");
        uint256[16] memory lengths;
        assembly ("memory-safe") {
            function decimal3(at, n) {
                mstore8(at, add(48, div(n, 100)))
                mstore8(add(at, 1), add(48, mod(div(n, 10), 10)))
                mstore8(add(at, 2), add(48, mod(n, 10)))
            }
            for { let i := 0 } lt(i, 144) { i := add(i, 1) } {
                let mask := byte(and(i, 31), mload(add(add(pixels, 32), and(i, not(31)))))
                if mask {
                    let lengthAt := add(lengths, mul(mask, 32))
                    let used := mload(lengthAt)
                    let at := add(add(add(scratch, 32), mul(mask, 2768)), used)
                    mstore(at, "M000 000h20v20h-20z")
                    decimal3(add(at, 1), add(ox, mul(sub(mod(i, 12), 2), 20)))
                    decimal3(add(at, 5), add(oy, mul(sub(div(i, 12), 2), 20)))
                    mstore(lengthAt, add(used, 19))
                }
            }
        }
        for (uint256 mask = 1; mask < 16; ++mask) {
            uint256 length = lengths[mask];
            if (length == 0) continue;
            put(out, string.concat('<path fill="', hexColor(colors[mask]), '" d="'));
            require(out.used + length <= out.data.length, "SVG capacity");
            bytes memory data = out.data;
            uint256 used = out.used;
            assembly ("memory-safe") {
                mcopy(add(add(data, 32), used), add(add(scratch, 32), mul(mask, 2768)), length)
            }
            out.used = used + length;
            put(out, '"/>');
        }
    }

    function hexColor(uint24 color) internal pure returns (string memory) {
        bytes16 digits = "0123456789abcdef";
        bytes memory value = new bytes(7);
        value[0] = "#";
        for (uint256 i; i < 6; ++i) {
            value[i + 1] = digits[(color >> (4 * (5 - i))) & 15];
        }
        return string(value);
    }

    function center(bytes32 hash, int8[4] memory dx, int8[4] memory dy) internal pure returns (int256 ox, int256 oy) {
        bool[4] memory all = [true, true, true, true];
        bytes memory pixels = raster(hash, dx, dy, all);
        assembly ("memory-safe") {
            let minX := 12
            let minY := 12
            let maxX := 0
            let maxY := 0
            for { let i := 0 } lt(i, 144) { i := add(i, 1) } {
                if byte(and(i, 31), mload(add(add(pixels, 32), and(i, not(31))))) {
                    let x := mod(i, 12)
                    let y := div(i, 12)
                    if lt(x, minX) { minX := x }
                    if lt(y, minY) { minY := y }
                    if gt(add(x, 1), maxX) { maxX := add(x, 1) }
                    if gt(add(y, 1), maxY) { maxY := add(y, 1) }
                }
            }
            ox := 80
            oy := 80
            if lt(minX, 12) {
                ox := add(80, mul(sub(sub(12, minX), maxX), 10))
                oy := add(80, mul(sub(sub(12, minY), maxY), 10))
            }
        }
    }

    function body(Buffer memory out, bytes21 seed, bool[4] memory enabled, uint24[16] memory colors, bool compact)
        internal
        pure
    {
        bytes32 hash = sha256(abi.encodePacked(seed));
        (int8[4] memory dx, int8[4] memory dy) = slips(seed);
        int256 pad;
        for (uint256 i; i < 4; ++i) {
            int256 ax = dx[i] < 0 ? -int256(dx[i]) : int256(dx[i]);
            int256 ay = dy[i] < 0 ? -int256(dy[i]) : int256(dy[i]);
            if (ax > pad) pad = ax;
            if (ay > pad) pad = ay;
        }
        int256 ox = 80;
        int256 oy = 80;
        if (pad != 0) (ox, oy) = center(hash, dx, dy);
        uint256 count = eights(seed);
        put(out, string.concat('<rect width="320" height="320" fill="', count >= 5 ? "#111111" : "#ffffff", '"/>'));
        rect(out, uint256(ox), uint256(oy), 160, 160, 0xffffff);
        bytes memory pixels = raster(hash, dx, dy, enabled);
        if (compact) {
            paths(out, pixels, ox, oy, colors);
        } else {
            for (int256 y = -pad; y < 8 + pad; ++y) {
                for (int256 x = -pad; x < 8 + pad; ++x) {
                    uint256 mask = uint8(pixels[uint256((y + 2) * 12 + x + 2)]);
                    if (mask == 0) continue;
                    rect(out, uint256(ox + x * 20), uint256(oy + y * 20), 20, 20, colors[mask]);
                }
            }
        }
        uint256 n = count > 4 ? 4 : count;
        for (uint256 i; i < n; ++i) {
            rect(out, (16 - n + i) * 20, 300, 20, 20, colors[1 << (4 - n + i)]);
        }
    }

    function slips(bytes21 seed) internal pure returns (int8[4] memory dxs, int8[4] memory dys) {
        bytes32 h = sha256(abi.encodePacked(seed, "/misprint"));
        if (uint8(h[0]) >= 32) return (dxs, dys);

        uint8 dice = uint8(h[1]);
        uint256 maxStep = 1;
        uint256 movers = 1;
        bool kMoves = false;
        if (dice < 80) {
            movers = 1;
        } else if (dice < 160) {
            movers = 2;
        } else if (dice < 210) {
            movers = 3;
        } else if (dice < 240) {
            maxStep = 2;
            movers = 2 + (uint8(h[2]) % 2);
        } else {
            maxStep = 2;
            movers = 3 + (uint8(h[2]) % 2);
            kMoves = true;
        }

        uint8[4] memory pool;
        uint256 poolLen = kMoves ? 4 : 3;
        for (uint256 i; i < poolLen; ++i) {
            pool[i] = uint8(i);
        }

        uint256 cursor = 3;
        uint8[4] memory selected;
        uint256 chosen;
        while (chosen < movers && poolLen > 0) {
            uint256 idx = uint8(h[cursor++ % 32]) % poolLen;
            selected[chosen++] = pool[idx];
            // Match JavaScript splice: preserve the order of the remaining pool.
            for (uint256 j = idx; j + 1 < poolLen; ++j) {
                pool[j] = pool[j + 1];
            }
            --poolLen;
        }
        // All selections finish before offsets use the final cursor.
        for (uint256 i; i < chosen; ++i) {
            uint8 layer = selected[i];
            uint8 b = uint8(h[(layer + cursor) % 32]);
            uint8 c = uint8(h[(layer + cursor + 4) % 32]);
            int8 dx;
            int8 dy;
            if (maxStep == 1) {
                int8[8] memory ux = [int8(-1), int8(1), int8(0), int8(0), int8(-1), int8(-1), int8(1), int8(1)];
                int8[8] memory uy = [int8(0), int8(0), int8(-1), int8(1), int8(-1), int8(1), int8(-1), int8(1)];
                uint256 d = b % 8;
                dx = ux[d];
                dy = uy[d];
            } else {
                dx = int8(int256(uint256(b) % 5)) - 2;
                dy = int8(int256(uint256(c) % 5)) - 2;
                if (dx == 0 && dy == 0) dx = (b & 1) != 0 ? int8(2) : int8(-2);
            }
            dxs[layer] = dx;
            dys[layer] = dy;
        }
    }
}
