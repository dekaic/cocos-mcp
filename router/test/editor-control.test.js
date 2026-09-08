'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

test('shutdown waits through transient unreadable process identity without declaring it stopped', async t => {
    const identity = require('../../cli/src/runtime/identity');
    let probes = 0;
    t.mock.method(identity, 'sameProcess', () => {
        probes++;
        if (probes === 2) throw identity.fault('PROCESS_IDENTITY_UNAVAILABLE', 'terminating process');
        return probes === 1;
    });
    const signals = [];
    t.mock.method(process, 'kill', (pid, signal) => signals.push([pid, signal]));
    const result = await require('../src/editor-control').killEditor({ pid: 12345, processIdentity: { pid: 12345, startId: 'test' } }, { graceMs: 500 });
    assert.equal(result.killed, true);
    assert.equal(result.escalatedToSigkill, false);
    assert.deepEqual(signals, [[12345, 'SIGTERM']]);
    assert.equal(probes, 3);
});

const {
    EDITOR_TOOLS,
    buildEditorSpawnArgs,
    hasReadyAssetResult,
} = require('../src/editor-control.js');

test('editor restart/spawn expose noLogin option', () => {
    var names = ['editor_restart', 'editor_spawn'];

    names.forEach(function (name) {
        var tool = EDITOR_TOOLS.filter(function (t) { return t.name === name; })[0];
        assert.ok(tool, 'tool exists: ' + name);
        assert.equal(tool.inputSchema.properties.noLogin.type, 'boolean');
    });

    var waitTool = EDITOR_TOOLS.filter(function (t) { return t.name === 'editor_wait_ready'; })[0];
    assert.ok(waitTool, 'tool exists: editor_wait_ready');
    assert.equal(waitTool.inputSchema.properties.noLogin, undefined);
});

test('buildEditorSpawnArgs adds --nologin by default', () => {
    assert.deepEqual(buildEditorSpawnArgs('/project'), ['--project', '/project', '--nologin']);
});

test('buildEditorSpawnArgs can disable --nologin', () => {
    assert.deepEqual(buildEditorSpawnArgs('/project', { noLogin: false }), ['--project', '/project']);
});

test('buildEditorSpawnArgs keeps project path before --nologin', () => {
    var args = buildEditorSpawnArgs('/project path', {});

    assert.equal(args[0], '--project');
    assert.equal(args[1], '/project path');
    assert.equal(args[2], '--nologin');
});

test('hasReadyAssetResult accepts raw asset object content', () => {
    var result = hasReadyAssetResult({
        result: {
            content: [
                { name: 'assets', path: 'db://assets/config' },
            ],
        },
    });

    assert.equal(result, true);
});

test('hasReadyAssetResult accepts text JSON content', () => {
    var result = hasReadyAssetResult({
        result: {
            content: [
                { type: 'text', text: '[{"name":"assets"}]' },
            ],
        },
    });

    assert.equal(result, true);
});

test('hasReadyAssetResult accepts text JSON assets wrapper, including empty assets', () => {
    var withAsset = hasReadyAssetResult({
        result: {
            content: [
                { type: 'text', text: '{"assets":[{"name":"assets"}]}' },
            ],
        },
    });
    var withoutAssets = hasReadyAssetResult({
        result: {
            content: [
                { type: 'text', text: '{"assets":[]}' },
            ],
        },
    });

    assert.equal(withAsset, true);
    assert.equal(withoutAssets, true);
});

test('hasReadyAssetResult rejects empty or error results', () => {
    assert.equal(hasReadyAssetResult({ result: { content: [] } }), false);
    assert.equal(hasReadyAssetResult({ error: { message: 'not ready' } }), false);
    assert.equal(hasReadyAssetResult({ result: { isError: true } }), false);
});

const fs = require('node:fs');
const { executeLifecycle } = require('../../cli/src/runtime/lifecycle');
const { resolveTarget } = require('../src/editor-control');
const fixture = require('../../cli/test/fixture-project');
test('lifecycle and offline cores share a non-reentrant execution lock; same-ID retry is not busy', async () => {
    const request = { projectPath: fixture.projectRoot, operationId: 'lifecycle-one' };
    let finish;
    let calls = 0;
    const first = executeLifecycle('editor_spawn', request, { store: fixture.store }, async () => { calls++; await new Promise(resolve => { finish = resolve; }); return { ready: true }; });
    const repeated = await executeLifecycle('editor_spawn', request, { store: fixture.store }, () => { calls++; });
    assert.equal(repeated.state, 'running');
    assert.throws(() => require('../../cli/src/runtime/transactions').runOffline(fixture.projectRoot, 'write', {}, { store: fixture.store, operationId: 'conflict' }, () => ({})), { code: 'PROJECT_BUSY' });
    assert.equal(calls, 1);
    finish();
    assert.equal((await first).state, 'succeeded');
});
test('lifecycle rejects missing, stale and conflicting selectors without a spawn fallback', () => {
    const owner = require('../../cli/src/runtime/identity').processIdentity();
    const entry = { projectPath: fixture.projectRoot, instanceId: 'new', pid: owner.pid, processIdentity: owner };
    assert.throws(() => resolveTarget({ projectPath: fixture.projectRoot }, [entry]), { code: 'TARGET_REQUIRED' });
    assert.throws(() => resolveTarget({ projectPath: fixture.projectRoot, instanceId: 'old' }, [entry]), { code: 'TARGET_STALE' });
    assert.throws(() => resolveTarget({ projectPath: fixture.projectRoot, instanceId: 'new', pid: owner.pid + 1 }, [entry]), { code: 'TARGET_CONFLICT' });
    assert.equal(resolveTarget({ projectPath: fixture.projectRoot, instanceId: 'new' }, [entry]).instanceId, 'new');
});

