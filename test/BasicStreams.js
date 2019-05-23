/* eslint-disable no-undef */
/* eslint-disable indent */
const BasicStreams = artifacts.require('BasicStreams.sol');
const utils = require('./utils');
const BN = web3.utils.BN;
const should = require('should'); // eslint-disable-line

contract('BasicStreams', (accounts) => {

    require('./eip20').test(web3, accounts, BasicStreams);

    describe('ERC20xx', function() {
        let contract;

        const sheikh = accounts[0];
        const open1 = accounts[1];
        const open2 = accounts[2];
        const concentrator1 = accounts[3];
        const concentrator2 = accounts[4];
        const deconcentrator1 = accounts[5];
        const deconcentrator2 = accounts[6];

        const OPEN_ACCOUNT = 0; // set by default
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
            contract.transfer(open1, OPEN_INITIAL_FUNDS, {from: sheikh});
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

        // batch opens multiple streems and returns a promise to the open event it emitted
        async function openMultipleStreemsWrapper(sender, receivers, flowrate) {
            const ret = await contract.openMultipleStreems(receivers, flowrate, {from: sender});
            return utils.buildTxReturnObject(ret, 'StreemsOpened');
        }

        async function closeMultipleStreemsWrapper(sender, streemIds) {
            const ret = await contract.closeMultipleStreems(streemIds, {from: sender});
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
            contract.transfer(open1, OPEN_INITIAL_FUNDS, {from: sheikh});
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
         * Start streem with flowrate 1 from open1 to concentrator1
         * wait 100
         * check balances
         * wait 2000
         * check balances (expected: sender should be drained)
         * close streem
         * check balances (expected: no change)
         */
        it('1 streem: from open1 to concentrator1', async () => {
            const flowrate = 1;
            const duration = 100;
            const streem1Open = await contract.openStreamWrapper(open1, concentrator1, 1);
            // const snapshotSingleStreem = takeSnapshot();

            let lastBlockTs = await utils.fastForward(duration);
            let [balOpen1, balConcentrator1] = await contract.getBalancesOf([open1, concentrator1]);
            //console.log(`balOpen1: ${balOpen1}, lastBlockTs: ${lastBlockTs}`);
            assert.equal(OPEN_INITIAL_FUNDS - flowrate * duration, balOpen1);
            assert.equal(flowrate * duration, balConcentrator1);

            // let it run long enough for the streem to get unfunded, than check balances
            await utils.fastForward(1900);
            [balOpen1, balConcentrator1] = await contract.getBalancesOf([open1, concentrator1]);
            assert.equal(0, balOpen1.toNumber());
            assert.equal(OPEN_INITIAL_FUNDS, balConcentrator1);

            contract.closeStream(streem1Open.id, {from: open1});
            [balOpen1, balConcentrator1] = await contract.getBalancesOf([open1, concentrator1]);
            assert.equal(0, balOpen1.toNumber());
            assert.equal(OPEN_INITIAL_FUNDS, balConcentrator1);
        });


        /*
         * Check behaviour of concurrent outgoing streems when funded and underfunded:
         * Start streem1 with flowrate 1 from open1 to concentrator1
         * Start streem2 with flowrate 1 from open1 to concentrator1
         * wait 100
         * check balances
         * wait 900
         * check balances (expected: open1 empty, 500 in concentrator[1|2]
         * close streem2
         * wait 100
         * check balances (expected: no change)
         * refund open1 with 700 units
         * check balances (expected: streem1 fully funded)
         */
        it('2 streems: from open1 to concentrator1 and concentrator2', async () => {
            const [streem1Open, streem2Open] = await Promise.all([
                contract.openStreamWrapper(open1, concentrator1, 1),
                contract.openStreamWrapper(open1, concentrator2, 1),
            ]); // maximize probability of same timestamp
            // this assertion avoids spurious failures caused by different streem start times (not expected, but possible)

            let lastBlockTs = await utils.fastForward(100);
            let [balOpen1, balConcentrator1, balConcentrator2] = await contract.getBalancesOf([open1, concentrator1, concentrator2]);
            // console.log(`a: balances after ${runtime_a}s: open1: ${balOpen1_a}, c1: ${balConcentrator1_a}, c2: ${balConcentrator2_a}`);
            //let lastBlockTs = await utils.getLastBlockTimestamp();
            let s1ShouldBalance = 100 * 1;
            const s2ShouldBalance = 100 * 1;

            assert.equal(OPEN_INITIAL_FUNDS - (s1ShouldBalance + s2ShouldBalance), balOpen1);
            assert.equal(s1ShouldBalance, balConcentrator1);
            assert.equal(s2ShouldBalance, balConcentrator2);

            await utils.fastForward(900);
            [balOpen1, balConcentrator1, balConcentrator2] = await contract.getBalancesOf([open1, concentrator1, concentrator2]);
            // console.log(`b: balances after ${runtime_b}s: open1: ${balOpen1_b}, c1: ${balConcentrator1_b}, c2: ${balConcentrator2_b}`);
            assert.equal(0, balOpen1);
            assert.equal(500, balConcentrator1);
            assert.equal(500, balConcentrator2);

            // now close one streem, forward 100 more, refund open1 and check all balances
            const streem2Close = await contract.closeStreamWrapper(open1, streem2Open.id);
            await utils.fastForward(100);
            [balOpen1, balConcentrator1, balConcentrator2] = await contract.getBalancesOf([open1, concentrator1, concentrator2]);
            // console.log(`b: balances after ${runtime_b}s: open1: ${balOpen1_b}, c1: ${balConcentrator1_b}, c2: ${balConcentrator2_b}`);
            assert.equal(0, balOpen1);
            assert.equal(500, balConcentrator1);
            assert.equal(500, balConcentrator2);

            // ~500 are immediately consumed by the remaining open streem
            contract.transfer(open1, 700, {from: sheikh});

            [balOpen1, balConcentrator1, balConcentrator2] = await contract.getBalancesOf([open1, concentrator1, concentrator2]);
            // console.log(`c: balances after ${runtime_c}s: open1: ${balOpen1_c}, c1: ${balConcentrator1_c}, c2: ${balConcentrator2_c}`);
            s1ShouldBalance = (await utils.getLastBlockTimestamp() - streem1Open.blockTimestamp) * 1;
            assert.equal(OPEN_INITIAL_FUNDS + 700 - 500 - s1ShouldBalance, balOpen1);
            assert.equal(500, balConcentrator2); // was closed before refund
            assert.equal(s1ShouldBalance, balConcentrator1);
            // finally, make sure nothing was created / lost overall
            assert.equal(OPEN_INITIAL_FUNDS + 700, balOpen1.add(balConcentrator1).add(balConcentrator2));
        });

        /*
         * Start streem1 with flowrate 2 from deconcentrator1 to open1
         * Wait 30
         * Start streem2 with flowrate 3 from open1 to concentrator1
         * wait 100
         * check balances
         * close streem2
         * check balances
         * wait 50
         * check balances
         * close streem1
         * check balances
         */
        it('two-way account, deconcentrator -> open -> concentrator1 - fully funded', async () => {
            const streem1Open = await contract.openStreamWrapper(deconcentrator1, open1, 3);
            await utils.fastForward(30); // let ~90 units flow in streem1
            const streem2Open = await contract.openStreamWrapper(open1, concentrator1, 2);
            await utils.fastForward(100); // let flow another ~300 units in streem1 and ~200 units in streem2

            let [balOpen1, balDeconcentrator1, balConcentrator1] = await contract.getBalancesOf([open1, deconcentrator1, concentrator1]);
            // console.log(`streems open - balances: open1: ${balOpen1}, deconcentrator1: ${balDeconcentrator1}, concentrator1: ${balConcentrator1}`);
            let lastBlockTs = await utils.getLastBlockTimestamp();
            let s1ShouldBalance = (lastBlockTs - streem1Open.blockTimestamp) * 3;
            let s2ShouldBalance = (lastBlockTs - streem2Open.blockTimestamp) * 2;
            assert.equal(DECONCENTRATOR_INITIAL_FUNDS - s1ShouldBalance, balDeconcentrator1);
            assert.equal(OPEN_INITIAL_FUNDS + s1ShouldBalance - s2ShouldBalance, balOpen1);
            assert.equal(0 + s2ShouldBalance, balConcentrator1);

            const streem2Close = await contract.closeStreamWrapper(open1, streem2Open.id);
            [balOpen1, balDeconcentrator1, balConcentrator1] = await contract.getBalancesOf([open1, deconcentrator1, concentrator1]);
            // console.log(`streem2 closed - balances: open1: ${balOpen1}, deconcentrator1: ${balDeconcentrator1}, concentrator1: ${balConcentrator1}`);
            s1ShouldBalance = (await utils.getLastBlockTimestamp() - streem1Open.blockTimestamp) * 3;
            s2ShouldBalance = (streem2Close.blockTimestamp - streem2Open.blockTimestamp) * 2;
            assert.equal(DECONCENTRATOR_INITIAL_FUNDS - s1ShouldBalance, balDeconcentrator1);
            assert.equal(OPEN_INITIAL_FUNDS + s1ShouldBalance - s2ShouldBalance, balOpen1);
            assert.equal(0 + s2ShouldBalance, balConcentrator1);

            await utils.fastForward(50); // let ~150 more units flow in streem1
            [balOpen1, balDeconcentrator1, balConcentrator1] = await contract.getBalancesOf([open1, deconcentrator1, concentrator1]);
            s1ShouldBalance = (await utils.getLastBlockTimestamp() - streem1Open.blockTimestamp) * 3;
            s2ShouldBalance = (streem2Close.blockTimestamp - streem2Open.blockTimestamp) * 2;
            assert.equal(DECONCENTRATOR_INITIAL_FUNDS - s1ShouldBalance, balDeconcentrator1);
            assert.equal(OPEN_INITIAL_FUNDS + s1ShouldBalance - s2ShouldBalance, balOpen1);
            assert.equal(0 + s2ShouldBalance, balConcentrator1);

            const streem1Close = await contract.closeStreamWrapper(deconcentrator1, streem1Open.id);
            [balOpen1, balDeconcentrator1, balConcentrator1] = await contract.getBalancesOf([open1, deconcentrator1, concentrator1]);
            // console.log(`both streems closed - balances: open1: ${balOpen1}, deconcentrator1: ${balDeconcentrator1}, concentrator1: ${balConcentrator1}`);
            s1ShouldBalance = (streem1Close.blockTimestamp - streem1Open.blockTimestamp) * 3;
            s2ShouldBalance = (streem2Close.blockTimestamp - streem2Open.blockTimestamp) * 2;
            assert.equal(DECONCENTRATOR_INITIAL_FUNDS - s1ShouldBalance, balDeconcentrator1);
            assert.equal(OPEN_INITIAL_FUNDS + s1ShouldBalance - s2ShouldBalance, balOpen1);
            assert.equal(0 + s2ShouldBalance, balConcentrator1);
        });

        /*
         * Start streem2 with flowrate 9 from open1 to concentrator1
         * wait 200
         * check balances (expected: open1: 0)
         * Start streem1 with flowrate 5 from deconcentrator1 to open1
         * wait 1000
         * check balances (expected: open1: 0, concentrator1: 6000)
         * close streem2
         * wait 100
         * check balances (expected: open1: 500)
         */
        it('two-way account, deconcentrator -> open -> concentrator1 - varying funding', async () => {
            const streem2Open = await contract.openStreamWrapper(open1, concentrator1, 9);
            await utils.fastForward(200); // let all 1000 available units flow
            let [balOpen1, balDeconcentrator1, balConcentrator1] = await contract.getBalancesOf([open1, deconcentrator1, concentrator1]);
            // console.log(`open1 empty - balances: open1: ${balOpen1}, deconcentrator1: ${balDeconcentrator1}, concentrator1: ${balConcentrator1}`);
            let s2ShouldBalance = 200 * 9;
            let open1ExpBal = adjBal(OPEN_INITIAL_FUNDS - s2ShouldBalance, 9);
            assert.equal(open1ExpBal, balOpen1.toNumber(), 'Sender balance is zero or equal to the remainder of division by flowrate');
            assert.equal(OPEN_INITIAL_FUNDS - open1ExpBal, balConcentrator1.toNumber(), 'Receiver balance equals streem balance');

            const streem1Open = await contract.openStreamWrapper(deconcentrator1, open1, 5);
            await utils.fastForward(1000);
            [balOpen1, balDeconcentrator1, balConcentrator1] = await contract.getBalancesOf([open1, deconcentrator1, concentrator1]);
            //console.log(`both open - balances: open1: ${balOpen1}, deconcentrator1: ${balDeconcentrator1}, concentrator1: ${balConcentrator1} - type ${typeof balOpen1}`);
            let lastBlockTs = await utils.getLastBlockTimestamp();
            const s1ShouldBalance = (lastBlockTs - streem1Open.blockTimestamp) * 5;
            s2ShouldBalance = (lastBlockTs - streem2Open.blockTimestamp) * 9;
            open1ExpBal = adjBal(OPEN_INITIAL_FUNDS + s1ShouldBalance - s2ShouldBalance, 9);
            assert.equal(open1ExpBal, balOpen1.toNumber());
            assert.equal(OPEN_INITIAL_FUNDS + s1ShouldBalance - open1ExpBal, balConcentrator1.toNumber());
            assert.equal((balOpen1.add(balDeconcentrator1).add(balConcentrator1)).toNumber(), DECONCENTRATOR_INITIAL_FUNDS + 1000);

            const streem2Close = await contract.closeStreamWrapper(open1, streem2Open.id);
            await utils.fastForward(100);
            [balOpen1, balDeconcentrator1, balConcentrator1] = await contract.getBalancesOf([open1, deconcentrator1, concentrator1]);
            assert(balOpen1.toNumber() >= 5 * 100);
            assert.equal((balOpen1.add(balDeconcentrator1).add(balConcentrator1)).toNumber(), DECONCENTRATOR_INITIAL_FUNDS + 1000);
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
            // 100 streems from deconcentrator to open + 100 streems from deconcentrator to concentrator, 100 streems from open to concentrator
            assert.isOk(revertToSnapshot(snapshotAfterInit));

            let streemPromises = new Array();
            [...Array(5)].forEach((_, i) => streemPromises.push(openStreemAndGetEvent(deconcentrator1, open1, 1)));
            let lastBlockTs = getLastBlockTimestamp();
            const runtime_a = fastForward(10) - lastBlockTs;
            [...Array(5)].forEach((_, i) => streemPromises.push(openStreemAndGetEvent(deconcentrator1, open1, 2)));
            lastBlockTs = getLastBlockTimestamp();
            const runtime_b = fastForward(10) - lastBlockTs;

            [...Array(5)].forEach((_, i) => streemPromises.push(openStreemAndGetEvent(deconcentrator1, concentrator1, 1)));

            [...Array(5)].forEach((_, i) => streemPromises.push(openStreemAndGetEvent(open1, concentrator1, 1)));
            lastBlockTs = getLastBlockTimestamp();
            const runtime_c = fastForward(50) - lastBlockTs;
            await Promise.all(streemPromises);

            const [balOpen1_a, balDeconcentrator1_a, balConcentrator1_a] = await getBalancesOf([open1, deconcentrator1, concentrator1]);
            console.log(`a balances: open1: ${balOpen1_a}, deconcentrator1: ${balDeconcentrator1_a}, concentrator1: ${balConcentrator1_a}`)

        });
        */
    });
});
