'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { toolListSignature } = require('../src/tool-list-signature.js');

function editorsWith(tool) {
    return [{ shortName: 'demo', tools: [tool] }];
}

test('toolListSignature ignores editor tool and schema property order', () => {
    const a = [
        { shortName: 'b', tools: [{ name: 'second', description: 'B', inputSchema: { type: 'object', properties: {} } }] },
        { shortName: 'a', tools: [{ name: 'first', description: 'A', inputSchema: { properties: { value: { type: 'string', description: 'x' } }, type: 'object' } }] },
    ];
    const b = [
        { shortName: 'a', tools: [{ name: 'first', description: 'A', inputSchema: { type: 'object', properties: { value: { description: 'x', type: 'string' } } } }] },
        { shortName: 'b', tools: [{ name: 'second', description: 'B', inputSchema: { properties: {}, type: 'object' } }] },
    ];

    assert.equal(toolListSignature(a), toolListSignature(b));
});

test('toolListSignature changes when a tool name changes without changing count', () => {
    const before = editorsWith({ name: 'asset_query', description: 'query', inputSchema: { type: 'object' } });
    const after = editorsWith({ name: 'asset_list', description: 'query', inputSchema: { type: 'object' } });

    assert.notEqual(toolListSignature(before), toolListSignature(after));
});

test('toolListSignature changes when description changes without changing count', () => {
    const before = editorsWith({ name: 'asset_query', description: 'old', inputSchema: { type: 'object' } });
    const after = editorsWith({ name: 'asset_query', description: 'new', inputSchema: { type: 'object' } });

    assert.notEqual(toolListSignature(before), toolListSignature(after));
});

test('toolListSignature changes when inputSchema changes without changing count', () => {
    const before = editorsWith({ name: 'asset_query', description: 'query', inputSchema: { type: 'object', properties: { limit: { type: 'number' } } } });
    const after = editorsWith({ name: 'asset_query', description: 'query', inputSchema: { type: 'object', properties: { limit: { type: 'string' } } } });

    assert.notEqual(toolListSignature(before), toolListSignature(after));
});
