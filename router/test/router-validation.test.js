'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { createServer } = require('../../mcp-sdk');
const { createRouter, assignAliases } = require('../bin');
const { wrapTools } = require('../../server/execution');
const registry = require('../../cli/src/runtime/registry');
const { createStore } = require('../../cli/src/runtime/operations');
const { createClient } = require('../../cli/src/runtime/http-client');

test('protocol boundary: Router rejects nested batch items before forwarding, but keeps valid siblings', async () => {
    let calls = 0;
    const handle = require('../bin').createHandler({ runtime: {}, discover: async () => {}, initialized() {}, call: async () => { calls++; return { content: [] }; } });
    await handle({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'test', version: '0' } } });
    await handle({ jsonrpc: '2.0', method: 'notifications/initialized' });
    const call = { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'probe' } };
    for (const nested of [[call], [[call]], []]) {
        const before = calls;
        const response = await handle([nested, { ...call, id: 3 }]);
        assert.equal(calls, before + 1);
        assert.equal(response.length, 2);
        assert.ok(response.every(item => !Array.isArray(item)));
        assert.equal(response[0].id, null);
        assert.equal(response[0].error.code, -32600);
        assert.equal(response[1].id, 3);
    }
});

test('protocol boundary: Router keeps notification silence and rejects malformed capabilities', async () => {
    const handle = require('../bin').createHandler({ runtime: {}, discover: async () => {}, initialized() {} });
    const init = { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26', capabilities: [], clientInfo: { name: 'test', version: '0' } } };
    assert.equal((await handle(init)).error.code, -32602);
    init.params.capabilities = {};
    assert.ok((await handle(init)).result);
    await handle({ jsonrpc: '2.0', method: 'notifications/initialized' });
    assert.equal(await handle([{ jsonrpc: '2.0', method: 'notifications/unknown' }]), null);
    assert.equal((await handle({ jsonrpc: '2.0', id: 2, method: 'unknown' })).error.code, -32601);
});

async function fixture(t, mutate) {
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cocos-router-contract-')));
    const projectPath = path.join(root, 'project');
    fs.mkdirSync(projectPath);
    fs.mkdirSync(path.join(projectPath, 'assets'));
    fs.writeFileSync(path.join(projectPath, 'package.json'), '{}');
    const directory = path.join(root, 'editors');
    const registration = registry.createRegistration(projectPath, directory);
    const store = createStore({ stateRoot: path.join(root, 'state') });
    const definitions = wrapTools([
        { name: 'local_get_status', inputSchema: { type: 'object', properties: {} }, handler: () => ({
            projectPath, instanceId: registration.instanceId, processIdentity: registration.owner }) },
        { name: 'scene_open_scene', description: 'open scene',
            inputSchema: { type: 'object', properties: { uuid: { type: 'string' } }, required: ['uuid'] }, handler: mutate },
    ], registration, store);
    const server = createServer({ port: 0, tools: definitions, bearerToken: registration.token, allowedOrigins: [],
        resources: [{ uri: 'fixture://status', name: 'status', title: 'Current status', annotations: { priority: 0.5 }, read: () => 'ready' }] });
    const started = await server.start('http');
    registration.publish({ ...started, projectShortName: 'fixture' });
    const entries = () => registry.readRegistry(directory);
    const router = createRouter({ store, readRegistry: entries });
    t.after(async () => { await server.stop(); registration.remove(); fs.rmSync(root, { recursive: true, force: true }); });
    await router.discover();
    return { root, projectPath, store, router, server, registration, entries,
        args: { _target: { projectPath, instanceId: registration.instanceId }, operationId: crypto.randomUUID(), uuid: 'scene' } };
}

test('router rejects missing arguments before authenticated HTTP forwarding', async t => {
    let calls = 0;
    const f = await fixture(t, () => { calls++; return 'opened'; });
    const args = { ...f.args, url: 'db://assets/example.scene' };
    delete args.uuid;
    const response = await f.router.call('fixture__scene_open_scene', args);
    assert.equal(response.isError, true);
    assert.match(response.content[0].text, /arguments.uuid is required/);
    assert.equal(calls, 0);
    const success = await f.router.call('fixture__scene_open_scene', f.args);
    assert.equal(success.isError, undefined);
    assert.equal(success._meta.cocosMcp.state, 'succeeded');
    assert.equal(calls, 1);
});

test('discovery preserves legacy/corrupt records and never uses them as authority', async t => {
    const f = await fixture(t, () => 'opened');
    const stale = path.join(f.root, 'editors', '99999999.json');
    const lock = path.join(f.root, 'editors', 'spawn-lock-fixture.json');
    fs.writeFileSync(stale, JSON.stringify({ pid: 99999999 }), { mode: 0o600 });
    fs.writeFileSync(lock, JSON.stringify({ pid: process.pid }), { mode: 0o600 });
    await f.router.discover();
    assert.equal(fs.existsSync(stale), true);
    assert.equal(fs.existsSync(lock), true);
    assert.equal(f.entries().length, 1);
    const listed = await f.router.call('router_list_editors', {});
    assert.equal(listed.content[0].text.includes(f.registration.token), false);
    assert.equal(JSON.parse(listed.content[0].text)[0].instanceId, f.registration.instanceId);
});

test('aliases are globally unique including collisions with generated aliases and duplicate projects', () => {
    const entries = [
        { instanceId: 'a', projectShortName: 'foo', projectPath: '/a/client' },
        { instanceId: 'b', projectShortName: 'foo', projectPath: '/b/server' },
        { instanceId: 'c', projectShortName: 'foo-client', projectPath: '/c' },
        { instanceId: 'd', projectShortName: 'foo', projectPath: '/a/client' },
    ];
    const result = assignAliases(entries);
    assert.equal(new Set(result.map(entry => entry.shortName)).size, 4);
    assert.deepEqual(assignAliases(entries.slice().reverse()), result);
});

test('same-count metadata changes update the full advertised tool signature', async t => {
    const f = await fixture(t, () => 'opened');
    const before = f.router.signature();
    f.server.tools.find(tool => tool.name === 'scene_open_scene').annotations.title = 'updated contract';
    await f.router.discover();
    assert.notEqual(f.router.signature(), before);
});

test('overlapping discovery is single-flight and publishes one complete snapshot', async t => {
    const f = await fixture(t, () => 'opened');
    let scans = 0;
    let release;
    const router = createRouter({ store: f.store, readRegistry: async () => {
        scans++; await new Promise(resolve => { release = resolve; }); return f.entries();
    } });
    const first = router.discover();
    const second = router.discover();
    assert.equal(first, second);
    release();
    await first;
    assert.equal(scans, 1);
    assert.equal(router.tools().filter(tool => tool.name.startsWith('fixture__')).length, 3);
});

test('real HTTP timeout keeps Editor execution protected; a second Router retry never replays', async t => {
    let calls = 0;
    let complete;
    const f = await fixture(t, async () => { calls++; await new Promise(resolve => { complete = resolve; }); return { saved: true }; });
    const first = createRouter({ store: f.store, readRegistry: f.entries, createClient: entry => createClient(entry, { timeoutMs: 50 }) });
    const second = createRouter({ store: createStore({ stateRoot: f.store.stateRoot }), readRegistry: f.entries });
    await first.discover();
    const response = await first.call('fixture__scene_open_scene', f.args);
    assert.equal(response.structuredContent.cocosMcpControl.state, 'running');
    assert.equal(calls, 1);
    const duplicate = await second.call('fixture__scene_open_scene', f.args);
    assert.equal(duplicate.structuredContent.cocosMcpControl.state, 'running');
    assert.equal(calls, 1);
    complete();
    for (let i = 0; i < 30 && f.store.status(f.projectPath, f.args.operationId).state !== 'succeeded'; i++) {
        await new Promise(resolve => setTimeout(resolve, 10));
    }
    f.store.observe({ projectPath: f.projectPath, operationId: f.args.operationId }, 'transport_unknown');
    assert.equal(f.store.status(f.projectPath, f.args.operationId).state, 'succeeded');
    assert.equal(calls, 1);
});

test('concurrency: one Router handles overlapping same-ID and conflicting requests without replay', { timeout: 15000 }, async t => {
    let begin, finish, calls = 0;
    const started = new Promise(resolve => { begin = resolve; });
    const held = new Promise(resolve => { finish = resolve; });
    const f = await fixture(t, async () => { calls++; begin(); await held; return { saved: true }; });
    const original = f.router.call('fixture__scene_open_scene', f.args);
    try {
        await started;
        const [duplicate, conflict] = await Promise.all([
            f.router.call('fixture__scene_open_scene', f.args),
            f.router.call('fixture__scene_open_scene', { ...f.args, operationId: crypto.randomUUID() }),
        ]);
        assert.equal(duplicate.structuredContent.cocosMcpControl.state, 'running');
        assert.equal(conflict.structuredContent.cocosMcpControl.code, 'PROJECT_BUSY');
        assert.equal(calls, 1);
        finish();
        assert.equal((await original)._meta.cocosMcp.state, 'succeeded');
        assert.equal((await f.router.call('fixture__scene_open_scene', f.args))._meta.cocosMcp.state, 'succeeded');
        assert.equal(calls, 1);
    } finally { finish(); await original; }
});

test('concurrency: two independent Router processes share one project busy, retry, and unknown state', { timeout: 15000 }, async t => {
    const { fork } = require('node:child_process');
    const { once } = require('node:events');
    let begin, finish, calls = 0;
    const started = new Promise(resolve => { begin = resolve; });
    const held = new Promise(resolve => { finish = resolve; });
    const f = await fixture(t, async () => { calls++; begin(); await held; throw new Error('Isolated execution consequence is unknown'); });
    const children = Array.from({ length: 2 }, () => fork(path.join(__dirname, 'fixtures/router-child.js'), [], { stdio: ['ignore', 'ignore', 'pipe', 'ipc'] }));
    async function call(child, args) {
        const reply = once(child, 'message', { signal: t.signal });
        child.send({ kind: 'call', name: 'fixture__scene_open_scene', arguments: args });
        const [message] = await reply;
        assert.equal(message.kind, 'result');
        return message.result;
    }
    try {
        assert.notEqual(children[0].pid, children[1].pid);
        assert.ok(children.every(child => child.pid !== process.pid));
        await Promise.all(children.map(async child => {
            const ready = once(child, 'message', { signal: t.signal });
            child.send({ kind: 'initialize', registryDirectory: path.join(f.root, 'editors'), stateRoot: f.store.stateRoot });
            assert.equal((await ready)[0].kind, 'ready');
        }));
        const original = call(children[0], f.args);
        // Attach rejection handling while the original stays in flight during the sibling assertions.
        original.catch(() => {});
        await started;
        assert.equal(f.store.status(f.projectPath, f.args.operationId).execution.owner.pid, process.pid);
        const duplicate = await call(children[1], f.args);
        assert.equal(duplicate.structuredContent.cocosMcpControl.state, 'running');
        assert.equal((await call(children[1], { ...f.args, operationId: crypto.randomUUID() })).structuredContent.cocosMcpControl.code, 'PROJECT_BUSY');
        assert.equal(calls, 1);
        finish();
        assert.equal((await original).structuredContent.cocosMcpControl.state, 'unknown');
        assert.equal((await call(children[1], f.args)).structuredContent.cocosMcpControl.state, 'unknown');
        assert.equal((await call(children[1], { ...f.args, operationId: crypto.randomUUID() })).structuredContent.cocosMcpControl.code, 'PROJECT_FROZEN');
        assert.throws(() => f.store.reconcile(f.projectPath, f.args.operationId, 'accept_current_state', 'Caller says done'), { code: 'EXECUTION_NOT_STOPPED' });
        assert.equal(calls, 1);
        assert.equal(f.store.status(f.projectPath, f.args.operationId).unresolved, true);
    } finally {
        finish();
        await Promise.all(children.map(async child => {
            if (child.exitCode !== null || child.signalCode !== null) return;
            const exited = once(child, 'exit'); child.kill('SIGTERM'); await exited;
        }));
    }
});

test('Router process exit cannot release an executing Editor lease or replay its operation', { timeout: 15000 }, async t => {
    const { fork } = require('node:child_process');
    const { once } = require('node:events');
    let began;
    const started = new Promise(resolve => { began = resolve; });
    let complete;
    let calls = 0;
    const f = await fixture(t, async () => {
        calls++; began();
        await new Promise(resolve => { complete = resolve; });
        return { saved: true };
    });
    const child = fork(path.join(__dirname, 'fixtures/router-child.js'), [], { stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
    t.after(() => { if (child.exitCode === null && child.signalCode === null) child.kill(); if (complete) complete(); });
    const ready = once(child, 'message');
    child.send({ kind: 'initialize', registryDirectory: path.join(f.root, 'editors'), stateRoot: f.store.stateRoot });
    assert.equal((await ready)[0].kind, 'ready');
    child.send({ kind: 'call', name: 'fixture__scene_open_scene', arguments: f.args });
    await started;
    const record = f.store.status(f.projectPath, f.args.operationId);
    assert.equal(record.execution.owner.pid, process.pid, 'Editor, not Router, owns execution');
    assert.notEqual(record.execution.owner.pid, child.pid);
    const exited = once(child, 'exit');
    child.kill('SIGTERM');
    await exited;
    const retry = await f.router.call('fixture__scene_open_scene', f.args);
    assert.equal(retry.structuredContent.cocosMcpControl.state, 'running');
    const conflict = await f.router.call('fixture__scene_open_scene', { ...f.args, operationId: crypto.randomUUID() });
    assert.equal(conflict.structuredContent.cocosMcpControl.code, 'PROJECT_BUSY');
    assert.equal(calls, 1);
    assert.throws(() => f.store.reconcile(f.projectPath, f.args.operationId, 'accept_current_state', 'Router exited'), { code: 'EXECUTION_NOT_STOPPED' });
    complete();
    for (let i = 0; i < 100 && f.store.status(f.projectPath, f.args.operationId).state !== 'succeeded'; i++) await new Promise(resolve => setTimeout(resolve, 10));
    assert.equal(f.store.status(f.projectPath, f.args.operationId).state, 'succeeded');
    assert.doesNotThrow(() => f.store.gate(f.projectPath));
});

test('resource discovery and contents retain metadata and generation identity', async t => {
    const f = await fixture(t, () => 'opened');
    const [resource] = await f.router.resources();
    assert.equal(resource.title, 'Current status');
    assert.equal(resource.annotations.priority, 0.5);
    assert.equal(resource.uri, 'cocos-router://' + f.registration.instanceId + '/' + encodeURIComponent('fixture://status'));
    const result = await f.router.readResource(resource.uri);
    assert.equal(result.contents[0].uri, resource.uri);
    assert.equal(result.contents[0].text, 'ready');
});

test('stdio initialization is single-flight and malformed call envelopes are protocol errors', async () => {
    const { createHandler } = require('../bin');
    let release;
    const discovery = new Promise(resolve => { release = resolve; });
    const handle = createHandler({ discover: () => discovery, runtime: {}, initialized() {}, call() { throw new Error('must not dispatch'); } });
    const init = { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '0' } } };
    const first = handle(init);
    const pendingDuplicate = handle({ ...init, id: 2 });
    release(); await first;
    const duplicate = await pendingDuplicate;
    assert.equal(duplicate.error.code, -32602);
    await handle({ jsonrpc: '2.0', method: 'notifications/initialized' });
    for (const params of [{}, { name: 7 }, { name: 'tool', arguments: null }, { name: 'tool', arguments: [] }]) {
        const response = await handle({ jsonrpc: '2.0', id: 3, method: 'tools/call', params });
        assert.equal(response.error.code, -32602);
    }
});
