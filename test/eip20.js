// this is a copy of https://github.com/ConsenSys/Tokens/blob/master/test/eip20/eip20.js
// with some adaptations (e.g. compatibility with more recent version of web3)

const { assertRevert } = require('./helpers/assertRevert');

const EIP20Abstraction = artifacts.require('SimpleERC20xxToken');

const BN = web3.utils.BN;
const maxTokAmount = ((new BN(2)).pow(new BN(255))).sub(new BN(1)); // 2^255 - 1

let HST;

contract('EIP20', (accounts) => {
    beforeEach(async () => {
        HST = await EIP20Abstraction.new(10000, 'Some Bucks', 'SBX', 1, { from: accounts[0] });
    });

    it('creation: should create an initial balance of 10000 for the creator', async () => {
        const balance = await HST.balanceOf.call(accounts[0]);
        assert.strictEqual(balance.toNumber(), 10000);
    });

    it('creation: test correct setting of vanity information', async () => {
        const name = await HST.name.call();
        assert.strictEqual(name, 'Some Bucks');

        const decimals = await HST.decimals.call();
        assert.strictEqual(decimals.toNumber(), 1);

        const symbol = await HST.symbol.call();
        assert.strictEqual(symbol, 'SBX');
    });

    it('creation: should succeed in creating over 2^255 - 1 tokens', async () => {
        const HST2 = await EIP20Abstraction.new(maxTokAmount, 'Some Bucks', 'SBX', 1, { from: accounts[0] });
        const totalSupply = await HST2.totalSupply();
        const match = totalSupply.eq(maxTokAmount);
        assert(match, 'result is not correct');
    });

    // TRANSFERS
    // normal transfers without approvals
    it('transfers: ether transfer should be reversed.', async () => {
        const balanceBefore = await HST.balanceOf.call(accounts[0]);
        assert.strictEqual(balanceBefore.toNumber(), 10000);

        await assertRevert(new Promise((resolve, reject) => {
            web3.eth.sendTransaction({ from: accounts[0], to: HST.address, value: web3.utils.toWei('10', 'Ether') }, (err, res) => {
                if (err) { reject(err); }
                resolve(res);
            });
        }));

        const balanceAfter = await HST.balanceOf.call(accounts[0]);
        assert.strictEqual(balanceAfter.toNumber(), 10000);
    });

    it('transfers: should transfer 10000 to accounts[1] with accounts[0] having 10000', async () => {
        await HST.transfer(accounts[1], 10000, { from: accounts[0] });
        const balance = await HST.balanceOf.call(accounts[1]);
        assert.strictEqual(balance.toNumber(), 10000);
    });

    it('transfers: should fail when trying to transfer 10001 to accounts[1] with accounts[0] having 10000', async () => {
        await assertRevert(HST.transfer.call(accounts[1], 10001, { from: accounts[0] }));
    });

    it('transfers: should handle zero-transfers normally', async () => {
        assert(await HST.transfer.call(accounts[1], 0, { from: accounts[0] }), 'zero-transfer has failed');
    });

    // NOTE: testing uint256 wrapping is impossible since you can't supply > 2^256 -1
    // todo: transfer max amounts

    // APPROVALS
    it('approvals: msg.sender should approve 100 to accounts[1]', async () => {
        await HST.approve(accounts[1], 100, { from: accounts[0] });
        const allowance = await HST.allowance.call(accounts[0], accounts[1]);
        assert.strictEqual(allowance.toNumber(), 100);
    });

    // bit overkill. But is for testing a bug
    it('approvals: msg.sender approves accounts[1] of 100 & withdraws 20 once.', async () => {
        const balance0 = await HST.balanceOf.call(accounts[0]);
        assert.strictEqual(balance0.toNumber(), 10000);

        await HST.approve(accounts[1], 100, { from: accounts[0] }); // 100
        const balance2 = await HST.balanceOf.call(accounts[2]);
        assert.strictEqual(balance2.toNumber(), 0, 'balance2 not correct');

        await HST.transferFrom.call(accounts[0], accounts[2], 20, { from: accounts[1] });
        await HST.allowance.call(accounts[0], accounts[1]);
        await HST.transferFrom(accounts[0], accounts[2], 20, { from: accounts[1] }); // -20
        const allowance01 = await HST.allowance.call(accounts[0], accounts[1]);
        assert.strictEqual(allowance01.toNumber(), 80); // =80

        const balance22 = await HST.balanceOf.call(accounts[2]);
        assert.strictEqual(balance22.toNumber(), 20);

        const balance02 = await HST.balanceOf.call(accounts[0]);
        assert.strictEqual(balance02.toNumber(), 9980);
    });

    // should approve 100 of msg.sender & withdraw 50, twice. (should succeed)
    it('approvals: msg.sender approves accounts[1] of 100 & withdraws 20 twice.', async () => {
        await HST.approve(accounts[1], 100, { from: accounts[0] });
        const allowance01 = await HST.allowance.call(accounts[0], accounts[1]);
        assert.strictEqual(allowance01.toNumber(), 100);

        await HST.transferFrom(accounts[0], accounts[2], 20, { from: accounts[1] });
        const allowance012 = await HST.allowance.call(accounts[0], accounts[1]);
        assert.strictEqual(allowance012.toNumber(), 80);

        const balance2 = await HST.balanceOf.call(accounts[2]);
        assert.strictEqual(balance2.toNumber(), 20);

        const balance0 = await HST.balanceOf.call(accounts[0]);
        assert.strictEqual(balance0.toNumber(), 9980);

        // FIRST tx done.
        // onto next.
        await HST.transferFrom(accounts[0], accounts[2], 20, { from: accounts[1] });
        const allowance013 = await HST.allowance.call(accounts[0], accounts[1]);
        assert.strictEqual(allowance013.toNumber(), 60);

        const balance22 = await HST.balanceOf.call(accounts[2]);
        assert.strictEqual(balance22.toNumber(), 40);

        const balance02 = await HST.balanceOf.call(accounts[0]);
        assert.strictEqual(balance02.toNumber(), 9960);
    });

    // should approve 100 of msg.sender & withdraw 50 & 60 (should fail).
    it('approvals: msg.sender approves accounts[1] of 100 & withdraws 50 & 60 (2nd tx should fail)', async () => {
        await HST.approve(accounts[1], 100, { from: accounts[0] });
        const allowance01 = await HST.allowance.call(accounts[0], accounts[1]);
        assert.strictEqual(allowance01.toNumber(), 100);

        await HST.transferFrom(accounts[0], accounts[2], 50, { from: accounts[1] });
        const allowance012 = await HST.allowance.call(accounts[0], accounts[1]);
        assert.strictEqual(allowance012.toNumber(), 50);

        const balance2 = await HST.balanceOf.call(accounts[2]);
        assert.strictEqual(balance2.toNumber(), 50);

        const balance0 = await HST.balanceOf.call(accounts[0]);
        assert.strictEqual(balance0.toNumber(), 9950);

        // FIRST tx done.
        // onto next.
        await assertRevert(HST.transferFrom.call(accounts[0], accounts[2], 60, { from: accounts[1] }));
    });

    it('approvals: attempt withdrawal from account with no allowance (should fail)', async () => {
        await assertRevert(HST.transferFrom.call(accounts[0], accounts[2], 60, { from: accounts[1] }));
    });

    it('approvals: allow accounts[1] 100 to withdraw from accounts[0]. Withdraw 60 and then approve 0 & attempt transfer.', async () => {
        await HST.approve(accounts[1], 100, { from: accounts[0] });
        await HST.transferFrom(accounts[0], accounts[2], 60, { from: accounts[1] });
        await HST.approve(accounts[1], 0, { from: accounts[0] });
        await assertRevert(HST.transferFrom.call(accounts[0], accounts[2], 10, { from: accounts[1] }));
    });

    it('approvals: approve max (2^255 - 1)', async () => {
        await HST.approve(accounts[1], maxTokAmount, { from: accounts[0] });
        const allowance = await HST.allowance(accounts[0], accounts[1]);
        assert(allowance.eq(maxTokAmount));
    });

    // should approve max of msg.sender & withdraw 20 without changing allowance (should succeed).
    it('approvals: msg.sender approves accounts[1] of max (2^255 - 1) & withdraws 20', async () => {
        const balance0 = await HST.balanceOf.call(accounts[0]);
        assert.strictEqual(balance0.toNumber(), 10000);

        await HST.approve(accounts[1], maxTokAmount, { from: accounts[0] });
        const balance2 = await HST.balanceOf.call(accounts[2]);
        assert.strictEqual(balance2.toNumber(), 0, 'balance2 not correct');

        await HST.transferFrom(accounts[0], accounts[2], 20, { from: accounts[1] });
        const allowance01 = await HST.allowance.call(accounts[0], accounts[1]);
        assert(allowance01.eq(maxTokAmount.sub(new BN(20))));

        const balance22 = await HST.balanceOf.call(accounts[2]);
        assert.strictEqual(balance22.toNumber(), 20);

        const balance02 = await HST.balanceOf.call(accounts[0]);
        assert.strictEqual(balance02.toNumber(), 9980);
    });

    /* eslint-disable no-underscore-dangle */
    it('events: should fire Transfer event properly', async () => {
        const res = await HST.transfer(accounts[1], '2666', { from: accounts[0] });
        const transferLog = res.logs.find(element => element.event.match('Transfer'));
        assert.strictEqual(transferLog.args._from, accounts[0]);
        assert.strictEqual(transferLog.args._to, accounts[1]);
        assert.strictEqual(transferLog.args._value.toString(), '2666');
    });

    it('events: should fire Transfer event normally on a zero transfer', async () => {
        const res = await HST.transfer(accounts[1], '0', { from: accounts[0] });
        const transferLog = res.logs.find(element => element.event.match('Transfer'));
        assert.strictEqual(transferLog.args._from, accounts[0]);
        assert.strictEqual(transferLog.args._to, accounts[1]);
        assert.strictEqual(transferLog.args._value.toString(), '0');
    });

    it('events: should fire Approval event properly', async () => {
        const res = await HST.approve(accounts[1], '2666', { from: accounts[0] });
        const approvalLog = res.logs.find(element => element.event.match('Approval'));
        assert.strictEqual(approvalLog.args._owner, accounts[0]);
        assert.strictEqual(approvalLog.args._spender, accounts[1]);
        assert.strictEqual(approvalLog.args._value.toString(), '2666');
    });
});
