'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { makeTools, findTool } = require('./test/tool-fixture.js');

test('asset_query_assets supports opt-in pagination and top-level field projection', async () => {
    const assets = [
        { url: 'db://assets/a.prefab', uuid: 'a', type: 'cc.Prefab', file: '/a' },
        { url: 'db://assets/b.prefab', uuid: 'b', type: 'cc.Prefab', file: '/b' },
        { url: 'db://assets/c.prefab', uuid: 'c', type: 'cc.Prefab', file: '/c' },
    ];
    const calls = [];
    const tool = findTool(makeTools({
        msg: async function () {
            calls.push(Array.from(arguments));
            return assets;
        },
    }), 'asset_query_assets');

    assert.equal(tool.inputSchema.properties.offset.minimum, 0);
    assert.equal(tool.inputSchema.properties.limit.minimum, 1);
    assert.equal(tool.inputSchema.properties.fields.type, 'array');

    const result = await tool.handler({
        pattern: 'db://assets/**/*.prefab',
        ccType: 'cc.Prefab',
        offset: 1,
        limit: 1,
        fields: ['url', 'uuid'],
    });

    assert.deepEqual(calls, [[
        'asset-db',
        'query-assets',
        { pattern: 'db://assets/**/*.prefab', ccType: 'cc.Prefab' },
    ]]);
    assert.deepEqual(result, {
        assets: [{ url: 'db://assets/b.prefab', uuid: 'b' }],
        total: 3,
        offset: 1,
        limit: 1,
        hasMore: true,
        nextOffset: 2,
    });
});

test('asset_query_assets keeps the complete assets array when pagination is omitted', async () => {
    const assets = [{ url: 'a' }, { url: 'b' }];
    const tool = findTool(makeTools({
        msg: async function () { return assets; },
    }), 'asset_query_assets');

    const result = await tool.handler({});
    assert.deepEqual(result.assets, assets);
    assert.equal(result.total, 2);
    assert.equal(result.offset, 0);
    assert.equal(result.limit, null);
    assert.equal(result.hasMore, false);
    assert.equal(result.nextOffset, null);
});
