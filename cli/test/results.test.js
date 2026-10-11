'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const results = require('../src/runtime/results');
const { createDispatcher, validateArguments } = require('../../mcp-sdk/protocol/dispatcher');

const businessArrays = [
    [{ type: 'gold', amount: 10 }],
    [{ type: 'text', text: 'ok' }, { type: 'gold', amount: 10 }],
    [{ type: 'text' }], [{ type: 'text', text: 7 }],
    [{ type: 'image', data: 'AA==' }], [{ type: 'audio', mimeType: 'audio/wav' }],
    [{ type: 'resource_link', uri: 'file:///test' }],
    [{ type: 'resource', resource: { uri: 'file:///test' } }],
    [{ type: 'text', text: 'ok' }, null], [],
];
const content = [
    { type: 'text', text: '正常内容' },
    { type: 'image', data: 'AA==', mimeType: 'image/png' },
    { type: 'audio', data: 'AA==', mimeType: 'audio/wav' },
    { type: 'resource_link', uri: 'file:///test', name: 'test' },
    { type: 'resource', resource: { uri: 'file:///test', text: 'hello' } },
    { type: 'resource', resource: { uri: 'file:///test', blob: 'AA==' } },
];

test('result normalization distinguishes whole content arrays from business arrays', () => {
    for (const value of businessArrays) {
        const normalized = results.normalize(value);
        assert.equal(normalized.content.length, 1);
        assert.equal(normalized.content[0].type, 'text');
        assert.deepEqual(JSON.parse(normalized.content[0].text), value);
    }
    assert.deepEqual(results.normalize(content).content, content);
    assert.deepEqual(JSON.parse(results.normalize({ items: businessArrays[0] }).content[0].text), { items: businessArrays[0] });
});

test('fromRecord and SDK dispatch preserve business arrays, content and operation metadata', async () => {
    for (const value of [...businessArrays, content]) {
        const record = { state: 'succeeded', operationId: 'result-array', projectPath: '/project', result: value };
        const dispatcher = createDispatcher({ tools: [{ name: 'result', handler: () => results.fromRecord(record) }] });
        const response = await dispatcher.dispatchAsync({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'result', arguments: {} } });
        assert.equal(response.error, undefined);
        assert.equal(response.result._meta.cocosMcp.operationId, record.operationId);
        assert.equal(response.result._meta.cocosMcp.state, 'succeeded');
        if (value === content) assert.deepEqual(response.result.content, content);
        else assert.deepEqual(JSON.parse(response.result.content[0].text), value);
    }
});

test('declared structured output and metadata survive both normalizers', async () => {
    const schema = { type: 'object', required: ['items'], additionalProperties: false,
        properties: { items: { type: 'array', items: { type: 'object', required: ['type', 'amount'],
            properties: { type: { type: 'string' }, amount: { type: 'number' } } } } } };
    const structuredContent = { items: businessArrays[0] };
    const outputSchema = results.outputSchema(schema);
    const dispatcher = createDispatcher({ tools: [{ name: 'result', outputSchema, handler: () => results.fromRecord({
        state: 'succeeded', operationId: 'structured-result', result: {
            structuredContent, _meta: { example: 'retained' }, isError: false,
        },
    }) }] });
    const listed = dispatcher.dispatch({ jsonrpc: '2.0', id: 1, method: 'tools/list' });
    assert.deepEqual(listed.result.tools[0].outputSchema, outputSchema);
    const response = await dispatcher.dispatchAsync({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'result', arguments: {} } });
    assert.deepEqual(response.result.structuredContent, structuredContent);
    assert.equal(validateArguments(outputSchema, response.result.structuredContent), null);
    assert.deepEqual(JSON.parse(response.result.content[0].text), structuredContent);
    assert.equal(response.result._meta.example, 'retained');
    assert.equal(response.result.isError, false);
});
