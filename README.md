# DETH - A Global ETH Sink and Burn Attestation Registry
```
///////////////////////////////////////
//                                   //  
//    (                         )    //
//   )\ )           *   )   ( /(     //
//   (()/(    (    ` )  /(   )\())   //
//    /(_))   )\    ( )(_)) ((_)\    //
//   (_))_   ((_)  (_(_())   _((_)   //
//    |   \  | __| |_   _|  | || |   //
//    | |) | | _|    | |    | __ |   //
//    |___/  |___|   |_|    |_||_|   //
//                                   //
///////////////////////////////////////
```
## 🚀 Overview

Burning ETH in exchange for assets or other utilities - such as NFTs, governance rights or exclusive memberships - is becoming an increasingly popular concept in the Ethereum ecosystem due to their contribution to Ethereum's deflationary mechanism and ETH's value accrual.

DETH was created to serve as a **global ETH sink and burn attestation registry**, eliminating the need for each application to implement its own burn-tracking mechanism. ETH sent to the DETH contract is permanently locked and a verifiable **proof of burn** is issued to the sender or designated recipient in the form of **non-transferrable DETH credits**, minted at a 1:1 ratio.

These attestations can be used in sybil resistance systems, reward distributions (e.g., airdrops), governance, and other innovations.

## 🔥 Usage

The example below demonstrates a real-world use case where a user burns ETH to mint an NFT. Since the burn is recorded in the DETH contract, other projects can later use these attestations for airdrop allocations, governance weight, or exclusive access.

```solidity
// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import "@openzeppelin/contracts/token/ERC721/ERC721.sol";
import "../IDETH.sol";

/**
 * @title BurnerNFT
 * @notice A simple NFT contract that demonstrates DETH integration.
 * Users burn ETH through DETH to mint NFTs.
 */
contract BurnerNFT is ERC721 {
    IDETH public immutable deth;
    uint256 public nextTokenId;
    uint256 public constant MINT_PRICE = 0.1 ether;

    constructor(address _deth) ERC721("BurnerNFT", "BNFT") {
        deth = IDETH(_deth);
    }

    /**
     * @notice Mints an NFT by burning ETH through DETH
     * @dev The caller must send exactly MINT_PRICE ETH
     */
    function mint() external payable {
        require(msg.value == MINT_PRICE, "Wrong ETH amount");
        
        // Burn ETH and credit DETH to the minter
        deth.burn{value: msg.value}(msg.sender);
        
        // Mint the NFT
        _mint(msg.sender, nextTokenId++);
    }
}
```

## 🔗 Address

The DETH contract is deployed on Ethereum at the following address: [0xE46861C9f28c46F27949fb471986d59B256500a7](https://etherscan.io/address/0xE46861C9f28c46F27949fb471986d59B256500a7)

<!-- [Contract deployment transaction](https://etherscan.io/tx/0x636bfd0543de9b79f6b0cab79059ff67df39b3f71f7065b211204fac9a06a57c) -->

## ✨ Functions

### `burn`

```solidity
function burn(address dethRecipient) external payable;
```

Burns ETH and credits DETH to the specified recipient. Emits an [`ETHBurned` event](#ethburned). Does not revert on zero amount.

### Direct ETH Burning

The contract accepts direct ETH transfers with empty calldata, automatically crediting DETH to the `msg.sender`. `msg.data` must be empty to succeed. Does not revert on zero amount.

> **Note:** Forced ETH transfers are not credited as DETH.

## View Functions

### `burned`

```solidity
function burned(address user) external view returns (uint256);
```

Returns the total ETH burned by a specific address. Expressed as an integer with 18 decimals.

### `totalBurned`

```solidity
function totalBurned() external view returns (uint256);
```

Returns the total ETH burned across all users. Expressed as an integer with 18 decimals.

## 🔍 Events

### `ETHBurned`

```solidity
event ETHBurned(
    address indexed sender,         // The address that is sending and burning ETH
    address indexed dethRecipient,  // The address that will receive DETH credits
    uint256 amount                  // The amount of ETH burned (equal to the amount of DETH credits minted)
);
```