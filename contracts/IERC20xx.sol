pragma solidity >=0.4.25 <0.6.0;

interface IERC20xx {
    function openStream(address to, uint256 flowrate, uint256 maxAmount) external returns(uint256);
    function getStreamInfo(uint256 streamId) external view returns(uint256 startTS, address sender, address receiver, uint256 flowrate, uint256 maxAmount, uint256 transferredAmount, uint256 outstandingAmount);
//    function balanceOfStream(uint256 streamId) external view returns(uint256);
    function closeStream(uint256 streamId) external;

    event StreamOpened(uint256 id, address indexed from, address indexed to, uint256 flowrate, uint256 maxAmount);
}

