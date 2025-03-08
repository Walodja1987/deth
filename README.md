# DETH
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
## Overview

DETH is a smart contract that enables users to **permanently burn ETH** and receive **verifiable proof** in the form of **non-transferrable DETH credits**, issued at a 1:1 ratio. By burning ETH through DETH, **users contribute to Ethereum's deflationary mechanism and ETH's value accrual**.

Applications can leverage these verifiable burns for asset purchases, reward mechanisms, governance systems, sybil resistance, proof of commitment or other use cases requiring **proof of value destruction**.

## Demo

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

The DETH contract is deployed on Ethereum mainnet at the following address:

```
0x000...000
```

## Functions

### `burn(dethRecipient)`

Burns ETH and credits DETH to the specified recipient (`dethRecipient`). Emits an `ETHBurned` event with `msg.sender`, `dethRecipient` and the amount of ETH burned. Does not revert on zero amount.

### Direct ETH Burning

The contract accepts direct ETH transfers with empty calldata, automatically crediting DETH to the sender. This provides a simpler way for users to burn ETH directly. Does not revert on zero amount.

### View Functions

- `burned(address)`: Returns the total ETH burned by a specific address
- `totalBurned()`: Returns the total ETH burned across all users
- `excessETH()`: Returns any ETH locked in the contract but not credited as DETH (should normally be 0)

## Integration

Applications can integrate DETH in two ways:
1. Call `burn(dethRecipient)` with ETH to credit DETH to any address
2. Send ETH directly to the contract to credit DETH to the sender

> **Note:** Forced ETH transfers (e.g., through SELFDESTRUCT in the past) are not credited as DETH.

