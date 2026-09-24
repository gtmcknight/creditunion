// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {ERC721} from "@openzeppelin/contracts/token/ERC721/ERC721.sol";
import {CreditArt} from "../vendor/credits/CreditArt.sol";

/// @notice Testnet stand-in for Credits with the same interface and burn rule, and the real art contract,
///         so test Credits look and filter like real ones. Anyone can mint. Never deployed to mainnet.
contract TestCredits is ERC721 {
    uint256 public constant MAX_PER_MINT = 40;
    /// @dev Real Credits were paid for between these times; paidAt picks the plates and the printed time.
    uint64 constant WINDOW_START = 1789998000;
    uint64 constant WINDOW = 183000;
    bytes constant ALPHABET = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";

    CreditArt public immutable art;
    bool public constant isSealed = true;
    uint256 public supply;

    mapping(uint256 id => bytes21 seed) public seedOf;
    mapping(uint256 id => uint64 timestamp) public timestampOf;
    mapping(bytes21 seed => uint256 id) public tokenOf;
    mapping(address owner => uint256[] ids) private _owned;
    mapping(uint256 id => uint256 indexPlusOne) private _ownedAt;

    error TooMany();
    error NotOwner();
    error Duplicate();
    error EmptyBurn();
    error NotApproved();

    constructor() ERC721("Test Credits", "tCREDIT") {
        art = new CreditArt();
    }

    /// @notice Mint `n` (1–40) test Credits with random seeds and payment times.
    function mint(address to, uint256 n) external returns (uint256 first) {
        if (n == 0 || n > MAX_PER_MINT) revert TooMany();
        first = supply + 1;
        for (uint256 i; i < n; ++i) {
            uint256 id = ++supply;
            bytes32 r = keccak256(abi.encode(block.prevrandao, to, id));
            bytes21 seed = _seed(r);
            while (tokenOf[seed] != 0) seed = _seed(r = keccak256(abi.encode(r)));
            seedOf[id] = seed;
            timestampOf[id] = WINDOW_START + uint64(uint256(r >> 192) % WINDOW);
            tokenOf[seed] = id;
            _mint(to, id);
        }
    }

    function _seed(bytes32 r) private pure returns (bytes21 s) {
        bytes memory b = new bytes(21);
        for (uint256 i; i < 21; ++i) b[i] = ALPHABET[uint8(r[i]) % 62];
        s = bytes21(b);
    }

    /// @notice Same rule as Credits: caller is the owner or an operator, and every id belongs to `owner_`.
    function burn(address owner_, uint256[] calldata ids) external returns (bytes21[] memory seeds) {
        if (ids.length == 0) revert EmptyBurn();
        if (msg.sender != owner_ && !isApprovedForAll(owner_, msg.sender)) revert NotApproved();
        seeds = new bytes21[](ids.length);
        for (uint256 i; i < ids.length; ++i) {
            uint256 id = ids[i];
            for (uint256 j; j < i; ++j) {
                if (ids[j] == id) revert Duplicate();
            }
            if (_ownerOf(id) != owner_) revert NotOwner();
            seeds[i] = seedOf[id];
            _burn(id);
        }
    }

    function tokensOf(address owner_) external view returns (uint256[] memory) {
        return _owned[owner_];
    }

    function tokenURI(uint256 tokenId) public view override returns (string memory) {
        _requireOwned(tokenId);
        return art.tokenJSON(tokenId, seedOf[tokenId], timestampOf[tokenId]);
    }

    function _update(address to, uint256 tokenId, address auth) internal override returns (address from) {
        from = super._update(to, tokenId, auth);
        if (from != address(0)) _removeOwned(from, tokenId);
        if (to != address(0)) _addOwned(to, tokenId);
    }

    function _addOwned(address owner_, uint256 id) private {
        _owned[owner_].push(id);
        _ownedAt[id] = _owned[owner_].length;
    }

    function _removeOwned(address owner_, uint256 id) private {
        uint256 i = _ownedAt[id] - 1;
        uint256 last = _owned[owner_][_owned[owner_].length - 1];
        _owned[owner_][i] = last;
        _ownedAt[last] = i + 1;
        _owned[owner_].pop();
        delete _ownedAt[id];
    }
}
