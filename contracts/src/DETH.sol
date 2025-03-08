// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {IDETH} from "./IDETH.sol";

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

/**
 * @title DETH
 * @author Wladimir Weinbender
 * @notice This contract acts as a global ETH sink, permanently locking ETH and rewarding users
 * with non-transferrable DETH credits at a 1:1 ratio (18 decimals).
 * 
 * DETH serves as a verifiable proof of a user's ETH burning which can be used by applications
 * to reward users in many different ways.
 * 
 * @dev Applications can integrate by either:
 * 1. Calling burnAndCredit() to lock ETH and credit DETH to a specified address.
 * 2. Sending ETH directly to the contract (with empty calldata) to credit DETH to the sender.
 * 
 * Forced ETH transfers are not credited.
 */
contract DETH is IDETH {
    mapping(address => uint256) private _burned;
    uint256 private _totalBurned;

    /**
     * @notice Fallback function to allow direct ETH transfers. Credits DETH to `msg.sender`.
     * @dev `msg.data` must be empty to succeed. 
     */
    receive() external payable {
        require(msg.value > 0, "Zero ETH");
        _burned[msg.sender] += msg.value;
        _totalBurned += msg.value;
        emit ETHBurned(msg.sender, msg.sender, msg.value);
    }

    /**
     * @notice Burns ETH and credits DETH to the specified `dethRecipient` at a 1:1 ratio.
     * @param dethRecipient The address that will be credited with DETH.
     */
    function burnAndCredit(address dethRecipient) external payable override {
        require(msg.value > 0, "Zero ETH");
        _burned[dethRecipient] += msg.value;
        _totalBurned += msg.value;
        emit ETHBurned(msg.sender, dethRecipient, msg.value);
    }

    /**
     * @notice Returns the total ETH amount burned by the specified `user` (equivalent to DETH credited to `user`).
     * @param user The address to query.
     * @return The total ETH balance of the user.
     */
    function burned(address user) external view override returns (uint256) {
        return _burned[user];
    }

    /**
     * @notice Returns the total ETH amount burned across all users (equivalent to total DETH credited).
     * @return The total amount of ETH ever burned.
     */
    function totalBurned() external view override returns (uint256) {
        return _totalBurned;
    }

    /**
     * @notice Returns the amount of ETH that is locked in this contract but not credited as DETH.
     * @dev Could be positive if forced ETH transfers become possible again (eg., through future protocol changes).
     * @return The amount of ETH that is locked in this contract but not credited as DETH.
     */
    function excessETH() external view override returns (uint256) {
        return address(this).balance - _totalBurned;
    }
}


