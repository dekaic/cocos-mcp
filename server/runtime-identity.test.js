'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { hashRuntimeFiles, hashToolSchemas, hashResourceSchemas } = require('./runtime-identity.js');

test('runtime build id is stable and changes with runtime source', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cocos-mcp-runtime-id-'));
    fs.mkdirSync(path.join(root, 'server'));
    fs.writeFileSync(path.join(root, 'package.json'), '{"name":"fixture"}\n');
    fs.writeFileSync(path.join(root, 'main.js'), 'module.exports = 1;\n');
    fs.writeFileSync(path.join(root, 'server', 'tool.js'), 'module.exports = 2;\n');

    const first = hashRuntimeFiles(root);
    assert.equal(hashRuntimeFiles(root), first);

    fs.writeFileSync(path.join(root, 'server', 'tool.js'), 'module.exports = 3;\n');
    assert.notEqual(hashRuntimeFiles(root), first);

    fs.rmSync(root, { recursive: true, force: true });
});

test('tool schema hash ignores object key order and changes with schema', () => {
    const left = [{
        name: 'asset_query',
        description: 'query',
        inputSchema: { type: 'object', properties: { b: { type: 'number' }, a: { type: 'string' } } },
    }];
    const reordered = [{
        inputSchema: { properties: { a: { type: 'string' }, b: { type: 'number' } }, type: 'object' },
        description: 'query',
        name: 'asset_query',
    }];
    const changed = [{
        name: 'asset_query',
        description: 'query',
        inputSchema: { type: 'object', properties: { a: { type: 'number' }, b: { type: 'number' } } },
    }];

    assert.equal(hashToolSchemas(left), hashToolSchemas(reordered));
    assert.notEqual(hashToolSchemas(left), hashToolSchemas(changed));
});

test('resource descriptor hash matches the protocol list and includes metadata changes', () => {
    const resources = [{ uri: 'test://one', title: 'One', annotations: { priority: 0.5 }, read: () => 'data' }];
    const dispatcher = require('../mcp-sdk').createDispatcher({ resources });
    const listed = dispatcher.dispatch({ jsonrpc: '2.0', method: 'resources/list', id: 1 }).result.resources;
    const before = hashResourceSchemas(resources);
    assert.equal(hashResourceSchemas(listed), before);
    resources[0].read = () => 'different content';
    assert.equal(hashResourceSchemas(resources), before);
    resources[0].title = 'New title';
    assert.notEqual(hashResourceSchemas(resources), before);
});
