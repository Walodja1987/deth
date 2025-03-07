// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {IETHPower} from "./IETHPower.sol";

/////////////////////////////////////////////////////////////////////
//                                                                 //
//                      )   (         )                    (       //
//           *   )   ( /(   )\ )   ( /(    (  (            )\ )    //
//    (    ` )  /(   )\()) (()/(   )\())   )\))(   ' (    (()/(    //
//    )\    ( )(_)) ((_)\   /(_)) ((_)\   ((_)()\ )  )\    /(_))   //
//   ((_)  (_(_())   _((_) (_))     ((_)  _(())\_)()((_)  (_))     //
//   | __| |_   _|  | || | | _ \   / _ \  \ \((_)/ /| __| | _ \    //
//   | _|    | |    | __ | |  _/  | (_) |  \ \/\/ / | _|  |   /    //
//   |___|   |_|    |_||_| |_|     \___/    \_/\_/  |___| |_|_\    //
//                                                                 //
/////////////////////////////////////////////////////////////////////

/**
 * @title ETHPower
 * @author Wladimir Weinbender
 * @notice This contract acts as a global ETH sink, permanently locking ETH and rewarding users
 * with non-transferrable ETHPower (18 decimals), credited at a 1:1 ratio.
 * 
 * ETHPower serves as a verifiable proof of a user's ETH burning which can be used by applications
 * as a basis to reward users in many different ways.
 * 
 * @dev Applications can integrate by either:
 * 1. Calling burnAndCredit() to lock ETH and credit ETHPower to a specified address.
 * 2. Sending ETH directly to the contract (with empty calldata) to credit ETHPower to the sender.
 * 
 * Forced ETH transfers are not credited.
 */
contract ETHPower is IETHPower {
    mapping(address => uint256) private ethPower;
    uint256 public totalBurned;

    /**
     * @notice Fallback function to allow direct ETH transfers.
     * @dev `msg.data` must be empty to succeed. ETHPower is credited to `msg.sender`.
     */
    receive() external payable {
        require(msg.value > 0, "Zero ETH");
        ethPower[msg.sender] += msg.value;
        totalBurned += msg.value;
        emit ETHPowerCredited(msg.sender, msg.sender, msg.value);
    }

    /**
     * @notice Burns ETH and credits ETHPower to the specified recipient (`to`) in a 1:1 ratio.
     * @param to The address that will be credited with ETHPower.
     */
    function burnAndCredit(address ethPowerRecipient) external payable override {
        require(msg.value > 0, "Zero ETH");
        ethPower[ethPowerRecipient] += msg.value;
        totalBurned += msg.value;
        emit ETHPowerCredited(msg.sender, ethPowerRecipient, msg.value);
    }

    /**
     * @notice Returns the total ETH amount burned by the specified `user` (equivalent to ETHPower credited to `user`).
     * @param user The address to query.
     * @return The total ETHPower balance of the user.
     */
    function burned(address user) external view override returns (uint256) {
        return ethPower[user];
    }

    /**
     * @notice Returns the total ETH amount burned across all users (equivalent to total ETHPower credited).
     * @return The total amount of ETH ever burned.
     */
    function totalBurned() external view override returns (uint256) {
        return totalBurned;
    }

    /**
     * @notice Returns the amount of ETH that is locked in this contract but not credited as ETHPower.
     * @dev Added in case forced ETH transfers will become possible again.
     * @return The amount of ETH that is locked in this contract but not credited as ETHPower.
     */
    function excessETH() external view override returns (uint256) {
        return address(this).balance - totalBurned;
    }
}


