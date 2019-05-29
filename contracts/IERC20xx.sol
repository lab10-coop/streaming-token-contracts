pragma solidity >=0.4.25 <0.6.0;

interface IERC20xx {
    enum CanOpenResult {
        OK,
        ERR_SENDER_RECEIVER_TUPLE, // TODO: find better name
        ERR_SENDER_QUOTA,
        ERR_RECEIVER_QUOTA,
        ERR_SYSTEM_LIMIT,
        ERR_FLOWRATE,
        ERR_MAXAMOUNT,
        ERR_OTHER
    }

    enum TransferType { UNDEFINED, ATOMIC, STREAM }

    function canOpenStream(address from, address to, uint256 flowrate, uint256 maxAmount) external view returns(CanOpenResult);
    function openStream(address to, uint256 flowrate, uint256 maxAmount) external returns(uint256);
    function getStreamInfo(uint256 streamId) external view returns(uint256 startTS, address sender, address receiver, uint256 flowrate, uint256 maxAmount, uint256 transferredAmount, uint256 outstandingAmount);
    function closeStream(uint256 streamId) external;

    // overrides ERC20 event, adding a field "_type"
    event Transfer(address indexed from, address indexed to, uint256 value, TransferType transferType);
    event StreamOpened(uint256 id, address indexed from, address indexed to, uint256 flowrate, uint256 maxAmount);
    event StreamClosed(uint256 id, uint256 transferredAmount, uint256 outstandingAmount);
}

