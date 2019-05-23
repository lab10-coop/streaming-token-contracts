/* sets the clock "time" seconds into the future and triggers mining of a new block.
Supported only by testrpc / ganache.
@returns the timestamp of the newly mined block */

async function assertRevert(promise) {
    try {
        await promise;
    } catch (error) {
        // TODO: is there a sane way to recognize the failure reason?
//      const revertFound = error.message.search('Error') >= 0;
//      assert(revertFound, `Expected "revert", got ${error} instead`);
        return;
    }
    assert.fail('Expected revert not received');
}

async function getLastBlockTimestamp() {
    return (await web3.eth.getBlock(await web3.eth.getBlockNumber())).timestamp;
}

async function slowForward(time_s) {
    await sleep(time_s);
    return await getLastBlockTimestamp();
}

// this implementation is susceptible to random flipping seconds, because it
// seems to use the chain clock as reference (instead of last block timestamp)
async function unsafefastForward(time_s) {
    // this is what seems to work with web3 1.0.0-beta.55
    //await web3.currentProvider.send('evm_increaseTime', [ time_s ]);
    //await web3.currentProvider.send('evm_mine');

    // this is what seems to work with web3 1.0.0-beta.37
    await web3.currentProvider.send({
        jsonrpc: '2.0',
        method: 'evm_increaseTime',
        params: [ time_s ],
        }, () => {});

    await web3.currentProvider.send({
        jsonrpc: '2.0',
        method: 'evm_mine',
    }, () => {});

    return await getLastBlockTimestamp();
}

async function fastForward(offset) {
    const t0 = await getLastBlockTimestamp();
    await alignToSystemClock();
    await mineBlockWithTS(t0 + offset);
    return t0 + offset;
}

// if the system clock is about to switch second (<500 ms offset), this waits until the switch happens
async function alignToSystemClock() {
    const gapMs = 1000 - new Date().getMilliseconds();
    if(gapMs < 500) {
        console.log(`aligning to system clock - waiting ${gapMs}`);
        await sleepMs(gapMs + 1);
        if(new Date().getMilliseconds() > 100) {
            console.log('WTF!');
        }
    }
}

// sets the time of the chain. Doesn't produce a block!
async function setChainTimestamp(ts) {
    await web3.currentProvider.send({
        jsonrpc: '2.0',
        method: 'evm_setTimestamp',
        params: [ ts ],
    }, () => {});
}

async function disableInstamine() {
    await web3.currentProvider.send({
        jsonrpc: '2.0',
        method: 'miner_stop',
        params: [],
    }, () => {});
}

async function enableInstamine() {
    await web3.currentProvider.send({
        jsonrpc: '2.0',
        method: 'miner_start',
        params: [],
    }, () => {});
}


// mines a block with whatever timestamp the chain clock currently has
async function mineBlock() {
    await web3.currentProvider.send({
        jsonrpc: '2.0',
        method: 'evm_mine',
        params: [],
    }, () => {});
}

// Mines a new block with the given timestamp and sets the chain internal clock to the same TS
// the caller is responsible to not let the time run backwards relative to the last block
async function mineBlockWithTS(ts) {
    await web3.currentProvider.send({
        jsonrpc: '2.0',
        method: 'evm_mine',
        params: [ts],
    }, () => {});

    await setChainTimestamp(ts);
}

// creates an object containing txHash, blockNumber, blockTimestamp and the elements of the requested event
function buildTxReturnObject(txRet, eventName) {
    const o = {};
    o.txHash = txRet.tx;
    o.blockNumber = txRet.receipt.blockNumber;
    o.blockTimestamp = web3.eth.getBlock(txRet.receipt.blockNumber).timestamp;
    o.gasUsed = txRet.receipt.cumulativeGasUsed;
    const event = txRet.logs.filter(e => e.event === eventName)[0];
    if (event) {
        Object.assign(o, event.args); // merge event into o
    }
    // console.log(`buildTxReturnObject returns ${JSON.stringify(o)}`);
    return o;
}

function sleep(s) {
    return new Promise(resolve => setTimeout(resolve, s * 1000));
}

function sleepMs(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

// returns a Promise for an array of requested balances
function getBalancesOf(accArr) {
    return Promise.all(accArr.map(acc => contract.balanceOf(acc)));
}


module.exports = {
    assertRevert,
    getLastBlockTimestamp,
    fastForward,
    slowForward,
    buildTxReturnObject,
    sleep,
    setChainTimestamp,
    disableInstamine,
    enableInstamine,
    mineBlockWithTS,
    mineBlock,
    getBalancesOf
};
