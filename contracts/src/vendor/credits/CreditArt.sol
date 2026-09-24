// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Base64} from "@openzeppelin/contracts/utils/Base64.sol";
import {CreditDrawing} from "./CreditDrawing.sol";
import {Strings} from "@openzeppelin/contracts/utils/Strings.sol";

/// @notice One credit. SHA-256 of the payment id, four 8×8 plates, premultiplied.
///         Count of `8`s draws a trailing CMYK proof bar in the bottom-right corner;
///         5 or more also fills the ground black. The hash sits on an opaque white plate.
contract CreditArt {
    struct Read {
        bytes32 hash;
        uint256 marks;
        uint256 capacity;
        uint256 plates;
        string colors;
        uint256 eights;
        string tier;
        string weight;
        string register;
        string eightsLabel;
    }

    function valid(bytes21 seed) public pure returns (bool) {
        for (uint256 i; i < 21; ++i) {
            bytes1 c = seed[i];
            if (c >= 0x30 && c <= 0x39) continue;
            if (c >= 0x41 && c <= 0x5A) continue;
            if (c >= 0x61 && c <= 0x7A) continue;
            return false;
        }
        return true;
    }

    function hashOf(bytes21 seed) public pure returns (bytes32) {
        return sha256(abi.encodePacked(seed));
    }

    function describe(bytes21 seed, uint64 paidAt) public pure returns (Read memory) {
        return _read(seed, paidAt);
    }

    function svg(bytes21 seed, uint64 paidAt) public pure returns (string memory) {
        return _svg(seed, paidAt);
    }

    function tokenJSON(uint256 tokenId, bytes21 seed, uint64 paidAt) external pure returns (string memory) {
        Read memory piece = _read(seed, paidAt);
        string memory name = tokenId == 0
            ? string.concat(unicode"Credit · ", _ascii(seed))
            : string.concat("Credit #", Strings.toString(tokenId));
        string memory json = string.concat(
            '{"name":"',
            name,
            '","description":"Made from acts of trust.","image":"data:image/svg+xml;base64,',
            Base64.encode(bytes(_svg(seed, paidAt))),
            '","attributes":[{"trait_type":"Eights","value":"',
            _capitalized(piece.eightsLabel),
            '"},{"trait_type":"Weight","value":"',
            _capitalized(piece.weight),
            '"},{"trait_type":"Print","value":"',
            piece.register,
            '"},{"trait_type":"Bits","value":',
            Strings.toString(piece.marks),
            '},{"trait_type":"Plates","value":',
            Strings.toString(piece.plates),
            '},{"trait_type":"Colors","value":"',
            piece.colors,
            '"},{"trait_type":"Payment Time","value":"',
            _time(paidAt),
            '"},{"trait_type":"Seed","value":"',
            _ascii(seed),
            '"},{"trait_type":"SHA-256","value":"',
            _hexBytes(piece.hash),
            '"}]}'
        );
        return string.concat("data:application/json;base64,", Base64.encode(bytes(json)));
    }

    function _time(uint64 paidAt) private pure returns (string memory) {
        uint256 secondsOfDay = uint256(paidAt) % 86400;
        uint256 hours_ = secondsOfDay / 3600;
        uint256 minutes_ = (secondsOfDay / 60) % 60;
        uint256 seconds_ = secondsOfDay % 60;
        return string(abi.encodePacked(
            bytes1(uint8(48 + hours_ / 10)), bytes1(uint8(48 + hours_ % 10)), ":",
            bytes1(uint8(48 + minutes_ / 10)), bytes1(uint8(48 + minutes_ % 10)), ":",
            bytes1(uint8(48 + seconds_ / 10)), bytes1(uint8(48 + seconds_ % 10)), " UTC"
        ));
    }

    function _capitalized(string memory value) private pure returns (string memory) {
        bytes memory label = bytes(value);
        if (label.length > 0 && label[0] >= 0x61 && label[0] <= 0x7a) {
            label[0] = bytes1(uint8(label[0]) - 32);
        }
        return string(label);
    }

    function _read(bytes21 seed, uint64 paidAt) private pure returns (Read memory piece) {
        piece.hash = hashOf(seed);
        bool[4] memory enabled = CreditDrawing.platesAt(paidAt);
        bytes memory letters = "CMYK";
        bytes memory names;
        for (uint256 layer; layer < 4; ++layer) {
            if (!enabled[layer]) continue;
            ++piece.plates;
            names = abi.encodePacked(names, letters[layer]);
            for (uint256 bit; bit < 64; ++bit) {
                uint256 index = layer * 64 + bit;
                piece.marks += (uint8(piece.hash[index / 8]) >> (7 - index % 8)) & 1;
            }
        }
        piece.capacity = piece.plates * 64;
        piece.colors = string(names);
        piece.eights = _eights(seed);
        piece.eightsLabel = _eightsLabel(piece.eights);
        piece.tier = _tier(piece.eights);
        piece.weight = _weight(piece.marks, piece.capacity);
        piece.register = _register(seed);
    }

    function _svg(bytes21 seed, uint64 paidAt) private pure returns (string memory) {
        bool[4] memory enabled = CreditDrawing.platesAt(paidAt);
        return svgWithPlates(seed, enabled);
    }

    function svgWithPlates(bytes21 seed, bool[4] memory enabled) public pure returns (string memory) {
        CreditDrawing.Buffer memory out = CreditDrawing.Buffer(new bytes(16_000), 0, new bytes(0));
        CreditDrawing.put(
            out, '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 320 320" shape-rendering="crispEdges">'
        );
        CreditDrawing.body(out, seed, enabled, CreditDrawing.palette(), false);
        CreditDrawing.put(out, "</svg>");
        return CreditDrawing.finish(out);
    }

    function _eights(bytes21 seed) private pure returns (uint256 n) {
        for (uint256 i; i < 21; ++i) {
            if (seed[i] == 0x38) ++n;
        }
    }

    function _eightsLabel(uint256 n) private pure returns (string memory) {
        string[22] memory labels = ["none", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten", "eleven", "twelve", "thirteen", "fourteen", "fifteen", "sixteen", "seventeen", "eighteen", "nineteen", "twenty", "twenty-one"];
        return labels[n];
    }

    /// @dev Tier follows the count of 8s in the receipt. Bookends and triple runs do not promote.
    function _tier(uint256 eights) private pure returns (string memory) {
        if (eights >= 4) return "Hyper";
        if (eights == 3) return "Ultra";
        if (eights == 2) return "Rare";
        if (eights == 1) return "Uncommon";
        return "Common";
    }

    function _weight(uint256 marks, uint256 capacity) private pure returns (string memory) {
        if (marks * 256 >= 120 * capacity && marks * 256 <= 136 * capacity) return "even";
        if (marks * 256 >= 112 * capacity && marks * 256 <= 144 * capacity) return "lean";
        if (marks * 256 >= 96 * capacity && marks * 256 <= 160 * capacity) return "sparse";
        return "extreme";
    }

    function _register(bytes21 seed) private pure returns (string memory) {
        bytes32 h = sha256(abi.encodePacked(seed, "/misprint"));
        if (uint8(h[0]) >= 32) return "Registered";

        uint8 dice = uint8(h[1]);
        string memory label;
        if (dice < 80) label = "Nudge";
        else if (dice < 160) label = "Slip";
        else if (dice < 210) label = "Skew";
        else if (dice < 240) label = "Drift";
        else label = "Loose";

        return label;
    }

    function _slips(bytes21 seed) private pure returns (int8[4] memory dxs, int8[4] memory dys) {
        return CreditDrawing.slips(seed);
    }

    function _signed(int8 n) private pure returns (string memory) {
        if (n == 0) return "0";
        uint256 mag = uint256(uint8(n < 0 ? -n : n));
        string memory num = Strings.toString(mag);
        if (n > 0) return string.concat("+", num);
        return string.concat("-", num);
    }

    function _ascii(bytes21 seed) private pure returns (string memory) {
        bytes memory out = new bytes(21);
        for (uint256 i; i < 21; ++i) {
            out[i] = seed[i];
        }
        return string(out);
    }

    function _hexBytes(bytes32 data) private pure returns (string memory) {
        bytes16 hexits = "0123456789abcdef";
        bytes memory out = new bytes(64);
        for (uint256 i; i < 32; ++i) {
            out[i * 2] = hexits[uint8(data[i]) >> 4];
            out[i * 2 + 1] = hexits[uint8(data[i]) & 0x0f];
        }
        return string(out);
    }
}
