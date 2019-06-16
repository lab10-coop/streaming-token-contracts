pragma solidity >=0.4.25 <0.6.0;

import { IERC20 } from "./IERC20.sol";
import {IERC2100} from "./IERC2100.sol";

/**
 * Implementation of a Streamable ERC20 Token with the following properties:
 * - every account is allowed to be sender and/or receiver of a stream
 * - at most one open outgoing and at most one open incoming streams are allowed per account
 * - allows only streams with unrestricted amount (maxAmount set to zero)
 * - the maximum flowrate is 1E66 - this prevents stream balance overflows even for streams running for 100+ years
 * - may not allow an account to open a stream if the graph of dependent incoming streams is too large
 * TODO: handle unlimited flowrate
 *
 * No explicit overflow checks are done. Shouldn't be required with totalSupply limited to 2^255 -1 (TODO: double check)
 */
contract SimpleStreamingToken is IERC20, IERC2100 {
    uint256 public totalSupply;
    string public name;
    string public symbol;
    uint8 public decimals;

    mapping (address => mapping (address => uint256)) internal allowed;

    /*
     * map of the static component of account balances.
     * Using a signed int makes it easier to use only one storage slot
     * That's because the static component can become negative (when an outgoing stream which is fed by an incoming one
     * is closed first).
     */
    mapping (address => int256) internal staticBalances;

    // TODO: consider using smaller uint types in order to reduce storage related gas costs (struct packing)
    struct Stream {
        address sender;
        address receiver;
        uint256 flowrate; // flowrate in tokens (smallest unit) per second
        uint256 startTS; // start timestamp (in seconds - same unit as block timestamps)
    }

    /*
     * Array of all streams. New streams are pushed to this array, the index becoming their unique "stream id".
     * Closed streams result in "empty holes" (entries with all fields set to their null value).
     * Since the contract never needs to iterate over this array, it can keep growing forever.
     */
    Stream[] streams;

    // map of outgoing stream (identified by stream id) per account
    mapping(address => uint256) outStreamPtrs;

    // map of incoming stream (identified by stream id) per account
    mapping(address => uint256) inStreamPtrs;

    // max size of a sub-graph of connected streams. Avoids stack overflows
    uint constant public MAX_RECURSION_DEPTH = 100;

    constructor(uint256 _initialSupply, string memory _name, string memory _symbol, uint8 _decimals) public {
        // this implementation limits totalSupply to 2^255 because of internal usage of int data type
        require(_initialSupply < 2**255);
        staticBalances[msg.sender] = int(_initialSupply);

        totalSupply = _initialSupply;
        name = _name;
        symbol = _symbol;
        decimals = _decimals;

        // empty first element for implicit null-like semantics (sentinel entry)
        streams.push(Stream(address(0), address(0), 0, 0));
    }

    // ################## ERC20 interface ##################

    function transferFrom(address _from, address _to, uint256 _value) public returns (bool) {
        require(_to != address(0));
        require(_value <= balanceOf(_from));
        require(_value <= allowed[_from][msg.sender]);

        staticBalances[_from] -= int(_value);
        staticBalances[_to] += int(_value);
        allowed[_from][msg.sender] -= _value;
        emit Transfer(_from, _to, _value, TransferType.ATOMIC);
        return true;
    }

    function approve(address _spender, uint256 _value) public returns (bool) {
        allowed[msg.sender][_spender] = _value;
        emit Approval(msg.sender, _spender, _value);
        return true;
    }

    function allowance(address _owner, address _spender) public view returns (uint256) {
        return allowed[_owner][_spender];
    }

    // atomic transfers
    function transfer(address _to, uint256 _value) external returns (bool) {
        require(balanceOf(msg.sender) >= _value);

        staticBalances[msg.sender] -= int(_value);
        staticBalances[_to] += int(_value);
        emit Transfer(msg.sender, _to, _value, TransferType.ATOMIC);
        return true;
    }

    function balanceOf(address _owner) public view returns (uint256) {
        return accountBalance(_owner);
    }

    // ################## ERC2100 interface ###################

    function canOpenStream(address from, address to, uint256 flowrate, uint256 maxAmount) public view returns(CanOpenResult) {
        if(exists(getOutStreamOf(from))) {
            return CanOpenResult.ERR_SENDER_QUOTA;
        }
        if(exists(getInStreamOf(to))) {
            return CanOpenResult.ERR_RECEIVER_QUOTA;
        }
        if(getRecursionDepth(from) >= MAX_RECURSION_DEPTH) {
            return CanOpenResult.ERR_SYSTEM_LIMIT;
        }
        if(flowrate > 1E66) {
            return CanOpenResult.ERR_FLOWRATE;
        }
        if(maxAmount > 0) {
            return CanOpenResult.ERR_MAXAMOUNT;
        }

        return CanOpenResult.OK;
    }

    function openStream(address to, uint256 flowrate, uint256 maxAmount) external returns(uint256 streamId) {
        CanOpenResult ret = canOpenStream(msg.sender, to, flowrate, maxAmount);
        if(ret != CanOpenResult.OK) {
            revert(); // we could return the error code, needs a map for the strings
        }

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

        emit Transfer(s.sender, s.receiver, transferredAmount, TransferType.STREAM);
        emit StreamClosed(streamId, transferredAmount, outstandingAmount);

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

    // ################## Internal constant functions ###################

    // returns the overall balance of the given account
    function accountBalance(address _owner) internal view returns (uint256) {
        Stream storage inS = getInStreamOf(_owner);
        uint256 inStreamBal = exists(inS) ? streamBalance(inS, inS, 1) : 0;
        // no prettier null check possible? https://ethereum.stackexchange.com/questions/871/what-is-the-zero-empty-or-null-value-of-a-struct

        Stream storage outS = getOutStreamOf(_owner);
        uint256 outStreamBal = exists(outS) ? streamBalance(outS, outS, 1) : 0;

        require(staticBalances[_owner] + int(inStreamBal) - int(outStreamBal) >= 0);
        return uint(staticBalances[_owner] + int(inStreamBal) - int(outStreamBal));
    }

    // returns the amount transferred so far and the outstanding amount (non-zero in case of lacking sender funds)
    function getStreamStatus(Stream storage s) internal view returns (uint256, uint256){
        uint256 bal = streamBalance(s, s, 1);
        uint256 naiveBal = naiveStreamBalance(s);

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

    // checks if the given stream exists (is open).
    // does so by looking at the startTS timestamp which is always non-zero for open streams and zero for closed ones.
    // TODO: isOpen may be a better name
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

    // returns true if the two Stream objects are the same.
    // This implementation depends on the constraints of the contract (only one in/out stream per account)
    function equals(Stream storage s1, Stream storage s2) internal view returns (bool) {
        /*
         * The == operator isn't implemented on storage pointers, thus this somewhat hacky implementation.
         * And alternative could be to use assembly code (eq instruction) - I didn't test that.
         * It should be enough to compare only sender, but comparing both feels safer.
         */
        return s1.sender == s2.sender && s1.receiver == s2.receiver;
    }

    // returns the "naive" balance of a stream, ignoring the possibility of the sender running out of funds
    function naiveStreamBalance(Stream storage s) internal view returns (uint256) {
        return (block.timestamp - s.startTS) * s.flowrate;
    }

    /*
     * returns the "real" (taking into account sender solvency) balance of a stream.
     * This takes the perspective of the sender, making the stream under investigation an outgoingStream.
     * Implements min(outgoingStreamBalance, staticBalance + incomingStreamBalance).
     * Since the balance of the incoming stream may also depend on incoming streams on the sender side,
     * this method can recurse. When recursing, it will detect and properly handle cycles.
     * Has no protection against hitting the stack limit; it's the responsibility of methods which open streams
     * to not allow unsafe contract states -> recursion depths.
     */
    function streamBalance(Stream storage s, Stream storage origin, uint256 hops) internal view returns (uint256) {
        // naming: osb -> outgoingStreamBalance, isb -> incomingStreamBalance, sb -> staticBalance
        uint256 osb = naiveStreamBalance(s);
        if (equals(s, origin) && hops > 1) {
            // special case: cycle detected, stopping here
            return osb;
        } else {
            Stream storage inS = getInStreamOf(s.sender);
            uint256 isb = exists(inS) ? streamBalance(inS, origin, hops + 1) : 0;
            int sb = staticBalances[s.sender];
            require(sb + int(isb) >= 0);
            return min(osb, uint256(sb + int(isb)));
        }
    }
}
