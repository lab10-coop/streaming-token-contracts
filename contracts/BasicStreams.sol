pragma solidity >=0.4.25 <0.6.0;

import { IERC20 } from "./IERC20.sol";
import { IERC20xx } from "./IERC20xx.sol";

/**
 * Implements an ERC-20 token with the additional functionality of basic streems.
 *
 * TODO: check the safety / necessary preconditions of/for arithmetic operations (overflows, uint/int conversions)
 */
contract BasicStreams is IERC20, IERC20xx {
    uint256 public totalSupply_;
    string public name;
    string public symbol;
    uint8 public decimals;

    // the balance per address resulting from discrete transfers and closed streems
    mapping (address => int256) staticBalances;

    // OpenAccount: 0, Concentrator: 1, Deconcentrator: 2
    enum AccountType { OpenAccount, Concentrator, Deconcentrator }

    /** relies on the default value being the first item (OpenAccount): https://ethereum.stackexchange.com/a/25805/4298
     * TODO: check if that's safe */
    mapping (address => AccountType) accountTypes;

    uint public constant OPENACCOUNT_MAX_INCOMING_STREEMS = 10;
    uint public constant OPENACCOUNT_MAX_OUTGOING_STREEMS = 10;

    struct Streem {
        address sender;
        address receiver;
        uint256 flowrate;
        uint256 startTime;
    }

    /** List of all streems (incoming and outgoing) for all accounts.
     * TODO: should maybe be converted to a mapping in order to facilitate deleting. E.g. key is hash of blocknr concat sender address
     */
    Streem[] public streems;

    /// array of outgoing streems (incl. closed) per address, identified by index in global streems array
    mapping(address => uint[]) outStreemPtrs;

    /// array of incoming streems (incl. closed) per address, identified by index in global streems array
    mapping(address => uint[]) inStreemPtrs;

    /* Snapshots are an optimization for deconcentrator accounts:
    On every streem state change (open or close), the snapshot of the sending deconcentrator is updated. */
    struct Snapshot {
        // time of last update of the snapshot (= time of last opening or closing of outgoing streem)
        uint256 timestamp;
        // cumulated expected balance of open streems (the overall outstanding balance)
        uint256 cumulatedExpStreemBalance;
        // cumulated expected flowrate (the overall flowrate since the last update)
        uint256 cumulatedExpFlowrate;
    }
    mapping(address => Snapshot) deconcentratorSnapshots;

    //event Transfer(address indexed from, address indexed to, uint256 value);
    event StreemOpened(uint256 id, address indexed from, address indexed to, uint256 flowrate);
    event StreemClosed(uint256 id, address indexed from, address indexed to, uint256 flowrate, uint256 value, uint256 outstandingValue);
    event StreemsOpened(uint256 startId, uint256 endId, address indexed from, uint256 flowrate);

    constructor(uint256 initialSupply, string memory _name, string memory _symbol, uint8 _decimals) public {
        name = _name;
        symbol = _symbol;
        decimals = _decimals;

        staticBalances[msg.sender] = int(initialSupply);
        totalSupply_ = initialSupply;

        // initialized arrays with sentinels
        streems.push(Streem(address(0), address(0), 0, 0)); // empty first element for implicit null-like semantics
    }

    // ################## ERC20 interface ##################

    /* copied over from openzeppelin and adapted. TODO: test */

    function totalSupply() public view returns (uint256) {
        return totalSupply_;
    }

    mapping (address => mapping (address => uint256)) internal allowed;

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

    /** sets the account type to the given value
     * Succeeds only for accounts not having any streems (neither incoming nor outgoing) open
     * TODO: The requirement of no open streems could be relaxed. Check carefully before changing.
     */
    function setAccountType(AccountType newType) public {
        require(getInStreemsOf(msg.sender).length == 0);
        require(getOutStreemsOf(msg.sender).length == 0);
        accountTypes[msg.sender] = newType;
    }

    function getAccountType() public view returns(AccountType) {
        return accountTypes[msg.sender];
    }

    function getAccountTypeOf(address acc) public view returns(AccountType) {
        return accountTypes[acc];
    }

    /** public interface to open a streem */
    function openStream(address to, uint256 flowrate, uint256 maxAmount) public returns(uint256) {
        require(maxAmount == 0); // TODO: implement
        return openStreemImpl(to, flowrate, false);
    }

    function getStreamInfo(uint256 streamId) external view
        returns(uint256 startTS, address sender, address receiver, uint256 flowrate, uint256 maxAmount, uint256 transferredAmount, uint256 outstandingAmount)
    {
        Streem storage s = streems[streamId];
        require(exists(s), "stream doesn't exist");

        // TODO implement
        (transferredAmount, outstandingAmount) = (0, 0);//getStreamStatus(s);
        return (s.startTime, s.sender, s.receiver, s.flowrate, 0, transferredAmount, outstandingAmount);
    }



    /** Batch open streems with equal flowrate for deconcentrator accounts */
    function openMultipleStreems(address[] memory receivers, uint256 flowrate) public {
        require(accountTypes[msg.sender] == AccountType.Deconcentrator);
        require(receivers.length > 0);

        // check balance
        require(hasMinBalance(msg.sender, receivers.length * flowrate * 60));

        for(uint i=0; i < receivers.length; i++) {
            openStreemImpl(receivers[i], flowrate, true);
        }

        updateDeconcentratorSnapshot(msg.sender, int(flowrate * receivers.length), 0);

        // Assumption: streemID is the index in streems
        emit StreemsOpened(streems.length - receivers.length, streems.length-1, msg.sender, flowrate);
    }

    /**
     * Close an outgoing streem
     * Updates static balance
     * Can be invoked by either the sender or receiver of a streem
     */
    function closeStream(uint256 id) public {
        Streem storage s = streems[id];
        require(exists(s));
        require(s.sender == msg.sender || s.receiver == msg.sender);

        uint256 streemBal = streemBalance(s);
        staticBalances[s.sender] -= int(streemBal);
        staticBalances[s.receiver] += int(streemBal);

        uint256 expectedStreemBal = s.flowrate * (block.timestamp - s.startTime);
        emit StreemClosed(id, msg.sender, s.receiver, s.flowrate, streemBal, expectedStreemBal - streemBal);
        // Log the final amount as normal transfer. TODO: do we really want that?
        emit Transfer(msg.sender, s.receiver, streemBal);

        // update snapshot for deconcentrators
        if(accountTypes[s.sender] == AccountType.Deconcentrator) {
            updateDeconcentratorSnapshot(s.sender, int(-s.flowrate), streemBal);
        }

        delete streems[id];
    }

    /**
     * Closes the last opened streem from the tx sender to the given receiver.
     * returns false if no such streem exists
     */
    function closeLastStreemTo(address receiver) public returns (bool) {
        // iterating backwards in order to catch the last opened one
        for(uint256 i=outStreemPtrs[msg.sender].length-1; i>=0; i--) {
            uint256 id = outStreemPtrs[msg.sender][i];
            Streem storage s = streems[id];
            if(exists(s)) {
                if(s.receiver == receiver) {
                    // found a streem which is still open and has matching receiver -> close it
                    closeStream(id);
                    return true;
                }
            }
        }
        return false;
    }

    /** Batch close streems for deconcentrator accounts
     * Takes advantage of simplified (cheap) balance calculation due to lack of incoming streems.
     * A further optimization would be to define streem groups with equal flowrate.
     * (would also be more consistent with openStreems(receivers[], flowrate))
     *
     * TODO: check if this can be refactored to be less redundant with closeStreem() and streemBalance()
     */
    function closeMultipleStreems(uint256[] memory ids) public {
        require(accountTypes[msg.sender] == AccountType.Deconcentrator);

        Snapshot storage snap = deconcentratorSnapshots[msg.sender];
        int256 missingBal = int(snap.cumulatedExpStreemBalance + (snap.timestamp * snap.cumulatedExpFlowrate)) - staticBalances[msg.sender];
        // after checking > 0, it's safe to cast to uint
        uint256 defaultedTimespan = missingBal > 0 ? uint(missingBal) / snap.cumulatedExpFlowrate : 0;
        // Division truncates (floor), but we need ceil in order to not transfer unavailable funds
        if(missingBal > 0 && uint(missingBal) % snap.cumulatedExpFlowrate != 0) {
            defaultedTimespan += 1;
        }

        // track the overall change in flowrate (add the flowrate for every closed streem)
        uint cumClosedFlowrate = 0;
        // track the overall change in expected balance (add the setlled balance for every closed streem)
        uint cumClosedBalance = 0;

        for(uint i=0; i<ids.length; i++) {
            Streem storage s = streems[ids[i]];
            require(exists(s));
            require(s.sender == msg.sender);

            uint256 funded_timespan = block.timestamp - s.startTime - defaultedTimespan;
            assert(funded_timespan > 0); // TODO: proof that this must be true
            uint256 amount = funded_timespan * s.flowrate;

            staticBalances[s.sender] -= int(amount);
            staticBalances[s.receiver] += int(amount);

            // events per streem too expensive for batch operation
            // StreemClosed(ids[i], msg.sender, s.receiver, s.flowrate, amount, defaultedTimespan * s.flowrate);
            // Transfer(msg.sender, s.receiver, streemBal);
            delete streems[ids[i]];

            cumClosedFlowrate += s.flowrate;
            cumClosedBalance += amount;
        }

        updateDeconcentratorSnapshot(msg.sender, int(-cumClosedFlowrate), cumClosedBalance);
    }

    function getStreemBalance(uint256 id) public view returns(uint256) {
        Streem storage s = streems[id];
        return streemBalance(s);
    }

    /** checks if the account has at least the specified balance */
    function hasMinBalance(address acc, uint256 minBal) public view returns (bool) {
        (uint cumExpOutStreemsBal, ) = cumulatedExpectedOutStreemsBalanceAndFlowrate(acc);
        uint256[] storage openInStreems = getInStreemsOf(acc);
        int256 tmpBal = staticBalances[acc] - int(cumExpOutStreemsBal);

        // enough funds regardless of incoming streems
        if(tmpBal >= int(minBal)) {
            return true;
        }

        for(uint i=0; i< openInStreems.length; i++) {
            Streem storage s = streems[openInStreems[i]];
            if(! exists(s)) {
                continue;
            }
            tmpBal += int(streemBalance(s));
            if(tmpBal >= int(minBal)) {
                return true;
            }
        }

        // not enough funds even with incoming streems (that is, the total balance doesn't suffice)
        return false;
    }

    // ################## Internal functions ###################

    function accountBalance(address acc) internal view returns (uint256) {
        uint256 cumInStreemBal = cumulatedInStreemsBalance(acc);
        (uint cumExpOutStreemsBal, uint cumExpOutStreemsFlowrate) = cumulatedExpectedOutStreemsBalanceAndFlowrate(acc);

        if(staticBalances[acc] + int(cumInStreemBal) >= int(cumExpOutStreemsBal)) {
            return uint(staticBalances[acc] + int(cumInStreemBal) - int(cumExpOutStreemsBal));
        } else {
            /* can't just return 0 because of the possible division reminder
            division by zero is not possible (and thus not checked for) because without outstreems
            (which is the only case how cumulated expected flowrate could be 0) this branch isn't reachable */
            int256 tmpMod = (staticBalances[acc] + int(cumInStreemBal) - int(cumExpOutStreemsBal)) % int(cumExpOutStreemsFlowrate);
            if(tmpMod >= 0) {
                return uint(tmpMod);
            } else {
                // This is an ugly hack for Solidity not correctly calculating a negative number modulo a positive number
                return uint(tmpMod + int(cumExpOutStreemsFlowrate));
            }
        }
    }

    /** Create an outgoing streem
     * opens a streem from the transaction sender to the given receiver with the given flowrate.
     * Will succeed only if the sender is allowed to have outgoing streems,
     * the receiver is allowed to have incoming streems from this type of account
     * and if the sender has enough funds (flowrate * 60 - that is, one minute).
     * @param batched if true this function will not check if the sender has enough funds and not update the snapshot for deconcentrators
     * TODO: use error events to inform about reason for errors
     */
    function openStreemImpl(address receiver, uint256 flowrate, bool batched) internal returns(uint256) {
        // check if the request is allowed for the involved account types
        // TODO: this can be optimized for batch requests
        require(canStreemTo(msg.sender, receiver));
        require(flowrate > 0);

        // check other limits
        // OpenAccount has limit for nr of incoming and outgoing streems
        if(accountTypes[msg.sender] == AccountType.OpenAccount) {
            uint256[] storage openOutStreems = getOutStreemsOf(msg.sender);
            // TODO: fix counting
            require(openOutStreems.length <= OPENACCOUNT_MAX_OUTGOING_STREEMS);
        }
        if(accountTypes[receiver] == AccountType.OpenAccount) {
            uint256[] storage recvOpenInStreems = getInStreemsOf(receiver);
            // TODO: fix counting
            require(recvOpenInStreems.length <= OPENACCOUNT_MAX_INCOMING_STREEMS);
        }

        if(! batched) {
            // check required sender balance. // TODO: check for uint overflow
            require(hasMinBalance(msg.sender, flowrate * 60));
        }

        uint256 streemId = streems.push(Streem(msg.sender, receiver, flowrate, block.timestamp)) - 1; // id = array_length - 1
        outStreemPtrs[msg.sender].push(streemId);
        inStreemPtrs[receiver].push(streemId);

        if(! batched) {
            // for deconcentrators: take new snapshot
            if(accountTypes[msg.sender] == AccountType.Deconcentrator) {
                updateDeconcentratorSnapshot(msg.sender, int(flowrate), 0);
            }

            // TODO: this seems too expensive for batched requests, thus disabled. Do we need this event at all?
            emit StreamOpened(streemId, msg.sender, receiver, flowrate, 0);
        }

        return streemId;
    }



    /** updates the aggregate streems snapshot for deconcentrators
     * timestamp is set to now, flowrate and cumulated streem balance are re-calculated based on the previous snapshot
     * and change in flowrate (can be either positive or negative, depending on streem open or close events)
     * @param settledBalance amount to be subtracted from the cumulated expected balance for closed streem(s). TODO: rename?
     */
    function updateDeconcentratorSnapshot(address acc, int deltaFlowrate, uint settledBalance) internal {
        Snapshot storage snap = deconcentratorSnapshots[acc];

        snap.timestamp = block.timestamp;
        // add the delta depending on the time passed since last snapshot, subtract settled balance for closed streem(s)
        snap.cumulatedExpStreemBalance += (block.timestamp - snap.timestamp) * snap.cumulatedExpFlowrate - settledBalance;
        // this double casting isn't pretty. But is it efficient?
        snap.cumulatedExpFlowrate = uint(int(snap.cumulatedExpFlowrate) + deltaFlowrate);
    }

    // ################## Internal constant functions ###################

    // Solidity (so far) has no simple null check, using startTimestamp as guard (assuming 1970 will not come back).
    function exists(Streem storage s) internal view returns (bool) {
        return s.startTime != 0;
    }

    // TODO: what's best practice for using uint vs uint256?
    function min(uint a, uint b) public pure returns (uint) {
        return a < b ? a : b;
    }

    function max(int a, int b) public pure returns (int) {
        return a > b ? a : b;
    }

    /// returns an array of open outgoing streems for the given address
    function getOutStreemsOf(address addr) internal view returns (uint256[] storage) {
        return outStreemPtrs[addr];
        /*
        uint[] storage allArr = outStreemPtrs[addr];
        return filterOpenStreems(allArr);
        */
    }

    function getInStreemsOf(address addr) internal view returns (uint256[] storage) {
        return inStreemPtrs[addr];
        /*
        uint[] storage allArr = inStreemPtrs[addr];
        return filterOpenStreems(allArr);
        */
    }

    function filterOpenStreems(uint[] storage inputIds) internal view returns(Streem[] memory) {
        // TODO: refactor
        // iterate through them and push open ones to a memory array
        // using the upper bound of inputArr.length for allocation size (memory arrays can't be resized)
        // This (I guess creates copies of the Streem items in memory.
        // May be more efficient to return just a list of pointers
        Streem[] memory outputStreems = new Streem[](inputIds.length);
        uint256 cnt = 0;
        for(uint i=0; i<inputIds.length; i++) {
            Streem storage s = streems[inputIds[i]];
            if(exists(s)) {
                outputStreems[cnt] = s;
                cnt++;
            }
        }

        // we want to return an array without empty elements
        Streem[] memory vacuumed = new Streem[](cnt);
        for(uint j=0; j<cnt; j++) {
            vacuumed[j] = outputStreems[j];
        }

        return vacuumed;
    }

    function equals(Streem storage s1, Streem storage s2) internal view returns (bool) {
        // TODO: not multi-streem ready (??what did I mean with that??)
        return s1.sender == s2.sender && s1.receiver == s2.receiver;
    }

    // returns the expected balance of a streem, ignoring the possibility of it running out of funds
    function expectedStreemBalance(Streem storage s) internal view returns (uint256) {
        return (block.timestamp - s.startTime) * s.flowrate;
    }

    function canStreemTo(address sender, address receiver) public view returns(bool) {
        /* Allowed:
        OpenAccount -> Concentrator
        Deconcentrator -> OpenAccount
        Deconcentrator -> Concentrator */
        return ((accountTypes[sender] == AccountType.OpenAccount && accountTypes[receiver] == AccountType.Concentrator) ||
        (accountTypes[sender] == AccountType.Deconcentrator && accountTypes[receiver] == AccountType.OpenAccount) ||
        (accountTypes[sender] == AccountType.Deconcentrator && accountTypes[receiver] == AccountType.Concentrator));
    }

    /// Calculates the expected cumulated balance and flowrate of the outgoing streems of the given account, ignoring solvency
    function cumulatedExpectedOutStreemsBalanceAndFlowrate(address acc) public view returns(uint, uint) {
        // TODO: optimize for deconcentrator
        // TODO: fix naming
        uint256[] storage openOutStreems = getOutStreemsOf(acc);

        uint256 cumOutBalance = 0;
        uint256 cumOutFlowrate = 0;
        for(uint256 i=0; i< openOutStreems.length; i++) {
            Streem storage s = streems[openOutStreems[i]];
            if(! exists(s)) {
                continue;
            }
            cumOutBalance += s.flowrate * (block.timestamp - s.startTime);
            cumOutFlowrate += s.flowrate;
        }
        return (cumOutBalance, cumOutFlowrate);
    }

    function cumulatedInStreemsBalance(address acc) public view returns(uint) {
        // TODO: fix naming
        uint256[] storage openInStreems = getInStreemsOf(acc);

        uint256 cumInBalance = 0;
        for(uint i=0; i< openInStreems.length; i++) {
            Streem storage  s = streems[openInStreems[i]];
            if(! exists(s)) {
                continue;
            }
            cumInBalance += streemBalance(s);
        }
        return cumInBalance;
    }

    /** returns the "real" (accounting for non-guaranteed sender solvency) balance of a streem.
     * This takes the perspective of the sender, making the streem under investigation an outgoing streem.
     */
    function streemBalance(Streem storage s) internal view returns (uint256) {
        (uint cumExpOutBalance, uint cumOutFlowrate) =
        accountTypes[s.sender] == AccountType.Deconcentrator ?
        (deconcentratorSnapshots[s.sender].cumulatedExpStreemBalance, deconcentratorSnapshots[s.sender].cumulatedExpFlowrate)
    : cumulatedExpectedOutStreemsBalanceAndFlowrate(s.sender);
        // TODO optimize: check for required balance instead of full computation
        uint256 cumInBalance = cumulatedInStreemsBalance(s.sender);
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
