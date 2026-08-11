'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

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

// ── 跨进程 spawn 锁 ─────────────────────────────────────────────

const fs = require('node:fs');
const childProcess = require('node:child_process');
const http = require('node:http');
const {
    spawnLockPath,
    acquireSpawnLock,
    releaseSpawnLock,
} = require('../src/editor-control.js');

// 用独占的假项目路径，lockfile 名字带 md5 不会撞真实项目
const FAKE_PROJECT = '/tmp/cc-mcp-spawnlock-test-' + process.pid;

test('acquireSpawnLock creates lockfile and releaseSpawnLock removes it', () => {
    const lockPath = acquireSpawnLock(FAKE_PROJECT);
    assert.ok(fs.existsSync(lockPath), 'lockfile exists after acquire');
    const holder = JSON.parse(fs.readFileSync(lockPath, 'utf-8'));
    assert.equal(holder.pid, process.pid);
    assert.equal(holder.projectPath, FAKE_PROJECT);

    releaseSpawnLock(FAKE_PROJECT);
    assert.ok(!fs.existsSync(lockPath), 'lockfile removed after release');
});

test('acquireSpawnLock is reentrant for the same process', () => {
    acquireSpawnLock(FAKE_PROJECT);
    assert.doesNotThrow(() => acquireSpawnLock(FAKE_PROJECT));
    releaseSpawnLock(FAKE_PROJECT);
});

test('acquireSpawnLock throws when an alive holder owns the lock', () => {
    const lockPath = spawnLockPath(FAKE_PROJECT);
    // pid 1 = launchd，永远存活且不是本进程
    fs.writeFileSync(lockPath, JSON.stringify({ pid: 1, projectPath: FAKE_PROJECT, at: Date.now() }));
    assert.throws(() => acquireSpawnLock(FAKE_PROJECT), /正在 spawn\/restart/);
    fs.unlinkSync(lockPath);
});

test('acquireSpawnLock steals the lock from a dead holder', () => {
    const lockPath = spawnLockPath(FAKE_PROJECT);
    // 99999999 超出 pid 上限，必然不存在
    fs.writeFileSync(lockPath, JSON.stringify({ pid: 99999999, projectPath: FAKE_PROJECT, at: Date.now() }));
    const got = acquireSpawnLock(FAKE_PROJECT);
    const holder = JSON.parse(fs.readFileSync(got, 'utf-8'));
    assert.equal(holder.pid, process.pid, 'lock stolen by current process');
    releaseSpawnLock(FAKE_PROJECT);
});

test('releaseSpawnLock does not remove a lock held by another process', () => {
    const lockPath = spawnLockPath(FAKE_PROJECT);
    fs.writeFileSync(lockPath, JSON.stringify({ pid: 1, projectPath: FAKE_PROJECT, at: Date.now() }));
    releaseSpawnLock(FAKE_PROJECT);
    assert.ok(fs.existsSync(lockPath), 'foreign lock untouched');
    fs.unlinkSync(lockPath);
});

