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


const TokenContract = artifacts.require('SimpleStreamingToken');

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

contract('SimpleStreamingToken', (accounts) => {

    require('./eip20').test(web3, accounts, TokenContract);

    describe('ERC2100', function() {
        const INIT_BALANCE = 10000;

        beforeEach(async () => {
            utils.enableInstamine();
            token = await TokenContract.new(INIT_BALANCE, 'Simple Tokens', 'STK', 1, {from: accounts[0]});
        });

        it('should allow to open a stream to another account', async () => {
            await token.openStreamWrapper(accounts[1], 1, 0, {from: accounts[0]});
        });

        it('single stream behaves correctly', async () => {
            const flowrate = 2;
            const duration = 4;
            const s = await token.openStreamWrapper(accounts[1], flowrate, 0, {from: accounts[0]});
            await utils.fastForward(duration);

            let [bal0, bal1] = await token.getBalancesOf([accounts[0], accounts[1]]);

            assert.strictEqual(bal0.toNumber(), INIT_BALANCE - flowrate * duration);
            assert.strictEqual(bal1.toNumber(), flowrate * duration);

            await token.closeStream(s.id, {from: accounts[0]});
            [bal0, bal1] = await token.getBalancesOf([accounts[0], accounts[1]]);
            assert.strictEqual(bal0.toNumber(), INIT_BALANCE - flowrate * duration);
            assert.strictEqual(bal1.toNumber(), flowrate * duration);
        });

        it('funds of open stream can be transferred right away', async () => {
            const flowrate = 2;
            const duration = 4;
            const s = await token.openStreamWrapper(accounts[1], flowrate, 0, {from: accounts[0]});
            await utils.fastForward(duration);

            // forward full amount received through stream to a third account
            await token.transfer(accounts[2], flowrate*duration, {from: accounts[1]});

            const [bal0, bal1, bal2] = await token.getBalancesOf([accounts[0], accounts[1], accounts[2]]);
            assert.strictEqual(bal0.toNumber(), INIT_BALANCE - flowrate * duration);
            assert.strictEqual(bal1.toNumber(), 0);
            assert.strictEqual(bal2.toNumber(), flowrate*duration);
        });

        it('no unauthorized closing of stream possible', async () => {
            const flowrate = 2;
            const s = await token.openStreamWrapper(accounts[1], flowrate, 0, {from: accounts[0]});

            await utils.assertRevert(token.closeStream(s.id, {from: accounts[2]}));
        });

        it('receiver can close stream', async () => {
            const flowrate = 2;
            const s = await token.openStreamWrapper(accounts[1], flowrate, 0, {from: accounts[0]});

            await token.closeStream(s.id, {from: accounts[1]});
        });

        /*
         * a0 --> a1 -> a2
         * expected result: a0--, a1+, a2+
         */
        it('chained streams behave correctly', async () => {
            const flowrate1 = 2;
            const flowrate2 = 1;
            const duration = 4;

            const [s1, s2] = await Promise.all([
                token.openStreamWrapper(accounts[1], flowrate1, 0, {from: accounts[0]}),
                token.openStreamWrapper(accounts[2], flowrate2, 0, {from: accounts[1]}),
            ]);
            await utils.fastForward(duration);

            let [bal0, bal1, bal2] = await token.getBalancesOf([accounts[0], accounts[1], accounts[2]]);

            assert.strictEqual(bal0.toNumber(), INIT_BALANCE - flowrate1 * duration);
            assert.strictEqual(bal1.toNumber(), Math.max(0, flowrate1 * duration - flowrate2 * duration));
            assert.strictEqual(bal2.toNumber(), Math.min(flowrate1 * duration, flowrate2 * duration));

            // check: same state after closing
            await token.closeStream(s1.id, {from: accounts[0]});
            await token.closeStream(s2.id, {from: accounts[1]});

            [bal0, bal1, bal2] = await token.getBalancesOf([accounts[0], accounts[1], accounts[2]]);

            assert.strictEqual(bal0.toNumber(), INIT_BALANCE - flowrate1 * duration);
            assert.strictEqual(bal1.toNumber(), Math.max(0, flowrate1 * duration - flowrate2 * duration));
            assert.strictEqual(bal2.toNumber(), Math.min(flowrate1 * duration, flowrate2 * duration));
        });

        /*
         * a0 -> a1 --> a2
         * expected result: a0-, a=, a2+
         */
        it('underfunded stream behaves correctly', async () => {
            const flowrate1 = 1;
            const flowrate2 = 2;
            const duration = 4;

            const [s1, s2] = await Promise.all([
                token.openStreamWrapper(accounts[1], flowrate1, 0, {from: accounts[0]}),
                token.openStreamWrapper(accounts[2], flowrate2, 0, {from: accounts[1]}),
            ]);
            await utils.fastForward(duration);

            let [bal0, bal1, bal2] = await token.getBalancesOf([accounts[0], accounts[1], accounts[2]]);

            assert.strictEqual(bal0.toNumber(), INIT_BALANCE - flowrate1 * duration);
            assert.strictEqual(bal1.toNumber(), Math.max(0, flowrate1 * duration - flowrate2 * duration));
            assert.strictEqual(bal2.toNumber(), Math.min(flowrate1 * duration, flowrate2 * duration));

            // check: same state after closing
            await token.closeStream(s1.id, {from: accounts[0]});
            await token.closeStream(s2.id, {from: accounts[1]});
            [bal0, bal1, bal2] = await token.getBalancesOf([accounts[0], accounts[1], accounts[2]]);

            assert.strictEqual(bal0.toNumber(), INIT_BALANCE - flowrate1 * duration);
            assert.strictEqual(bal1.toNumber(), Math.max(0, flowrate1 * duration - flowrate2 * duration));
            assert.strictEqual(bal2.toNumber(), Math.min(flowrate1 * duration, flowrate2 * duration));
        });

        /*
         * a0 --> a1 -> a0
         * expected result: a0-, a1+
         */
        it('circular streams behave correctly', async () => {
            const flowrate1 = 2;
            const flowrate2 = 1;
            const duration = 4;

            const [s1, s2] = await Promise.all([
                token.openStreamWrapper(accounts[1], flowrate1, 0, {from: accounts[0]}),
                token.openStreamWrapper(accounts[0], flowrate2, 0, {from: accounts[1]}),
            ]);
            await utils.fastForward(duration);

            let [bal0, bal1] = await token.getBalancesOf([accounts[0], accounts[1]]);

            assert.strictEqual(bal0.toNumber(), Math.min(INIT_BALANCE, INIT_BALANCE - flowrate1 * duration + flowrate2 * duration));
            assert.strictEqual(bal1.toNumber(), Math.max(0, flowrate1 * duration - flowrate2 * duration));

            // check: same state after closing
            await token.closeStream(s1.id, {from: accounts[0]});
            await token.closeStream(s2.id, {from: accounts[1]});
            [bal0, bal1] = await token.getBalancesOf([accounts[0], accounts[1]]);

            assert.strictEqual(bal0.toNumber(), Math.min(INIT_BALANCE, INIT_BALANCE - flowrate1 * duration + flowrate2 * duration));
            assert.strictEqual(bal1.toNumber(), Math.max(0, flowrate1 * duration - flowrate2 * duration));
        });

        /*
         * TODO: add tests for
         * - enforcement of max recursion depth
         * - canOpenStream()
         * - getStreamInfo()
         * - correct type value in Transfer events
         */
    });
});
