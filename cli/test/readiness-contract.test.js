'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const identity = require('../src/runtime/identity');
const processes = require('../src/runtime/processes');
const registry = require('../src/runtime/registry');
const { waitReady } = require('../src/runtime/readiness');
const { createStore } = require('../src/runtime/operations');
const { createServer } = require('../../mcp-sdk');
const { wrapTools } = require('../../server/execution');

function fixture(t) {
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cocos-readiness-test-')));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    fs.mkdirSync(path.join(root, 'assets'));
    fs.writeFileSync(path.join(root, 'package.json'), '{}');
    return { projectPath: root, store: createStore({ stateRoot: path.join(root, 'state') }) };
}
async function service(t, fixture, assetsReady = () => true) {
    const directory = path.join(fixture.projectPath, 'registry');
    const registration = registry.createRegistration(fixture.projectPath, directory);
    const server = createServer({ port: 0, bearerToken: registration.token, tools: wrapTools([
        { name: 'local_get_status', handler: () => ({ projectPath: registration.projectPath, instanceId: registration.instanceId, processIdentity: registration.owner }) },
        { name: 'asset_query_assets', inputSchema: { type: 'object', properties: { pattern: { type: 'string' } } },
            handler: () => assetsReady() ? { assets: [] } : { isError: true, content: [{ type: 'text', text: 'Importing' }] } },
    ], registration, fixture.store) });
    await server.start('http');
    registration.publish({ host: '127.0.0.1', port: server.port });
    t.after(() => server.stop());
    return { registration, entries: () => registry.readRegistry(directory) };
}
const unavailable = () => identity.fault('PROCESS_IDENTITY_UNAVAILABLE', 'Cannot verify process start identity (ETIMEDOUT)');

test('readiness retries observation only, keeping the original execution lock and same-ID result', async t => {
    const f = fixture(t);
    const s = await service(t, f);
    let reads = 0;
    let samples = 0;
    t.mock.method(processes, 'forProject', () => { samples++; throw unavailable(); });
    const request = { projectPath: f.projectPath, operationId: 'cold-start', tool: 'editor_spawn', args: {} };
    let executions = 0;
    const execute = async () => {
        executions++;
        const result = await waitReady(f.projectPath, { timeoutMs: 3000, processIdentity: s.registration.owner,
            readRegistry: () => ++reads === 1 ? [] : s.entries() });
        assert.equal(result.ready, true);
        return result;
    };
    const pending = f.store.execute(request, execute);
    assert.equal((await f.store.execute(request, execute)).state, 'running');
    assert.throws(() => f.store.executeSync({ ...request, operationId: 'conflicting-write' }, () => ({})), { code: 'PROJECT_BUSY' });
    const record = await pending;
    assert.equal(record.state, 'succeeded');
    assert.equal(record.result.entry.instanceId, s.registration.instanceId);
    assert.equal(record.result.assetDbReady, true, 'fresh authenticated service and AssetDB probes are still required');
    assert.equal(executions, 1);
    assert.equal(samples, 1);
});

test('readiness can resample an unavailable registry observation without accepting an old instance', async t => {
    const f = fixture(t);
    const s = await service(t, f);
    let reads = 0;
    let processReads = 0;
    t.mock.method(processes, 'forProject', () => { processReads++; return [s.registration.owner]; });
    const result = await waitReady(f.projectPath, { timeoutMs: 3000, instanceId: s.registration.instanceId,
        readRegistry: () => {
            reads++;
            if (reads === 1) throw unavailable();
            if (reads === 2) return s.entries().map(entry => ({ ...entry, instanceId: 'old-service' }));
            return s.entries();
        } });
    assert.equal(result.ready, true);
    assert.equal(result.entry.instanceId, s.registration.instanceId);
    assert.equal(reads, 3);
    assert.equal(processReads, 1);
});

test('persistent observation failure reaches the existing deadline and cannot release unknown protection', async t => {
    const f = fixture(t);
    t.mock.method(processes, 'forProject', () => { throw unavailable(); });
    const result = await waitReady(f.projectPath, { timeoutMs: 30, readRegistry: () => [] });
    assert.equal(result.ready, false);
    assert.equal(result.processReady, false);
    assert.equal(result.registryReady, false);
    assert.ok(result.waitedMs >= 30);
    assert.match(result.reason, /PROCESS_IDENTITY_UNAVAILABLE.*ETIMEDOUT/);
    const request = { projectPath: f.projectPath, operationId: 'unknown-start', tool: 'editor_spawn', args: {} };
    const record = await f.store.execute(request, async () => { throw identity.fault('OPERATION_UNKNOWN', result.reason); });
    assert.equal(record.state, 'unknown');
    assert.equal(record.unresolved, true);
    assert.throws(() => f.store.executeSync({ ...request, operationId: 'new-start' }, () => ({})), { code: 'PROJECT_FROZEN' });
    assert.equal((await f.store.execute(request, () => assert.fail('must not relaunch'))).state, 'unknown');
});

test('failed observation clears stale ready flags; an earlier successful HTTP probe is not current readiness', async t => {
    const f = fixture(t);
    const s = await service(t, f, () => false);
    let reads = 0;
    const result = await waitReady(f.projectPath, { timeoutMs: 650, readRegistry: () => {
        if (++reads === 1) return s.entries();
        throw unavailable();
    } });
    assert.ok(reads > 1);
    for (const key of ['ready', 'processReady', 'registryReady', 'mcpReady', 'assetDbReady', 'projectReady']) assert.equal(result[key], false, key);
    assert.match(result.reason, /PROCESS_IDENTITY_UNAVAILABLE/);
});

test('ambiguous identities and other observation errors remain immediate failures', async t => {
    const f = fixture(t);
    const entry = { projectPath: f.projectPath, instanceId: 'one' };
    await assert.rejects(waitReady(f.projectPath, { readRegistry: () => [entry, { ...entry, instanceId: 'two' }] }), { code: 'TARGET_AMBIGUOUS' });
    await assert.rejects(waitReady(f.projectPath, { readRegistry: () => { throw identity.fault('PRIVATE_STATE_REQUIRED', 'Unsafe permissions'); } }), { code: 'PRIVATE_STATE_REQUIRED' });
});
