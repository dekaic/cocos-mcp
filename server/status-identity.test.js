'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');
const { makeTools, findTool } = require('./test/tool-fixture');

test('identity status uses in-memory identity and catalogs without Git, preview or file access', async t => {
    const filename = path.join(__dirname, '..', 'main.js');
    const localRequire = createRequire(filename);
    const calls = [];
    let diagnosticMode = false;
    const context = vm.createContext({ exports: {}, __dirname: path.dirname(filename), process, console: { log() {} },
        require: name => {
            if (name === './server/runtime-identity') return { createRuntimeIdentity: () => ({ runtimeBuildId: 'loaded-build', loadedAt: 'loaded-time' }) };
            if (name === 'child_process') return { execFileSync: () => { calls.push('git'); if (!diagnosticMode) throw new Error('unexpected process'); return 'fixture'; } };
            if (name === 'fs') return new Proxy({}, { get: (_, method) => () => {
                calls.push('fs:' + method);
                if (!diagnosticMode) throw new Error('unexpected IO');
                if (method === 'existsSync') return false;
            } });
            return localRequire(name);
        },
        Editor: { Project: { path: '/project' }, Message: { request: () => {
            calls.push('preview'); if (!diagnosticMode) throw new Error('unexpected preview'); return 'http://127.0.0.1:7000';
        } } },
    });
    vm.runInContext(fs.readFileSync(filename, 'utf8'), context, { filename });
    vm.runInContext("_registration = {projectPath:'/real/project', instanceId:'generation', owner:{pid:123,startId:'start'}}; _mcpServer = {catalogVersions:()=>({tools:'tool-version',resources:'resource-version'})};", context);
    const identity = await context.exports.methods.getStatus('identity');
    assert.deepEqual(JSON.parse(JSON.stringify(identity)), {
        projectPath: '/real/project', instanceId: 'generation', processIdentity: { pid: 123, startId: 'start' },
        extensionRuntime: { runtimeBuildId: 'loaded-build', loadedAt: 'loaded-time', toolSchemaHash: 'tool-version' },
        catalogVersions: { tools: 'tool-version', resources: 'resource-version' },
    });
    assert.deepEqual(calls, []);
    diagnosticMode = true;
    for (let i = 0; i < 10; i++) await context.exports.methods.getStatus();
    const full = { git: calls.filter(call => call === 'git').length, preview: calls.filter(call => call === 'preview').length,
        stateWrites: calls.filter(call => call === 'fs:writeFileSync').length };
    assert.deepEqual(full, { git: 20, preview: 10, stateWrites: 10 });
    calls.length = 0;
    diagnosticMode = false;
    for (let i = 0; i < 10; i++) await context.exports.methods.getStatus('identity');
    assert.deepEqual(calls, []);
    t.diagnostic(JSON.stringify({ scans: 10, simulatedDependencies: true, full, identity: { git: 0, preview: 0, stateWrites: 0 } }));
});

test('status mode is optional and default calls still request full diagnostics', async () => {
    const modes = [];
    const tool = findTool(makeTools({ local: { getStatus: mode => { modes.push(mode); return { mode }; } } }), 'local_get_status');
    await tool.handler({});
    await tool.handler({ mode: 'identity' });
    assert.deepEqual(modes, [undefined, 'identity']);
    assert.deepEqual(tool.inputSchema.properties.mode.enum, ['identity']);
});
