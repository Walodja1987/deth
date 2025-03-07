// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

//////////////////////////////////////////////////////////////////////
//                                                                  //
//                      )   (         )                    (        //
//           *   )   ( /(   )\ )   ( /(    (  (            )\ )     //
//    (    ` )  /(   )\()) (()/(   )\())   )\))(   ' (    (()/(     //
//    )\    ( )(_)) ((_)\   /(_)) ((_)\   ((_)()\ )  )\    /(_))    //
//   ((_)  (_(_())   _((_) (_))     ((_)  _(())\_)()((_)  (_))      //
//   | __| |_   _|  | || | | _ \   / _ \  \ \((_)/ /| __| | _ \     //
//   | _|    | |    | __ | |  _/  | (_) |  \ \/\/ / | _|  |   /     //
//   |___|   |_|    |_||_| |_|     \___/    \_/\_/  |___| |_|_\     //
//                                                                  //
//////////////////////////////////////////////////////////////////////

/**
 * @title ETHPower
 * @notice This contract acts as an ETH sink, permanently locking ETH and rewarding users with non-transferrable ETHPower.
 * The ETHPower serves as a verifiable proof of a user's ETH burning.
 * ETHPower is minted at a 1:1 ratio with locked ETH and has 18 decimals.
 * @dev Applications can integrate by either:
 * 1. Calling mintETHPower() to lock ETH and mint ETHPower to a specified address
 * 2. Sending ETH directly to the contract (with empty calldata) to mint ETHPower to the sender
 * 
 * Forced ETH transfers are not credited.
 */
contract ETHPower {
    // Mapping of user address to ETHPower balance (1:1 with ETH burned).
    mapping(address => uint256) private ethPower;
    
    // Tracks total ETHPower minted across all users (does not include forced ETH transfers).
    uint256 public totalETHPowerMinted;

    // Event emitted when ETHPower is minted.
    event ETHPowerMinted(address indexed sender, address indexed recipient, uint256 amount);

    /**
     * @notice Fallback function to allow direct ETH transfers.
     * @dev `msg.data` must be empty to succeed. ETHPower is credited to `msg.sender`.
     */
    receive() external payable {
        require(msg.value > 0, "Zero ETH");
        ethPower[msg.sender] += msg.value;
        totalETHPowerMinted += msg.value;
        emit ETHPowerMinted(msg.sender, msg.sender, msg.value);
    }

    /**
     * @notice Burns ETH and credits ETHPower to the specified recipient (`to`) in a 1:1 ratio.
     * @param to The address that will be credited with ETHPower.
     */
    function mintETHPower(address to) external payable {
        require(msg.value > 0, "Zero ETH");
        ethPower[to] += msg.value;
        totalETHPowerMinted += msg.value;
        emit ETHPowerMinted(msg.sender, to, msg.value);
    }

    /**
     * @notice Returns the ETHPower balance of a user.
     * @param user The address to query.
     * @return The total ETHPower balance of the user.
     */
    function getETHPowerBalance(address user) external view returns (uint256) {
        return ethPower[user];
    }

    /**
     * @notice Returns the total ETHPower minted across all users.
     * @return The total amount of ETHPower ever created.
     */
    function getTotalETHPowerMinted() external view returns (uint256) {
        return totalETHPowerMinted;
    }

    /**
     * @notice Returns the amount of ETH that has not been credited as ETHPower, just in
     * case forced ETH transfers will become possible in the future again.
     * @return The amount of ETH that is locked in this contract but not credited as ETHPower.
     */
    function getUnaccountedETH() external view returns (uint256) {
        return address(this).balance - totalETHPowerMinted;
    }
}