// ── 调试现场保护（restart/kill 前的预览连接闸门）────────────────

const net = require('node:net');
const os = require('node:os');
const pathMod = require('node:path');
const {
    resolvePreviewPort,
    countPreviewConnections,
    assertNoDebugSession,
} = require('../src/editor-control.js');

test('resolvePreviewPort requires observed metadata and never guesses a default port', () => {
    const dir = fs.mkdtempSync(pathMod.join(os.tmpdir(), 'cc-mcp-preview-'));
    fs.mkdirSync(pathMod.join(dir, '.dev'));
    fs.writeFileSync(pathMod.join(dir, '.dev', 'dev-reload-info.json'), JSON.stringify({ previewPort: 7458 }));
    assert.equal(resolvePreviewPort(dir), 7458);
    assert.throws(() => resolvePreviewPort('/no/such/project'), { code: 'PREVIEW_STATE_UNAVAILABLE' });
    fs.rmSync(dir, { recursive: true, force: true });
});

test('countPreviewConnections sees an established connection on own process', async () => {
    // 本进程自起 server 自连，lsof -p <自己> 必然看到 ESTABLISHED
    const srv = net.createServer(() => {});
    await new Promise((r) => srv.listen(0, '127.0.0.1', r));
    const port = srv.address().port;
    const client = net.connect(port, '127.0.0.1');
    await new Promise((r) => client.on('connect', r));

    assert.ok(countPreviewConnections(process.pid, port) > 0, 'established connection counted');

    client.destroy();
    await new Promise((r) => srv.close(r));
    // 关掉后不再计数（lsof 偶有延迟，重试两轮）
    for (let i = 0; i < 10 && countPreviewConnections(process.pid, port) > 0; i++) {
        await new Promise((r) => setTimeout(r, 100));
    }
    assert.equal(countPreviewConnections(process.pid, port), 0);
});

test('assertNoDebugSession throws on active connections unless forced', async () => {
    const dir = fs.mkdtempSync(pathMod.join(os.tmpdir(), 'cc-mcp-gate-'));
    const srv = net.createServer(() => {});
    await new Promise((r) => srv.listen(0, '127.0.0.1', r));
    const port = srv.address().port;
    fs.mkdirSync(pathMod.join(dir, '.dev'));
    fs.writeFileSync(pathMod.join(dir, '.dev', 'dev-reload-info.json'), JSON.stringify({ previewPort: port, editorPid: process.pid }));
    const client = net.connect(port, '127.0.0.1');
    await new Promise((r) => client.on('connect', r));

    const target = { pid: process.pid, projectPath: dir };
    assert.throws(() => assertNoDebugSession('editor_restart', target, false), /正开着游戏预览/);
    assert.doesNotThrow(() => assertNoDebugSession('editor_restart', target, true), 'force bypasses gate');

    client.destroy();
    await new Promise((r) => srv.close(r));
    fs.rmSync(dir, { recursive: true, force: true });
});

test('missing preview state does not prove there are no debug connections', () => {
    assert.throws(() => assertNoDebugSession('editor_kill', { pid: process.pid, projectPath: '/no/such/project' }, false), { code: 'PREVIEW_STATE_UNAVAILABLE' });
});

test('waitReady performs authenticated initialization and verifies actual service identity', async t => {
    const { createRegistration, readRegistry } = require('../../cli/src/runtime/registry');
    const { wrapTools } = require('../../server/execution');
    const { createServer } = require('../../mcp-sdk');
    const directory = pathMod.join(fixture.projectRoot, 'test-registry');
    const registration = createRegistration(fixture.projectRoot, directory);
    const runtime = { sourceRealPath: '/source/cocos-mcp', runtimeBuildId: 'runtime-hash', toolSchemaHash: 'schema-hash', loadedAt: 'load-time' };
    const server = createServer({ port: 0, bearerToken: registration.token, tools: wrapTools([
        { name: 'local_get_status', handler: () => ({ projectPath: registration.projectPath, instanceId: registration.instanceId, processIdentity: registration.owner, extensionRuntime: runtime }) },
        { name: 'asset_query_assets', inputSchema: { type: 'object', properties: { pattern: { type: 'string' } } }, handler: () => ({ assets: [] }) },
    ], registration, fixture.store) });
    await server.start('http');
    registration.publish({ host: '127.0.0.1', port: server.port, ...runtime });
    t.after(() => server.stop());
    const result = await require('../src/editor-control').waitReady(fixture.projectRoot, { timeoutMs: 2000, readRegistry: () => readRegistry(directory) });
    assert.equal(result.ready, true);
    assert.equal(result.assetDbReady, true);
    assert.equal(result.entry.instanceId, registration.instanceId);
    assert.equal(result.entry.runtimeBuildId, 'runtime-hash');
    assert.equal(result.entry.transport, undefined);
});
