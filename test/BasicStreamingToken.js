/* eslint-disable no-undef */
/* eslint-disable indent */
const BasicStreams = artifacts.require('BasicStreamingToken.sol');
const utils = require('./utils');
const BN = web3.utils.BN;
const should = require('should'); // eslint-disable-line

contract('BasicStreamingToken', (accounts) => {

    require('./eip20').test(web3, accounts, BasicStreams);

    describe('ERC2100', function() {
        let contract;

        const sheikh = accounts[0];
        const default1 = accounts[1];
        const default2 = accounts[2];
        const concentrator1 = accounts[3];
        const concentrator2 = accounts[4];
        const deconcentrator1 = accounts[5];
        const deconcentrator2 = accounts[6];

        const DEFAULT = 0; // set by default
        const CONCENTRATOR = 1;
        const DECONCENTRATOR = 2;

        const INIT_BALANCE = 1000000;

        BasicStreams.prototype.getBalancesOf = utils.prototypeMethods.getBalancesOf;
        BasicStreams.prototype.openStreamWrapper = utils.prototypeMethods.openStreamWrapper;
        BasicStreams.prototype.closeStreamWrapper = utils.prototypeMethods.closeStreamWrapper;
        /*
        async function(accArr) {
        return Promise.all(accArr.map(acc => this.balanceOf(acc)));
    };*/

        beforeEach(async function () {
            contract = await BasicStreams.new(INIT_BALANCE, "Basic Test Token", "BTT", 1);

            // distribute over 3 accounts
            contract.transfer(default1, OPEN_INITIAL_FUNDS, {from: sheikh});
            contract.transfer(deconcentrator1, DECONCENTRATOR_INITIAL_FUNDS, {from: sheikh});
            contract.transfer(deconcentrator2, DECONCENTRATOR_INITIAL_FUNDS, {from: sheikh});

            // set 2 accounts as concentrator and 2 as deconcentrator (the others remain open accounts)
            await Promise.all([
                contract.setAccountType(CONCENTRATOR, {from: concentrator1}),
                contract.setAccountType(CONCENTRATOR, {from: concentrator2}),
                contract.setAccountType(DECONCENTRATOR, {from: deconcentrator1}),
                contract.setAccountType(DECONCENTRATOR, {from: deconcentrator2}),
            ]);
        });

        // =========== HELPERS ===========


        // take a snapshot to which we can return later and return the id
        function takeSnapshot() {
            return;
        }

        // revert to the snapshot with the given id. Returns true on success
        function revertToSnapshot(id) {
            return;
        }

        // batch opens multiple streams and returns a promise to the open event it emitted
        async function openMultipleStreamsWrapper(sender, receivers, flowrate) {
            const ret = await contract.openMultipleStreams(receivers, flowrate, {from: sender});
            return utils.buildTxReturnObject(ret, 'StreamsOpened');
        }

        async function closeMultipleStreamsWrapper(sender, streamIds) {
            const ret = await contract.closeMultipleStreams(streamIds, {from: sender});
            return utils.buildTxReturnObject(ret, '');
        }


        // return a balance adjusted by flowrate if underfunded
        function adjBal(shouldBal, flowrate) {
            /* curiously, modulo of a negative dividend is defined differently in various languages. In JS, it can be negative.
            Fun fact: for C90 it isn't defined, but implementation specific. See https://en.wikipedia.org/wiki/Modulo_operation#Remainder_calculation_for_the_modulo_operation */
            return Math.max(shouldBal, ((shouldBal % flowrate) + flowrate) % flowrate);
        }

        // =========== TESTS ===========

        // CAUTION! Do not expect tests to pass after changes here as several cases are hardcoded to match this numbers!
        const OPEN_INITIAL_FUNDS = 1000;
        const DECONCENTRATOR_INITIAL_FUNDS = 10000;

        it('static transfers', async () => {
            contract.transfer(default1, OPEN_INITIAL_FUNDS, {from: sheikh});
            contract.transfer(deconcentrator1, DECONCENTRATOR_INITIAL_FUNDS, {from: sheikh});
            contract.transfer(deconcentrator2, DECONCENTRATOR_INITIAL_FUNDS, {from: sheikh});
        });

        /*
        let snapshotAfterInit = 0;
        it('configure accounts (type)', async () => {
            await Promise.all([
                setAccountToType(concentrator1, CONCENTRATOR),
                setAccountToType(concentrator2, CONCENTRATOR),
                setAccountToType(deconcentrator1, DECONCENTRATOR),
                setAccountToType(deconcentrator2, DECONCENTRATOR) ]);

            // take a snapshot to which we can revert later
            snapshotAfterInit = takeSnapshot();
        });
        */

        it('check random account type', async () => {
            const accType = await contract.getAccountType({from: deconcentrator2});
            assert.equal(accType.toNumber(), DECONCENTRATOR);
        });

        /*
         * Start stream with flowrate 1 from default1 to concentrator1
         * wait 100
         * check balances
         * wait 2000
         * check balances (expected: sender should be drained)
         * close stream
         * check balances (expected: no change)
         */
        it('1 stream: from default1 to concentrator1', async () => {
            const flowrate = 1;
            const duration = 100;
            const stream1Open = await contract.openStreamWrapper(default1, concentrator1, 1);
            // const snapshotSingleStream = takeSnapshot();

            let lastBlockTs = await utils.fastForward(duration);
            let [balDefault1, balConcentrator1] = await contract.getBalancesOf([default1, concentrator1]);
            //console.log(`balDefault1: ${balDefault1}, lastBlockTs: ${lastBlockTs}`);
            assert.equal(OPEN_INITIAL_FUNDS - flowrate * duration, balDefault1);
            assert.equal(flowrate * duration, balConcentrator1);

            // let it run long enough for the stream to get unfunded, than check balances
            await utils.fastForward(1900);
            [balDefault1, balConcentrator1] = await contract.getBalancesOf([default1, concentrator1]);
            assert.equal(0, balDefault1.toNumber());
            assert.equal(OPEN_INITIAL_FUNDS, balConcentrator1);

            contract.closeStream(stream1Open.id, {from: default1});
            [balDefault1, balConcentrator1] = await contract.getBalancesOf([default1, concentrator1]);
            assert.equal(0, balDefault1.toNumber());
            assert.equal(OPEN_INITIAL_FUNDS, balConcentrator1);
        });


        /*
         * Check behaviour of concurrent outgoing streams when funded and underfunded:
         * Start stream1 with flowrate 1 from default1 to concentrator1
         * Start stream2 with flowrate 1 from default1 to concentrator1
         * wait 100
         * check balances
         * wait 900
         * check balances (expected: default1 empty, 500 in concentrator[1|2]
         * close stream2
         * wait 100
         * check balances (expected: no change)
         * refund default1 with 700 units
         * check balances (expected: stream1 fully funded)
         */
        it('2 streams: from default1 to concentrator1 and concentrator2', async () => {
            const [stream1Open, stream2Open] = await Promise.all([
                contract.openStreamWrapper(default1, concentrator1, 1),
                contract.openStreamWrapper(default1, concentrator2, 1),
            ]); // maximize probability of same timestamp
            // this assertion avoids spurious failures caused by different stream start times (not expected, but possible)

            let lastBlockTs = await utils.fastForward(100);
            let [balDefault1, balConcentrator1, balConcentrator2] = await contract.getBalancesOf([default1, concentrator1, concentrator2]);
            // console.log(`a: balances after ${runtime_a}s: default1: ${balDefault1_a}, c1: ${balConcentrator1_a}, c2: ${balConcentrator2_a}`);
            //let lastBlockTs = await utils.getLastBlockTimestamp();
            let s1ShouldBalance = 100 * 1;
            const s2ShouldBalance = 100 * 1;

            assert.equal(OPEN_INITIAL_FUNDS - (s1ShouldBalance + s2ShouldBalance), balDefault1);
            assert.equal(s1ShouldBalance, balConcentrator1);
            assert.equal(s2ShouldBalance, balConcentrator2);

            await utils.fastForward(900);
            [balDefault1, balConcentrator1, balConcentrator2] = await contract.getBalancesOf([default1, concentrator1, concentrator2]);
            // console.log(`b: balances after ${runtime_b}s: default1: ${balDefault1_b}, c1: ${balConcentrator1_b}, c2: ${balConcentrator2_b}`);
            assert.equal(0, balDefault1);
            assert.equal(500, balConcentrator1);
            assert.equal(500, balConcentrator2);

            // now close one stream, forward 100 more, refund default1 and check all balances
            const stream2Close = await contract.closeStreamWrapper(default1, stream2Open.id);
            await utils.fastForward(100);
            [balDefault1, balConcentrator1, balConcentrator2] = await contract.getBalancesOf([default1, concentrator1, concentrator2]);
            // console.log(`b: balances after ${runtime_b}s: default1: ${balDefault1_b}, c1: ${balConcentrator1_b}, c2: ${balConcentrator2_b}`);
            assert.equal(0, balDefault1);
            assert.equal(500, balConcentrator1);
            assert.equal(500, balConcentrator2);

            // ~500 are immediately consumed by the remaining open stream
            contract.transfer(default1, 700, {from: sheikh});

            [balDefault1, balConcentrator1, balConcentrator2] = await contract.getBalancesOf([default1, concentrator1, concentrator2]);
            // console.log(`c: balances after ${runtime_c}s: default1: ${balDefault1_c}, c1: ${balConcentrator1_c}, c2: ${balConcentrator2_c}`);
            s1ShouldBalance = (await utils.getLastBlockTimestamp() - stream1Open.blockTimestamp) * 1;
            assert.equal(OPEN_INITIAL_FUNDS + 700 - 500 - s1ShouldBalance, balDefault1);
            assert.equal(500, balConcentrator2); // was closed before refund
            assert.equal(s1ShouldBalance, balConcentrator1);
            // finally, make sure nothing was created / lost overall
            assert.equal(OPEN_INITIAL_FUNDS + 700, balDefault1.add(balConcentrator1).add(balConcentrator2));
        });

        /*
         * Start stream1 with flowrate 2 from deconcentrator1 to default1
         * Wait 30
         * Start stream2 with flowrate 3 from default1 to concentrator1
         * wait 100
         * check balances
         * close stream2
         * check balances
         * wait 50
         * check balances
         * close stream1
         * check balances
         */
        it('two-way account, deconcentrator -> open -> concentrator1 - fully funded', async () => {
            const stream1Open = await contract.openStreamWrapper(deconcentrator1, default1, 3);
            await utils.fastForward(30); // let ~90 units flow in stream1
            const stream2Open = await contract.openStreamWrapper(default1, concentrator1, 2);
            await utils.fastForward(100); // let flow another ~300 units in stream1 and ~200 units in stream2

            let [balDefault1, balDeconcentrator1, balConcentrator1] = await contract.getBalancesOf([default1, deconcentrator1, concentrator1]);
            // console.log(`streams open - balances: default1: ${balDefault1}, deconcentrator1: ${balDeconcentrator1}, concentrator1: ${balConcentrator1}`);
            let lastBlockTs = await utils.getLastBlockTimestamp();
            let s1ShouldBalance = (lastBlockTs - stream1Open.blockTimestamp) * 3;
            let s2ShouldBalance = (lastBlockTs - stream2Open.blockTimestamp) * 2;
            assert.equal(DECONCENTRATOR_INITIAL_FUNDS - s1ShouldBalance, balDeconcentrator1);
            assert.equal(OPEN_INITIAL_FUNDS + s1ShouldBalance - s2ShouldBalance, balDefault1);
            assert.equal(0 + s2ShouldBalance, balConcentrator1);

            const stream2Close = await contract.closeStreamWrapper(default1, stream2Open.id);
            [balDefault1, balDeconcentrator1, balConcentrator1] = await contract.getBalancesOf([default1, deconcentrator1, concentrator1]);
            // console.log(`stream2 closed - balances: default1: ${balDefault1}, deconcentrator1: ${balDeconcentrator1}, concentrator1: ${balConcentrator1}`);
            s1ShouldBalance = (await utils.getLastBlockTimestamp() - stream1Open.blockTimestamp) * 3;
            s2ShouldBalance = (stream2Close.blockTimestamp - stream2Open.blockTimestamp) * 2;
            assert.equal(DECONCENTRATOR_INITIAL_FUNDS - s1ShouldBalance, balDeconcentrator1);
            assert.equal(OPEN_INITIAL_FUNDS + s1ShouldBalance - s2ShouldBalance, balDefault1);
            assert.equal(0 + s2ShouldBalance, balConcentrator1);

            await utils.fastForward(50); // let ~150 more units flow in stream1
            [balDefault1, balDeconcentrator1, balConcentrator1] = await contract.getBalancesOf([default1, deconcentrator1, concentrator1]);
            s1ShouldBalance = (await utils.getLastBlockTimestamp() - stream1Open.blockTimestamp) * 3;
            s2ShouldBalance = (stream2Close.blockTimestamp - stream2Open.blockTimestamp) * 2;
            assert.equal(DECONCENTRATOR_INITIAL_FUNDS - s1ShouldBalance, balDeconcentrator1);
            assert.equal(OPEN_INITIAL_FUNDS + s1ShouldBalance - s2ShouldBalance, balDefault1);
            assert.equal(0 + s2ShouldBalance, balConcentrator1);

            const stream1Close = await contract.closeStreamWrapper(deconcentrator1, stream1Open.id);
            [balDefault1, balDeconcentrator1, balConcentrator1] = await contract.getBalancesOf([default1, deconcentrator1, concentrator1]);
            // console.log(`both streams closed - balances: default1: ${balDefault1}, deconcentrator1: ${balDeconcentrator1}, concentrator1: ${balConcentrator1}`);
            s1ShouldBalance = (stream1Close.blockTimestamp - stream1Open.blockTimestamp) * 3;
            s2ShouldBalance = (stream2Close.blockTimestamp - stream2Open.blockTimestamp) * 2;
            assert.equal(DECONCENTRATOR_INITIAL_FUNDS - s1ShouldBalance, balDeconcentrator1);
            assert.equal(OPEN_INITIAL_FUNDS + s1ShouldBalance - s2ShouldBalance, balDefault1);
            assert.equal(0 + s2ShouldBalance, balConcentrator1);
        });

        /*
         * Start stream2 with flowrate 9 from default1 to concentrator1
         * wait 200
         * check balances (expected: default1: 0)
         * Start stream1 with flowrate 5 from deconcentrator1 to default1
         * wait 1000
         * check balances (expected: default1: 0, concentrator1: 6000)
         * close stream2
         * wait 100
         * check balances (expected: default1: 500)
         */
        it('two-way account, deconcentrator -> open -> concentrator1 - varying funding', async () => {
            const stream2Open = await contract.openStreamWrapper(default1, concentrator1, 9);
            await utils.fastForward(200); // let all 1000 available units flow
            let [balDefault1, balDeconcentrator1, balConcentrator1] = await contract.getBalancesOf([default1, deconcentrator1, concentrator1]);
            // console.log(`default1 empty - balances: default1: ${balDefault1}, deconcentrator1: ${balDeconcentrator1}, concentrator1: ${balConcentrator1}`);
            let s2ShouldBalance = 200 * 9;
            let default1ExpBal = adjBal(OPEN_INITIAL_FUNDS - s2ShouldBalance, 9);
            assert.equal(default1ExpBal, balDefault1.toNumber(), 'Sender balance is zero or equal to the remainder of division by flowrate');
            assert.equal(OPEN_INITIAL_FUNDS - default1ExpBal, balConcentrator1.toNumber(), 'Receiver balance equals stream balance');

            const stream1Open = await contract.openStreamWrapper(deconcentrator1, default1, 5);
            await utils.fastForward(1000);
            [balDefault1, balDeconcentrator1, balConcentrator1] = await contract.getBalancesOf([default1, deconcentrator1, concentrator1]);
            //console.log(`both open - balances: default1: ${balDefault1}, deconcentrator1: ${balDeconcentrator1}, concentrator1: ${balConcentrator1} - type ${typeof balDefault1}`);
            let lastBlockTs = await utils.getLastBlockTimestamp();
            const s1ShouldBalance = (lastBlockTs - stream1Open.blockTimestamp) * 5;
            s2ShouldBalance = (lastBlockTs - stream2Open.blockTimestamp) * 9;
            default1ExpBal = adjBal(OPEN_INITIAL_FUNDS + s1ShouldBalance - s2ShouldBalance, 9);
            assert.equal(default1ExpBal, balDefault1.toNumber());
            assert.equal(OPEN_INITIAL_FUNDS + s1ShouldBalance - default1ExpBal, balConcentrator1.toNumber());
            assert.equal((balDefault1.add(balDeconcentrator1).add(balConcentrator1)).toNumber(), DECONCENTRATOR_INITIAL_FUNDS + 1000);

            const stream2Close = await contract.closeStreamWrapper(default1, stream2Open.id);
            await utils.fastForward(100);
            [balDefault1, balDeconcentrator1, balConcentrator1] = await contract.getBalancesOf([default1, deconcentrator1, concentrator1]);
            assert(balDefault1.toNumber() >= 5 * 100);
            assert.equal((balDefault1.add(balDeconcentrator1).add(balConcentrator1)).toNumber(), DECONCENTRATOR_INITIAL_FUNDS + 1000);
        });

        /*
         * TODO: missing tests
         * - check if limit for nr of open streams is enforced
         * - measure upper bound of gas usage
         * - measure gas usage of TXs for open accounts depending on open streams and connected accounts
         * - simulate big network
         */


        /*
        it('complex scenario 1', async() => {
            // 100 streams from deconcentrator to open + 100 streams from deconcentrator to concentrator, 100 streams from open to concentrator
            assert.isOk(revertToSnapshot(snapshotAfterInit));

            let streamPromises = new Array();
            [...Array(5)].forEach((_, i) => streamPromises.push(openStreamAndGetEvent(deconcentrator1, default1, 1)));
            let lastBlockTs = getLastBlockTimestamp();
            const runtime_a = fastForward(10) - lastBlockTs;
            [...Array(5)].forEach((_, i) => streamPromises.push(openStreamAndGetEvent(deconcentrator1, default1, 2)));
            lastBlockTs = getLastBlockTimestamp();
            const runtime_b = fastForward(10) - lastBlockTs;

            [...Array(5)].forEach((_, i) => streamPromises.push(openStreamAndGetEvent(deconcentrator1, concentrator1, 1)));

            [...Array(5)].forEach((_, i) => streamPromises.push(openStreamAndGetEvent(default1, concentrator1, 1)));
            lastBlockTs = getLastBlockTimestamp();
            const runtime_c = fastForward(50) - lastBlockTs;
            await Promise.all(streamPromises);

            const [balDefault1_a, balDeconcentrator1_a, balConcentrator1_a] = await getBalancesOf([default1, deconcentrator1, concentrator1]);
            console.log(`a balances: default1: ${balDefault1_a}, deconcentrator1: ${balDeconcentrator1_a}, concentrator1: ${balConcentrator1_a}`)

        });
        */
    });
});
