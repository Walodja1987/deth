# DETH - A Global ETH Burn Registry
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

These attestations can support sybil resistance, optimize reward distribution (e.g., airdrops), enhance governance models, and enable new innovations.

## Usage

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

## Address

The DETH contract is deployed on Ethereum at the following address:

```
0x000...000
```

## Functions

### `burn(dethRecipient)`

```solidity
function burn(address dethRecipient) external payable;
```

Burns ETH and credits DETH to the specified recipient (`dethRecipient`). Emits an `ETHBurned` event with the user burning ETH (`msg.sender` ), the DETH credits recipient (`dethRecipient`) and the amount of ETH burned. Does not revert on zero amount.

### Direct ETH Burning

The contract accepts direct ETH transfers with empty calldata, automatically crediting DETH to the sender. This provides a simpler way for users to burn ETH directly. Does not revert on zero amount.

### View Functions

- `burned(address)`: Returns the total ETH burned by a specific address
- `totalBurned()`: Returns the total ETH burned across all users

## Integration

Applications can integrate DETH in two ways:
1. Call `burn(dethRecipient)` with ETH to credit DETH to any address
2. Send ETH directly to the contract to credit DETH to the sender

> **Note:** Forced ETH transfers are not credited as DETH.

