'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { makeTools, findTool } = require('./test/tool-fixture');

test('reimport refuses an unindexed asset before dispatching a mutation', async () => {
    const calls = [];
    const tool = findTool(makeTools({ msg: async (...args) => { calls.push(args); return null; } }), 'asset_reimport');
    await assert.rejects(tool.handler({ url: 'db://assets/loading.prefab' }), { code: 'ASSET_NOT_READY' });
    assert.deepEqual(calls, [['asset-db', 'query-asset-info', 'db://assets/loading.prefab']]);
});

test('reimport preserves its payload only after an imported postcondition', async () => {
    const calls = [];
    const tool = findTool(makeTools({ msg: async (channel, method) => {
        calls.push(method);
        return method === 'query-asset-info' ? { uuid: 'asset', imported: true, invalid: false } : null;
    } }), 'asset_reimport');
    assert.equal(await tool.handler({ url: 'db://assets/ready.prefab' }), null);
    assert.deepEqual(calls, ['query-asset-info', 'reimport-asset', 'query-asset-info']);
});

test('reimport cannot declare success when its resource disappears during execution', async () => {
    let reads = 0;
    const tool = findTool(makeTools({ msg: async (channel, method) => method === 'query-asset-info'
        ? (++reads === 1 ? { uuid: 'asset', imported: true, invalid: false } : null) : null }), 'asset_reimport');
    await assert.rejects(tool.handler({ url: 'db://assets/conflict.prefab' }), { code: 'ASSET_IMPORT_UNCONFIRMED' });
});
