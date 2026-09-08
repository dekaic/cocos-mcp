'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

test('same-process HTTP reload retains lock until verified handoff and rejects the old target', async t => {
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cocos-reload-contract-')));
    const projectPath = path.join(root, 'project');
    fs.mkdirSync(path.join(projectPath, 'assets'), { recursive: true });
    fs.writeFileSync(path.join(projectPath, 'package.json'), '{"name":"reload-test"}');
    const plugin = path.resolve(__dirname, '..');
    const stateRoot = path.join(root, 'state');
    const directory = path.join(root, 'editors');
    const store = require('../cli/src/runtime/operations').createStore({ stateRoot });
    let current;
    function loadIsolatedMain() {
        const registry = require('../cli/src/runtime/registry');
        const createRegistration = registry.createRegistration;
        const readRegistry = registry.readRegistry;
        registry.createRegistration = project => createRegistration(project, directory);
        registry.readRegistry = () => readRegistry(directory);
        require('../cli/src/runtime/operations').createStore = () => store;
        return require('../main');
    }
    const previousEditor = global.Editor;
    global.Editor = { Project: { path: projectPath }, App: { version: '3.8.8' },
        Package: { getPackages: () => [{ name: 'cocos-mcp', path: plugin }] },
        Message: { request: async (target, method) => {
            if (target === 'preview') return 'http://127.0.0.1:7456/';
            if (target === 'extension' && method === 'reload') {
                const before = store.status(projectPath, 'reload-operation');
                assert.equal(before.state, 'running');
                await current.unload();
                assert.throws(() => store.gate(projectPath), { code: 'PROJECT_BUSY' });
                current = loadIsolatedMain();
                await current.load();
                assert.throws(() => store.gate(projectPath), { code: 'PROJECT_BUSY' });
                return;
            }
            return {};
        } } };
    t.after(async () => { if (current) await current.unload(); global.Editor = previousEditor; fs.rmSync(root, { recursive: true, force: true }); });
    current = loadIsolatedMain();
    await current.load();
    const old = require('../cli/src/runtime/registry').readRegistry()[0];
    const { createClient } = require('../cli/src/runtime/http-client');
    const client = createClient(old);
    const response = await client.request('tools/call', { name: 'local_reload_package', arguments: { _target: client.target, operationId: 'reload-operation', name: plugin } });
    assert.equal(response.result.structuredContent.cocosMcpControl.state, 'running');
    const deadline = Date.now() + 20000;
    while (store.status(projectPath, 'reload-operation').state === 'running' && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 25));
    const result = store.status(projectPath, 'reload-operation');
    assert.equal(result.state, 'succeeded', JSON.stringify(result));
    const fresh = require('../cli/src/runtime/registry').readRegistry()[0];
    assert.equal(old.pid, fresh.pid);
    assert.equal(old.transport.url, fresh.transport.url);
    assert.notEqual(old.instanceId, fresh.instanceId);
    const stale = await createClient(fresh).request('tools/call', { name: 'local_get_status', arguments: { _target: client.target } });
    assert.equal(stale.result.structuredContent.cocosMcpControl.code, 'TARGET_STALE');
    assert.equal(result.originalTarget.instanceId, old.instanceId);
    const reader = createClient(fresh);
    const history = await reader.request('tools/call', { name: 'local_operation_status', arguments: { _target: reader.target, operationId: 'reload-operation' } });
    assert.equal(JSON.parse(history.result.content[0].text).originalTarget.instanceId, old.instanceId);
    assert.doesNotThrow(() => store.gate(projectPath));
});
