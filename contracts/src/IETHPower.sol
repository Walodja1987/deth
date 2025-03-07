// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

interface IETHPower {
    function mintETHPower(address to) external payable;
    function getETHPowerBalance(address user) external view returns (uint256);
    function getTotalETHPowerMinted() external view returns (uint256);
    function getUnaccountedETH() external view returns (uint256);
}
