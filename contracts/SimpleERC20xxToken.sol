pragma solidity ^0.5.8;

import { IERC20 } from "./IERC20.sol";
import { IERC20xx } from "./IERC20xx.sol";

/**
 * Implementation of a Streamable ERC20 Token with the following properties:
 * - every account is allowed to be sender and/or receiver of a stream
 * - at most one open outgoing and at most one open incoming streams are allowed per account
 * - allows only streams with unrestricted amount (maxAmount set to zero)
 * - the maximum flowrate is 1E66 - this prevents stream balance overflows even for streams running for 100+ years
 * - may not allow an account to open a stream if the graph of dependent incoming streams is too large
 *
 * No explicit overflow checks are done. Shouldn't be required with totalSupply limited to 2^255 -1 (not sure about that)
 */
contract SimpleERC20xxToken is IERC20, IERC20xx {
    uint256 public totalSupply;
    string public name;
    string public symbol;
    uint8 public decimals;

    mapping (address => mapping (address => uint256)) internal allowed;

    // map of the static component of account balances
    mapping (address => int256) internal staticBalances;

    struct Stream {
        address sender;
        address receiver;
        uint256 flowrate; // flowrate in tokens (smallest unit) per second
        uint256 startTS; // start timestamp (in seconds - same unit as block timestamps)
    }

    // Array of all streams. Closed streams result in "empty holes" (entries with all fields set to their null value)
    Stream[] public streams;

    // map of outgoing stream (identified by index) per account
    mapping(address => uint256) outStreamPtrs;

    // map of incoming stream (identified by index) per account
    mapping(address => uint256) inStreamPtrs;

    //event StreamOpened(address indexed _from, address indexed _to, uint256 _perSecond);
    event StreamClosed(address indexed _from, address indexed _to, uint256 _perSecond, uint256 _settledBalance, uint256 _outstandingBalance);

    constructor(uint256 _initialSupply, string memory _name, string memory _symbol, uint8 _decimals) public {
        // this implementation limits totalSupply to 2^255 because of internal usage of int data type
        require(_initialSupply < 2**255);
        staticBalances[msg.sender] = int(_initialSupply);

        totalSupply = _initialSupply;
        name = _name;
        symbol = _symbol;
        decimals = _decimals;

        streams.push(Stream(address(0),address(0),0,0)); // empty first element for implicit null-like semantics
    }

    // ################## ERC20 interface ##################

    function transferFrom(address _from, address _to, uint256 _value)
        public
        returns (bool)
    {
        require(_to != address(0));
        require(_value <= balanceOf(_from));
        require(_value <= allowed[_from][msg.sender]);

        staticBalances[_from] -= int(_value);
        staticBalances[_to] += int(_value);
        allowed[_from][msg.sender] -= _value;
        emit Transfer(_from, _to, _value);
        return true;
    }

    function approve(address _spender, uint256 _value)
        public
        returns (bool)
    {
        allowed[msg.sender][_spender] = _value;
        emit Approval(msg.sender, _spender, _value);
        return true;
    }

    function allowance(address _owner, address _spender)
        public
        view
        returns (uint256)
    {
        return allowed[_owner][_spender];
    }

    // ERC-20 compliant function for discrete transfers
    // TODO: the standard seems to require bool return value
    function transfer(address _to, uint256 _value) external returns (bool) {
        require(balanceOf(msg.sender) >= _value);

        staticBalances[msg.sender] -= int(_value);
        staticBalances[_to] += int(_value);
        emit Transfer(msg.sender, _to, _value);
        return true;
    }

    function balanceOf(address _owner) public view returns (uint256) {
        return accountBalance(_owner);
    }

    // ################## ERC20xx interface ###################

    uint constant public MAX_RECURSION_DEPTH = 100;

    function openStream(address to, uint256 flowrate, uint256 maxAmount) external returns(uint256 streamId) {
        require(maxAmount == 0, "maxAmount limited");
        require(flowrate < 1E66, "flowrate too high");
        require(! exists(getOutStreamOf(msg.sender)), "already has outgoing stream");
        require(! exists(getInStreamOf(to)), "already has incoming stream");
        // this prevents states which become too expensive to calculate.
        require(getRecursionDepth(msg.sender) < MAX_RECURSION_DEPTH);

        streamId = streams.push(Stream(msg.sender, to, flowrate, block.timestamp)) - 1; // id = array_length - 1
        outStreamPtrs[msg.sender] = streamId;
        inStreamPtrs[to] = streamId;

        emit StreamOpened(streamId, msg.sender, to, flowrate, maxAmount);
        return streamId;
    }

    function closeStream(uint256 streamId) external {
        Stream storage s = streams[streamId];
        require(exists(s), "stream doesn't exist");
        require(msg.sender == s.sender || msg.sender == s.receiver);

        (uint256 transferredAmount, uint256 outstandingAmount) = getStreamStatus(s);
        staticBalances[s.sender] -= int(transferredAmount);
        staticBalances[s.receiver] += int(transferredAmount);

        emit StreamClosed(s.sender, s.receiver, s.flowrate, transferredAmount, outstandingAmount);

        // make sure this remains the last statement because it invalidates the pointer s
        delete streams[streamId];
        // no need to also delete [out|in]StreamPtrs, as they now point to an empty Stream object
    }

    function getStreamInfo(uint256 streamId) external view
        returns(uint256 startTS, address sender, address receiver, uint256 flowrate, uint256 maxAmount, uint256 transferredAmount, uint256 outstandingAmount)
    {
        Stream storage s = streams[streamId];
        require(exists(s), "stream doesn't exist");

        (transferredAmount, outstandingAmount) = getStreamStatus(s);
        return (s.startTS, s.sender, s.receiver, s.flowrate, 0, transferredAmount, outstandingAmount);
    }

    // ################## Internal functions ###################

    function accountBalance(address _owner) internal view returns (uint256) {
        Stream storage inS = getInStreamOf(_owner);
        uint256 inStreamBal = exists(inS) ? streamBalance(inS, inS, 1) : 0;
        // no prettier null check possible? https://ethereum.stackexchange.com/questions/871/what-is-the-zero-empty-or-null-value-of-a-struct

        Stream storage outS = getOutStreamOf(_owner);
        uint256 outStreamBal = exists(outS) ? streamBalance(outS, outS, 1) : 0;

        require(staticBalances[_owner] + int(inStreamBal) - int(outStreamBal) >= 0);
        return uint(staticBalances[_owner] + int(inStreamBal) - int(outStreamBal));
    }

    // ################## Internal constant functions ###################

    // returns the amount transferred so far and the outstanding amount (positive in case of lacking sender funds)
    function getStreamStatus(Stream storage s) internal view returns (uint256, uint256){
        uint256 bal = streamBalance(s, s, 1);
        uint256 naiveBal = naiveStreamBalance(s); // remember before manipulating the stream

        return (bal, naiveBal - bal);
    }

    // Returns the size of the graph constituted by nested incoming streams. 0 if no incoming stream.
    // The caller is responsible for not calling it on a graph which is too deep (making it run out of gas).
    function getRecursionDepth(address acc) internal view returns(uint256 depth) {
        address curAcc = acc;

        for(depth=0; true; depth++) {
            Stream storage s = getInStreamOf(curAcc);
            if(! exists(s) || s.sender == acc) {
                // found the end (start) of the graph or a cycle
                break;
            }
            curAcc = s.sender;
        }

        return depth;
    }

    // Solidity (so far) has no simple null check, using startTS as guard (assuming we'll not overflow back to 1970).
    function exists(Stream storage s) internal view returns (bool) {
        return s.startTS != 0;
    }

    function min(uint256 a, uint256 b) internal pure returns (uint256) {
        return a < b ? a : b;
    }

    // returns a reference to the outgoing stream of the given account. Caller needs to check existence on the return value.
    function getOutStreamOf(address addr) internal view returns (Stream storage) {
        return streams[outStreamPtrs[addr]];
    }

    function getInStreamOf(address addr) internal view returns (Stream storage) {
        return streams[inStreamPtrs[addr]];
    }

    function equals(Stream storage s1, Stream storage s2) internal view returns (bool) {
        return s1.sender == s2.sender && s1.receiver == s2.receiver;
    }

    // returns the naive "should be" balance of a stream, ignoring the possibility of it running out of funds
    function naiveStreamBalance(Stream storage s) internal view returns (uint256) {
        return (block.timestamp - s.startTS) * s.flowrate;
    }

    /*
     * returns the "real" (based on sender solvency) balance of a stream.
     * This takes the perspective of the sender, making the stream under investigation an outgoingStream.
     * Implements min(outgoingStreamBalance, staticBalance + incomingStreamBalance).
     * Since the balance of the incoming stream may also depend on incoming streams on the sender side,
     * we potentially need recursive invocation here.
     * The method for opening new streams is responsible for limiting recursion depth.
     * This implementation is also able to detect and correctly handle cyclical dependencies.
     */
    function streamBalance(Stream storage s, Stream storage origin, uint256 hops) internal view returns (uint256) {
        // naming: osb -> outgoingStreamBalance, isb -> incomingStreamBalance, sb -> static balance
        uint256 osb = naiveStreamBalance(s);
        if (equals(s, origin) && hops > 1) {
            // special case: stop when detecting a cycle
            return osb;
        } else {
            Stream storage inS = getInStreamOf(s.sender);
            uint256 isb = exists(inS) ? streamBalance(inS, origin, hops + 1) : 0;
            int sb = staticBalances[s.sender];
            require(sb + int(isb) >= 0);
            return min(osb, uint56(sb + int(isb)));
        }
    }
}
