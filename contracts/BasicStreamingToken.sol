pragma solidity >=0.4.25 <0.6.0;

import { IERC20 } from "./IERC20.sol";
import {IERC2100} from "./IERC2100.sol";

/**
 * Implementation of a Streamable ERC20 Token with the following properties:
 * Accounts are divided into 3 categories (account types): Default, Concentrator, Deconcentrator
 * - Default Accounts can have a limited number of incoming streams and a limited number of outgoing streams
 * - Default Accounts can receive streams from Deconcentrators only and send streams to Concentrators only
 * - Concentrators can have an unlimited number of incoming streams
 * - Deconcentrators can have an unlimited number of outgoing streams
 * Account owners can switch their account to another category whenever no streams to or from that account is open.
 * Possible resulting graphs of streams can't have cycles and have a max. distance of 3.
 * The maximum flowrate is 1E66 - this prevents stream balance overflows even for streams running for 100+ years.
 * Doesn't support setting flowrate to unlimited (0).
 * TODO: implement maxAmount
 * TODO: double check the safety / necessary preconditions of/for arithmetic operations (overflows, uint/int conversions)
 */
contract BasicStreamingToken is IERC20, IERC2100 {
    uint256 public totalSupply;
    string public name;
    string public symbol;
    uint8 public decimals;

    mapping (address => mapping (address => uint256)) internal allowed;

    // the balance per address resulting from atomic transfers and closed streams
    mapping (address => int256) staticBalances;

    // Default: 0, Concentrator: 1, Deconcentrator: 2
    enum AccountType { Default, Concentrator, Deconcentrator }

    mapping (address => AccountType) accountTypes;

    uint public constant DEFAULT_ACCOUNT_MAX_INCOMING_STREAMS = 10;
    uint public constant DEFAULT_ACCOUNT_MAX_OUTGOING_STREAMS = 10;

    struct Stream {
        address sender;
        address receiver;
        uint256 flowrate;
        uint256 startTime;
    }

    /* Array of all streams. New streams are pushed to this array, the index becoming their unique "stream id".
     * Closed streams result in "empty holes" (entries with all fields set to their null value).
     * Since the contract never needs to iterate over this array, it can keep growing forever. */
    Stream[] streams;

    /// array of outgoing streams (incl. closed) per account, identified by stream id
    mapping(address => uint[]) outStreamPtrs;

    /// array of incoming streams (incl. closed) per account, identified by stream id
    mapping(address => uint[]) inStreamPtrs;

    /* Snapshots are an optimization for deconcentrator accounts:
    On every stream state change (open or close), the snapshot of the sending deconcentrator is updated. */
    struct Snapshot {
        // time of last update of the snapshot (= time of last opening or closing of outgoing stream)
        uint256 timestamp;
        // cumulated expected balance of open streams (the overall outstanding balance)
        uint256 cumulatedExpStreamBalance;
        // cumulated expected flowrate (the overall flowrate since the last update)
        uint256 cumulatedExpFlowrate;
    }
    mapping(address => Snapshot) deconcentratorSnapshots;

    constructor(uint256 initialSupply, string memory _name, string memory _symbol, uint8 _decimals) public {
        name = _name;
        symbol = _symbol;
        decimals = _decimals;

        staticBalances[msg.sender] = int(initialSupply);
        totalSupply = initialSupply;

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
        if(! canStreamTo(from, to)) {
            return CanOpenResult.ERR_SENDER_RECEIVER_TUPLE;
        }
        // Default Account has limit for nr of incoming and outgoing streams
        if(accountTypes[from] == AccountType.Default) {
            uint256[] storage openOutStreams = getOutStreamsOf(from);
            // TODO: fix counting
            if(openOutStreams.length >= DEFAULT_ACCOUNT_MAX_OUTGOING_STREAMS) {
                return CanOpenResult.ERR_SENDER_QUOTA;
            }
        }
        if(accountTypes[to] == AccountType.Default) {
            uint256[] storage recvOpenInStreams = getInStreamsOf(to);
            // TODO: fix counting
            if(recvOpenInStreams.length >= DEFAULT_ACCOUNT_MAX_INCOMING_STREAMS) {
                return CanOpenResult.ERR_RECEIVER_QUOTA;
            }
        }
        if(flowrate == 0) {
            return CanOpenResult.ERR_FLOWRATE;
        }
        if(maxAmount != 0) {
            return CanOpenResult.ERR_MAXAMOUNT; // TODO: implement
        }

        return CanOpenResult.OK;
    }

    /** public interface to open a stream */
    function openStream(address to, uint256 flowrate, uint256 maxAmount) external returns(uint256 streamId) {
        if(canOpenStream(msg.sender, to, flowrate, maxAmount) != CanOpenResult.OK) {
            revert(); // we could return the error code, needs a map for the strings
        }

        streamId = streams.push(Stream(msg.sender, to, flowrate, block.timestamp)) - 1; // id = array_length - 1
        outStreamPtrs[msg.sender].push(streamId);
        inStreamPtrs[to].push(streamId);

        // for deconcentrators: take new snapshot
        if(accountTypes[msg.sender] == AccountType.Deconcentrator) {
            updateDeconcentratorSnapshot(msg.sender, int(flowrate), 0);
        }

        emit StreamOpened(streamId, msg.sender, to, flowrate, 0);
        return streamId;
    }

    function getStreamInfo(uint256 streamId) external view
        returns(uint256 startTS, address sender, address receiver, uint256 flowrate, uint256 maxAmount, uint256 transferredAmount, uint256 outstandingAmount)
    {
        Stream storage s = streams[streamId];
        require(exists(s), "stream doesn't exist");

        // TODO implement
        (transferredAmount, outstandingAmount) = (0, 0); //getStreamStatus(s);
        return (s.startTime, s.sender, s.receiver, s.flowrate, 0, transferredAmount, outstandingAmount);
    }

    /**
     * Close an outgoing stream
     * Updates static balance
     * Can be invoked by either the sender or receiver of a stream
     */
    function closeStream(uint256 id) public {
        Stream storage s = streams[id];
        require(exists(s));
        require(s.sender == msg.sender || s.receiver == msg.sender);

        uint256 streamBal = streamBalance(s);
        staticBalances[s.sender] -= int(streamBal);
        staticBalances[s.receiver] += int(streamBal);

        uint256 expectedStreamBal = s.flowrate * (block.timestamp - s.startTime);
        emit StreamClosed(id, streamBal, expectedStreamBal - streamBal);
        emit Transfer(msg.sender, s.receiver, streamBal, TransferType.STREAM);

        // update snapshot for deconcentrators
        if(accountTypes[s.sender] == AccountType.Deconcentrator) {
            updateDeconcentratorSnapshot(s.sender, int(-s.flowrate), streamBal);
        }

        delete streams[id];
    }

    // ################### implementation specific interface ###################

    /** sets the account type to the given value
     * Succeeds only for accounts not having any streams (neither incoming nor outgoing) open
     * TODO: The requirement of no open streams could be relaxed. Check carefully before changing.
     */
    function setAccountType(AccountType newType) public {
        require(getInStreamsOf(msg.sender).length == 0);
        require(getOutStreamsOf(msg.sender).length == 0);
        accountTypes[msg.sender] = newType;
    }

    // returns the account type of the caller
    function getAccountType() public view returns(AccountType) {
        return accountTypes[msg.sender];
    }

    // returns the account type of a given account
    function getAccountTypeOf(address acc) public view returns(AccountType) {
        return accountTypes[acc];
    }

    // ################## Internal functions ###################

    function accountBalance(address acc) internal view returns (uint256) {
        uint256 cumInStreamBal = cumulatedInStreamsBalance(acc);
        (uint cumExpOutStreamsBal, uint cumExpOutStreamsFlowrate) = cumulatedExpectedOutStreamsBalanceAndFlowrate(acc);

        if(staticBalances[acc] + int(cumInStreamBal) >= int(cumExpOutStreamsBal)) {
            return uint(staticBalances[acc] + int(cumInStreamBal) - int(cumExpOutStreamsBal));
        } else {
            /* can't just return 0 because of the possible division reminder
            division by zero is not possible (and thus not checked for) because without outstreams
            (which is the only case how cumulated expected flowrate could be 0) this branch isn't reachable */
            int256 tmpMod = (staticBalances[acc] + int(cumInStreamBal) - int(cumExpOutStreamsBal)) % int(cumExpOutStreamsFlowrate);
            if(tmpMod >= 0) {
                return uint(tmpMod);
            } else {
                // needed due to the way Solidity calculates a negative number modulo a positive number
                return uint(tmpMod + int(cumExpOutStreamsFlowrate));
            }
        }
    }

    /** checks if the account has at least the specified balance
    * This is a useful gas cost optimization for when we don't need to know the exact balance, just if there's enough.
    */
    function hasMinBalance(address acc, uint256 minBal) public view returns (bool) {
        (uint cumExpOutStreamsBal, ) = cumulatedExpectedOutStreamsBalanceAndFlowrate(acc);
        uint256[] storage openInStreams = getInStreamsOf(acc);
        int256 tmpBal = staticBalances[acc] - int(cumExpOutStreamsBal);

        // enough funds regardless of incoming streams
        if(tmpBal >= int(minBal)) {
            return true;
        }

        for(uint i=0; i< openInStreams.length; i++) {
            Stream storage s = streams[openInStreams[i]];
            if(! exists(s)) {
                continue;
            }
            tmpBal += int(streamBalance(s));
            if(tmpBal >= int(minBal)) {
                return true;
            }
        }

        // not enough funds even with incoming streams (that is, the total balance doesn't suffice)
        return false;
    }

    /** updates the aggregate streams snapshot for deconcentrators
     * timestamp is set to now, flowrate and cumulated stream balance are re-calculated based on the previous snapshot
     * and change in flowrate (can be either positive or negative, depending on stream open or close events)
     * @param settledBalance amount to be subtracted from the cumulated expected balance for closed stream(s). TODO: rename?
     */
    function updateDeconcentratorSnapshot(address acc, int deltaFlowrate, uint settledBalance) internal {
        Snapshot storage snap = deconcentratorSnapshots[acc];

        snap.timestamp = block.timestamp;
        // add the delta depending on the time passed since last snapshot, subtract settled balance for closed stream(s)
        snap.cumulatedExpStreamBalance += (block.timestamp - snap.timestamp) * snap.cumulatedExpFlowrate - settledBalance;
        // this double casting isn't pretty. But is it efficient?
        snap.cumulatedExpFlowrate = uint(int(snap.cumulatedExpFlowrate) + deltaFlowrate);
    }

    // ################## Internal constant functions ###################

    // Solidity (so far) has no simple null check, using startTimestamp as guard (assuming 1970 will not come back).
    function exists(Stream storage s) internal view returns (bool) {
        return s.startTime != 0;
    }

    // TODO: what's best practice for using uint vs uint256?
    function min(uint a, uint b) public pure returns (uint) {
        return a < b ? a : b;
    }

    function max(int a, int b) public pure returns (int) {
        return a > b ? a : b;
    }

    /// returns an array of open outgoing streams for the given address
    function getOutStreamsOf(address addr) internal view returns (uint256[] storage) {
        return outStreamPtrs[addr];
        /*
        uint[] storage allArr = outStreamPtrs[addr];
        return filterOpenStreams(allArr);
        */
    }

    function getInStreamsOf(address addr) internal view returns (uint256[] storage) {
        return inStreamPtrs[addr];
        /*
        uint[] storage allArr = inStreamPtrs[addr];
        return filterOpenStreams(allArr);
        */
    }

    function filterOpenStreams(uint[] storage inputIds) internal view returns(Stream[] memory) {
        // TODO: refactor
        // iterate through them and push open ones to a memory array
        // using the upper bound of inputArr.length for allocation size (memory arrays can't be resized)
        // This (I guess creates copies of the Stream items in memory.
        // May be more efficient to return just a list of pointers
        Stream[] memory outputStreams = new Stream[](inputIds.length);
        uint256 cnt = 0;
        for(uint i=0; i<inputIds.length; i++) {
            Stream storage s = streams[inputIds[i]];
            if(exists(s)) {
                outputStreams[cnt] = s;
                cnt++;
            }
        }

        // we want to return an array without empty elements
        Stream[] memory vacuumed = new Stream[](cnt);
        for(uint j=0; j<cnt; j++) {
            vacuumed[j] = outputStreams[j];
        }

        return vacuumed;
    }

    // returns the expected balance of a stream, ignoring the possibility of it running out of funds
    function expectedStreamBalance(Stream storage s) internal view returns (uint256) {
        return (block.timestamp - s.startTime) * s.flowrate;
    }

    function canStreamTo(address sender, address receiver) public view returns(bool) {
        /* Allowed:
        Default -> Concentrator
        Deconcentrator -> Default
        Deconcentrator -> Concentrator */
        return ((accountTypes[sender] == AccountType.Default && accountTypes[receiver] == AccountType.Concentrator) ||
        (accountTypes[sender] == AccountType.Deconcentrator && accountTypes[receiver] == AccountType.Default) ||
        (accountTypes[sender] == AccountType.Deconcentrator && accountTypes[receiver] == AccountType.Concentrator));
    }

    /// Calculates the expected cumulated balance and flowrate of the outgoing streams of the given account, ignoring solvency
    function cumulatedExpectedOutStreamsBalanceAndFlowrate(address acc) public view returns(uint, uint) {
        // TODO: optimize for deconcentrator
        // TODO: fix naming
        uint256[] storage openOutStreams = getOutStreamsOf(acc);

        uint256 cumOutBalance = 0;
        uint256 cumOutFlowrate = 0;
        for(uint256 i=0; i< openOutStreams.length; i++) {
            Stream storage s = streams[openOutStreams[i]];
            if(! exists(s)) {
                continue;
            }
            cumOutBalance += s.flowrate * (block.timestamp - s.startTime);
            cumOutFlowrate += s.flowrate;
        }
        return (cumOutBalance, cumOutFlowrate);
    }

    function cumulatedInStreamsBalance(address acc) public view returns(uint) {
        // TODO: fix naming
        uint256[] storage openInStreams = getInStreamsOf(acc);

        uint256 cumInBalance = 0;
        for(uint i=0; i< openInStreams.length; i++) {
            Stream storage  s = streams[openInStreams[i]];
            if(! exists(s)) {
                continue;
            }
            cumInBalance += streamBalance(s);
        }
        return cumInBalance;
    }

    /** returns the "real" (accounting for non-guaranteed sender solvency) balance of a stream.
     * This takes the perspective of the sender, making the stream under investigation an outgoing stream.
     */
    function streamBalance(Stream storage s) internal view returns (uint256) {
        (uint cumExpOutBalance, uint cumOutFlowrate) =
        accountTypes[s.sender] == AccountType.Deconcentrator ?
        (deconcentratorSnapshots[s.sender].cumulatedExpStreamBalance, deconcentratorSnapshots[s.sender].cumulatedExpFlowrate)
    : cumulatedExpectedOutStreamsBalanceAndFlowrate(s.sender);
        // TODO optimize: check for required balance instead of full computation
        uint256 cumInBalance = cumulatedInStreamsBalance(s.sender);
        int256 curAccBalance = staticBalances[s.sender] - int(cumExpOutBalance) + int(cumInBalance);

        uint256 cumOutBalance = cumExpOutBalance - uint(max(0, -curAccBalance));
        uint256 defaultedTimespan = (cumExpOutBalance - cumOutBalance) / cumOutFlowrate;

        // Division truncates (floor), but we need ceil in order to not transfer unavailable funds
        if((cumExpOutBalance - cumOutBalance) % cumOutFlowrate != 0) {
            defaultedTimespan += 1;
        }

        return (block.timestamp - s.startTime - defaultedTimespan) * s.flowrate;
    }
}
