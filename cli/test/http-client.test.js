'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { createClient } = require('../src/runtime/http-client');

test('initialization failures reset single-flight state; expired mutations are never replayed', async t => {
    let initializations = 0;
    let mutations = 0;
    let failInitialize = true;
    let expire = false;
    const server = http.createServer(async (request, response) => {
        const chunks = [];
        for await (const chunk of request) chunks.push(chunk);
        const message = JSON.parse(Buffer.concat(chunks).toString());
        if (message.method === 'initialize') {
            initializations++;
            assert.equal(request.headers['mcp-session-id'], undefined);
            if (failInitialize) { response.writeHead(503); response.end(); return; }
            response.writeHead(200, { 'Content-Type': 'application/json', 'Mcp-Session-Id': 'session-' + initializations });
            response.end(JSON.stringify({ jsonrpc: '2.0', id: message.id, result: { protocolVersion: '2025-06-18' } }));
        } else if (message.method === 'notifications/initialized') { response.writeHead(202); response.end(); }
        else {
            if (message.method === 'tools/call') mutations++;
            if (expire) { response.writeHead(404); response.end(); return; }
            response.end(JSON.stringify({ jsonrpc: '2.0', id: message.id, result: {} }));
        }
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    t.after(() => new Promise(resolve => server.close(resolve)));
    const client = createClient({ projectPath: '/fixture', instanceId: 'generation',
        transport: { url: 'http://127.0.0.1:' + server.address().port + '/mcp', bearerToken: 'fixture' } });
    const failures = await Promise.allSettled([client.initialize(), client.initialize()]);
    assert.ok(failures.every(result => result.status === 'rejected'));
    assert.equal(initializations, 1);
    failInitialize = false;
    await Promise.all([client.initialize(), client.initialize()]);
    assert.equal(initializations, 2);
    expire = true;
    await assert.rejects(client.request('tools/call', { name: 'mutate' }), { code: 'SESSION_EXPIRED' });
    assert.equal(mutations, 1);
    assert.equal(initializations, 2, 'request failure does not reconnect and replay');
    expire = false;
    await client.request('tools/list');
    assert.equal(initializations, 3);
    assert.equal(mutations, 1, 'subsequent reads can reconnect without repeating the mutation');
});
