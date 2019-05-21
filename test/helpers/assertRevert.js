module.exports = {
  assertRevert: async (promise) => {
    try {
      await promise;
    } catch (error) {
      // TODO: is there a sane way to recognize the failure reason?
//      const revertFound = error.message.search('Error') >= 0;
//      assert(revertFound, `Expected "revert", got ${error} instead`);
      return;
    }
    assert.fail('Expected revert not received');
  },
};
