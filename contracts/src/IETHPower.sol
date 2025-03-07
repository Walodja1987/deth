// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

interface IETHPower {
    event ETHPowerCredited(address indexed sender, address indexed recipient, uint256 amount);

    function burnAndCredit(address ethPowerRecipient) external payable;
    function burned(address user) external view returns (uint256);
    function totalBurned() external view returns (uint256);
    function excessETH() external view returns (uint256);
}
