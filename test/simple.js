/*
 * Behaviour of the development chain:
 * A new block is mined for every tx (Instamine), no blocks are mined in the absence of txs.
 * The block timestamp depends on the current time. Consecutive blocks can have the same timestamp.
 * evm_increaseTime (not available for production EVMs) can be used to fast forward the chain (block timestamp).
 *
 * See conversation in https://github.com/trufflesuite/ganache-core/issues/388
 *
 * However that didn't really solve the issue.
 * There's one issue left:
 * Even after halting instamine, the clock of the development chain still keeps running.
 * What's worse: constant calls to contract methods using block.timestamp use the current time of this clock
 * instead of the actual timestamp of the last block. This is not how production chains behave.
 * In order to mitigate that, such constant methods calls are issued in parallel instead of sequentially (getBalancesOf).
 * That seems to help. Still not an elegant solution, tests may still sporadically fail on slow/busy systems.
 */


const TokenContract = artifacts.require('SimpleERC20xxToken');

const utils = require('./utils');

const BN = web3.utils.BN;

let token;

TokenContract.prototype.openStreamWrapper = async function(receiver, flowrate, maxAmount, opts) {
    const ret = await this.openStream(receiver, flowrate, maxAmount, opts);
    return utils.buildTxReturnObject(ret, 'StreamOpened');
};

// returns a Promise for an array of requested balances
TokenContract.prototype.getBalancesOf = async function(accArr) {
    return Promise.all(accArr.map(acc => this.balanceOf(acc)));
};

console.log(`version: ${web3.version}`);

contract('SimpleERC20xxToken', (accounts) => {
    const INIT_BALANCE = 10000;

    beforeEach(async () => {
        utils.enableInstamine();
        token = await TokenContract.new(INIT_BALANCE, 'Simple Tokens', 'STK', 1, {from: accounts[0]});

        /*
        // opens a streem and returns a promise to the open event it emitted
        token.openStreamWrapper = async function(receiver, flowrate, maxAmount, opts) {
            const ret = await token.openStream(receiver, flowrate, maxAmount, opts);
            return utils.buildTxReturnObject(ret, 'StreamOpened');
        }*/
    });

    it(`creation: should create an initial balance of ${INIT_BALANCE} for the creator`, async () => {
        const balance = await token.balanceOf.call(accounts[0]);
    });

    it('should allow to open a stream to another account', async () => {
        await token.openStreamWrapper(accounts[1], 1, 0, { from: accounts[0] });
    });

    it('transfer correct amount (single stream)', async () => {
        const flowrate = 2;
        const duration = 4;
        await token.openStream(accounts[1], flowrate, 0, { from: accounts[0] });
        await utils.fastForward(duration);
        //await utils.mineBlockWithTS(await utils.getLastBlockTimestamp() + duration);

        const [ bal0, bal1 ] = await token.getBalancesOf([accounts[0], accounts[1]]);

        assert.strictEqual(bal0.toNumber(), INIT_BALANCE - flowrate*duration);
        assert.strictEqual(bal1.toNumber(), flowrate*duration);
    });

    /*
     * a0 --> a1 -> a2
     * expected result: a0--, a1+, a2+
     */
    it('chained streams behave correctly', async () => {
        const flowrate1 = 2;
        const flowrate2 = 1;
        const duration = 4;

        //await utils.mineBlock();
//        const t0 = await utils.getLastBlockTimestamp() + 1;
//        await utils.disableInstamine();
        await Promise.all([
            token.openStream(accounts[1], flowrate1, 0, { from: accounts[0] }),
            token.openStream(accounts[2], flowrate2, 0, { from: accounts[1] }),
        ]);
        await utils.disableInstamine();
        await utils.fastForward(duration);

        //const t0 = await utils.getLastBlockTimestamp();
//        console.log(`last block: ${JSON.stringify(await web3.eth.getBlock(await web3.eth.getBlockNumber()), null, 2)}`);


        //const tx1 = token.openStream(accounts[1], flowrate1, 0, { from: accounts[0] });
        //utils.sleep(1);
        /*await utils.mineBlockWithTS(t0);
        console.log(`last block: ${JSON.stringify(await web3.eth.getBlock(await web3.eth.getBlockNumber()), null, 2)}`);
        await utils.mineBlockWithTS(t0);
        console.log(`last block: ${JSON.stringify(await web3.eth.getBlock(await web3.eth.getBlockNumber()), null, 2)}`);
        await openProms;*/

        //await openProms;
        //utils.sleep(1);

        //const t1 = t0 + duration;
        //await utils.mineBlockWithTS(t1);
//        console.log(`last block: ${JSON.stringify(await web3.eth.getBlock(await web3.eth.getBlockNumber()), null, 2)}`);
        //await tx1;

        //const t1 = await utils.fastForward(duration);
        //const bn = await web3.eth.getBlockNumber();

        //console.log(`t0: ${t0}, t1: ${t1}, bn: ${bn}`);

        //await utils.slowForward(1);

        const [ bal0, bal1, bal2 ] = await token.getBalancesOf([accounts[0], accounts[1], accounts[2]]);
        console.log(`time: ${new Date().getMilliseconds()}`);
        /*
        const bal0 = await token.balanceOf.call(accounts[0]);
        utils.setChainTimestamp(t1);
        const bal1 = await token.balanceOf(accounts[1]);
        utils.setChainTimestamp(t1);
        const bal2 = await token.balanceOf(accounts[2]);
        */

        console.log(`bal0 ${bal0.toNumber()}, bal1 ${bal1.toNumber()}, bal2 ${bal2.toNumber()}`);

        assert.strictEqual(bal0.toNumber(), INIT_BALANCE - flowrate1*duration);
        assert.strictEqual(bal1.toNumber(), Math.max(0, flowrate1*duration - flowrate2*duration));
        assert.strictEqual(bal2.toNumber(), Math.min(flowrate1*duration, flowrate2*duration));
        //console.log(``)
    });
});