test('spawnLockPath differs per projectPath (worktree isolation)', () => {
    const a = spawnLockPath('/work/forest');
    const b = spawnLockPath('/work/forest-wt1/forest');
    assert.notEqual(a, b);
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

test('resolvePreviewPort reads dev-reload-info.json, falls back to 7456', () => {
    const dir = fs.mkdtempSync(pathMod.join(os.tmpdir(), 'cc-mcp-preview-'));
    fs.mkdirSync(pathMod.join(dir, '.dev'));
    fs.writeFileSync(pathMod.join(dir, '.dev', 'dev-reload-info.json'), JSON.stringify({ previewPort: 7458 }));
    assert.equal(resolvePreviewPort(dir), 7458);
    assert.equal(resolvePreviewPort('/no/such/project'), 7456);
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
    fs.writeFileSync(pathMod.join(dir, '.dev', 'dev-reload-info.json'), JSON.stringify({ previewPort: port }));
    const client = net.connect(port, '127.0.0.1');
    await new Promise((r) => client.on('connect', r));

    const target = { pid: process.pid, projectPath: dir };
    assert.throws(() => assertNoDebugSession('editor_restart', target, false), /正开着游戏预览/);
    assert.doesNotThrow(() => assertNoDebugSession('editor_restart', target, true), 'force bypasses gate');

    client.destroy();
    await new Promise((r) => srv.close(r));
    fs.rmSync(dir, { recursive: true, force: true });
});

test('assertNoDebugSession passes when no connections', () => {
    // 没人监听的项目路径 → previewPort 回落 7456，但 pid 用本进程（没连 7456）→ 0 连接
    assert.doesNotThrow(() => assertNoDebugSession('editor_kill', { pid: process.pid, projectPath: '/no/such/project' }, false));
});

test('waitReady reports readiness layers and runtime identity from registry', async () => {
    const home = fs.mkdtempSync(pathMod.join(os.tmpdir(), 'cc-mcp-ready-'));
    const projectPath = pathMod.join(home, 'fixture-project');
    const registryDir = pathMod.join(home, '.cocos-mcp', 'editors');
    fs.mkdirSync(projectPath);
    fs.mkdirSync(registryDir, { recursive: true });

    const server = http.createServer((req, res) => {
        const chunks = [];
        req.on('data', (chunk) => chunks.push(chunk));
        req.on('end', () => {
            const request = JSON.parse(Buffer.concat(chunks).toString('utf-8'));
            const result = request.method === 'tools/call'
                ? { content: [{ type: 'text', text: '{"assets":[]}' }] }
                : {};
            res.setHeader('Content-Type', 'application/json');
            res.end(JSON.stringify({ jsonrpc: '2.0', id: request.id, result }));
        });
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));

    const port = server.address().port;
    fs.writeFileSync(pathMod.join(registryDir, process.pid + '.json'), JSON.stringify({
        pid: process.pid,
        projectPath,
        projectShortName: 'fixture-project',
        host: '127.0.0.1',
        port,
        url: 'http://127.0.0.1:' + port + '/mcp',
        editorVersion: '3.8.8',
        sourceRealPath: '/source/cocos-mcp',
        sourceGitHead: 'abc123',
        sourceDirty: true,
        runtimeBuildId: 'runtime-hash',
        toolSchemaHash: 'schema-hash',
        loadedAt: '2026-08-11T00:00:00.000Z',
        updatedAt: new Date().toISOString(),
    }));

    const modulePath = pathMod.resolve(__dirname, '../src/editor-control.js');
    const script = [
        'const control = require(' + JSON.stringify(modulePath) + ');',
        'control.waitReady(' + JSON.stringify(projectPath) + ', { timeoutMs: 3000 })',
        '  .then((result) => process.stdout.write(JSON.stringify(result)))',
        '  .catch((error) => { console.error(error); process.exitCode = 1; });',
    ].join('\n');

    try {
        const stdout = await new Promise((resolve, reject) => {
            childProcess.execFile(process.execPath, ['-e', script], {
                env: Object.assign({}, process.env, { HOME: home }),
            }, (error, output, stderr) => {
                if (error) reject(Object.assign(error, { stderr }));
                else resolve(output);
            });
        });
        const result = JSON.parse(stdout);
        assert.equal(result.ready, true);
        assert.equal(result.processReady, true);
        assert.equal(result.registryReady, true);
        assert.equal(result.mcpReady, true);
        assert.equal(result.assetDbReady, true);
        assert.equal(result.projectReady, true);
        assert.equal(result.runtimeHealth, 'not_checked');
        assert.equal(result.entry.sourceRealPath, '/source/cocos-mcp');
        assert.equal(result.entry.runtimeBuildId, 'runtime-hash');
        assert.equal(result.entry.toolSchemaHash, 'schema-hash');
        assert.equal(result.entry.loadedAt, '2026-08-11T00:00:00.000Z');
    } finally {
        await new Promise((resolve) => server.close(resolve));
        fs.rmSync(home, { recursive: true, force: true });
    }
});
