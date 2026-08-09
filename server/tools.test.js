'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { defineTools } = require('./tools.js');

test('scene_create_component uses the validated scene script with undo recording', async () => {
    const calls = [];
    const tools = defineTools({
        msg: async function () {
            calls.push(Array.from(arguments));
            return arguments[1] === 'begin-recording' ? 'undo-1' : 'created';
        },
        local: {},
    });
    const tool = tools.find(function (item) { return item.name === 'scene_create_component'; });

    assert.ok(tool, 'scene_create_component is registered');
    assert.deepEqual(tool.inputSchema.required, ['uuid', 'component', 'operationId']);
    assert.deepEqual(
        await tool.handler({ uuid: 'node-uuid', component: 'cc.UISkew', operationId: 'op-create-component-1' }),
        { operationId: 'op-create-component-1', result: 'created' }
    );
    assert.deepEqual(calls, [
        ['scene', 'begin-recording', ['node-uuid']],
        ['scene', 'execute-scene-script', {
            name: 'cocos-mcp',
            method: 'createComponent',
            args: [{ uuid: 'node-uuid', component: 'cc.UISkew' }],
        }],
        ['scene', 'end-recording', 'undo-1'],
    ]);
});

test('scene mutation preserves the original error when undo cancellation also fails', async () => {
    const tools = defineTools({
        msg: async function (_target, name) {
            if (name === 'begin-recording') return 'undo-1';
            if (name === 'execute-scene-script') throw new Error('component class not found: Bad');
            if (name === 'cancel-recording') throw new Error('cancel failed');
            return null;
        },
        local: {},
    });
    const tool = tools.find((item) => item.name === 'scene_create_component');
    await assert.rejects(
        tool.handler({ uuid: 'node', component: 'Bad', operationId: 'op-create-component-bad' }),
        /component class not found: Bad/
    );
});

test('scene mutation reuses operationId result instead of applying twice', async () => {
    const calls = [];
    const tools = defineTools({
        msg: async function () {
            const args = Array.from(arguments);
            calls.push(args);
            if (args[1] === 'begin-recording') return 'undo-dedupe';
            if (args[1] === 'execute-scene-script') return { uuid: 'created-node' };
            return true;
        },
        local: {},
    });
    const add = tools.find((item) => item.name === 'scene_add_node');
    const query = tools.find((item) => item.name === 'scene_query_operation');
    const args = { parentUuid: 'parent', name: 'Child', operationId: 'op-dedupe-add-node' };

    const first = await add.handler(args);
    const second = await add.handler({ name: 'Child', operationId: 'op-dedupe-add-node', parentUuid: 'parent' });

    assert.deepEqual(second, first);
    assert.equal(calls.filter((call) => call[1] === 'begin-recording').length, 1);
    assert.equal(calls.filter((call) => call[1] === 'execute-scene-script').length, 1);
    assert.equal((await query.handler({ operationId: 'op-dedupe-add-node' })).status, 'succeeded');
});

test('scene mutation rejects operationId reuse with different arguments', async () => {
    const tools = defineTools({
        msg: async function (_target, name) {
            if (name === 'begin-recording') return 'undo-conflict';
            if (name === 'execute-scene-script') return { uuid: 'created-node' };
            return true;
        },
        local: {},
    });
    const add = tools.find((item) => item.name === 'scene_add_node');
    await add.handler({ parentUuid: 'parent', name: 'A', operationId: 'op-conflicting-id' });
    await assert.rejects(
        add.handler({ parentUuid: 'parent', name: 'B', operationId: 'op-conflicting-id' }),
        /already used with different arguments/
    );
});

test('scene_remove_node retry reaches the operation journal before querying a deleted node', async () => {
    const calls = [];
    const tools = defineTools({
        msg: async function (_target, name, payload) {
            calls.push(Array.from(arguments));
            if (name === 'begin-recording') return 'undo-remove';
            if (name === 'execute-scene-script' && payload.method === 'queryNodeContext') {
                return { uuid: 'child', parentUuid: 'parent' };
            }
            if (name === 'execute-scene-script' && payload.method === 'removeNode') {
                return { uuid: 'child', removed: true };
            }
            return true;
        },
        local: {},
    });
    const remove = tools.find((item) => item.name === 'scene_remove_node');
    const args = { uuid: 'child', operationId: 'op-remove-retry-1' };

    const first = await remove.handler(args);
    const second = await remove.handler(args);

    assert.deepEqual(second, first);
    assert.equal(calls.filter((call) => call[1] === 'execute-scene-script' && call[2].method === 'queryNodeContext').length, 1);
    assert.equal(calls.filter((call) => call[1] === 'execute-scene-script' && call[2].method === 'removeNode').length, 1);
});

test('scene tools reject missing required arguments before sending IPC', async () => {
    const calls = [];
    const tools = defineTools({
        msg: async function () {
            calls.push(Array.from(arguments));
            return null;
        },
        local: {},
    });

    await assert.rejects(
        tools.find((item) => item.name === 'scene_open_scene').handler({ url: 'db://assets/Main.scene' }),
        /uuid.*required/i
    );
    await assert.rejects(
        tools.find((item) => item.name === 'scene_query_node').handler({}),
        /uuid.*required/i
    );
    await assert.rejects(
        tools.find((item) => item.name === 'scene_execute_component_method').handler({ uuid: 'comp' }),
        /name.*required/i
    );
    assert.deepEqual(calls, []);
});

test('scene_query_node rejects Cocos null instead of reporting a false success', async () => {
    const tools = defineTools({ msg: async () => null, local: {} });
    const tool = tools.find((item) => item.name === 'scene_query_node');
    await assert.rejects(tool.handler({ uuid: 'missing-node' }), /not found.*missing-node/i);
});

test('scene IPC has a bounded timeout with an actionable error', async () => {
    const tools = defineTools({
        msg: async () => new Promise(() => {}),
        local: {},
        sceneTimeoutMs: 10,
    });
    const tool = tools.find((item) => item.name === 'scene_query_node');
    await assert.rejects(tool.handler({ uuid: 'node' }), /scene query-node.*timed out.*10ms/i);
});

test('scene_open_scene validates the asset before asking Cocos to open it', async () => {
    const calls = [];
    const tools = defineTools({
        msg: async function () {
            const args = Array.from(arguments);
            calls.push(args);
            if (args[0] === 'asset-db') return null;
            return 'opened';
        },
        local: {},
    });
    const tool = tools.find((item) => item.name === 'scene_open_scene');
    await assert.rejects(tool.handler({ uuid: 'missing-scene' }), /scene asset not found/i);
    assert.deepEqual(calls, [['asset-db', 'query-asset-info', 'missing-scene']]);
});

test('scene_open_scene rejects assets that are not scenes', async () => {
    const calls = [];
    const tools = defineTools({
        msg: async function () {
            const args = Array.from(arguments);
            calls.push(args);
            if (args[0] === 'asset-db') return { uuid: args[2], type: 'cc.Prefab' };
            return 'opened';
        },
        local: {},
    });
    const tool = tools.find((item) => item.name === 'scene_open_scene');
    await assert.rejects(tool.handler({ uuid: 'prefab-uuid' }), /not a cc\.SceneAsset/i);
    assert.equal(calls.some((call) => call[0] === 'scene' && call[1] === 'open-scene'), false);
});

test('scene_save_scene refuses untitled scenes instead of opening a blocking Save As dialog', async () => {
    const calls = [];
    const tools = defineTools({
        msg: async function () {
            const args = Array.from(arguments);
            calls.push(args);
            if (args[0] === 'scene' && args[1] === 'execute-scene-script') {
                return { uuid: 'runtime-only', name: 'scene-2d' };
            }
            if (args[0] === 'asset-db') return null;
            return 'saved';
        },
        local: {},
    });
    const tool = tools.find((item) => item.name === 'scene_save_scene');
    await assert.rejects(tool.handler({}), /untitled scene.*save it in Creator/i);
    assert.equal(calls.some((call) => call[0] === 'scene' && call[1] === 'save-scene'), false);
});

test('scene_set_property rejects an unknown dump path before mutation', async () => {
    const calls = [];
    const tools = defineTools({
        msg: async function () {
            const args = Array.from(arguments);
            calls.push(args);
            if (args[1] === 'query-node') return { position: { value: { x: 0, y: 0, z: 0 } } };
            return true;
        },
        local: {},
    });
    const tool = tools.find((item) => item.name === 'scene_set_property');
    await assert.rejects(
        tool.handler({ uuid: 'node', path: 'missing.path', dump: { type: 'Number', value: 2 } }),
        /property path not found.*missing\.path/i
    );
    assert.equal(calls.some((call) => call[1] === 'set-property'), false);
});

test('scene_set_property returns a verified before/after result', async () => {
    const calls = [];
    let queryCount = 0;
    const tools = defineTools({
        msg: async function () {
            const args = Array.from(arguments);
            calls.push(args);
            if (args[1] === 'query-node') {
                queryCount++;
                return { position: { value: { x: queryCount === 1 ? 0 : 5, y: 0, z: 0 } } };
            }
            return true;
        },
        local: {},
    });
    const tool = tools.find((item) => item.name === 'scene_set_property');
    const result = await tool.handler({
        uuid: 'node', path: 'position', dump: { type: 'Vec3', value: { x: 5, y: 0, z: 0 } },
    });
    assert.deepEqual(result, {
        changed: true,
        target: 'node',
        path: 'position',
        before: { x: 0, y: 0, z: 0 },
        after: { x: 5, y: 0, z: 0 },
    });
});

test('scene_set_property resolves component fields through Inspector value wrappers', async () => {
    const calls = [];
    let queryCount = 0;
    const tools = defineTools({
        msg: async function () {
            const args = Array.from(arguments);
            calls.push(args);
            if (args[1] === 'query-node') {
                queryCount++;
                return {
                    __comps__: [{
                        value: {
                            uiRoot: {
                                type: 'cc.Node',
                                value: { uuid: queryCount === 1 ? '' : 'ui-root-uuid' },
                            },
                        },
                    }],
                };
            }
            return true;
        },
        local: {},
    });
    const tool = tools.find((item) => item.name === 'scene_set_property');
    const result = await tool.handler({
        uuid: 'feature-node',
        path: '__comps__.0.uiRoot',
        dump: { type: 'cc.Node', value: { uuid: 'ui-root-uuid' } },
    });

    assert.deepEqual(result, {
        changed: true,
        target: 'feature-node',
        path: '__comps__.0.uiRoot',
        before: { uuid: '' },
        after: { uuid: 'ui-root-uuid' },
    });
    assert.deepEqual(
        calls.find((call) => call[1] === 'set-property'),
        ['scene', 'set-property', {
            uuid: 'feature-node',
            path: '__comps__.0.uiRoot',
            dump: { type: 'cc.Node', value: { uuid: 'ui-root-uuid' } },
        }]
    );
});

test('scene_execute_component_method routes through strict component validation', async () => {
    const calls = [];
    const tools = defineTools({
        msg: async function () {
            const args = Array.from(arguments);
            calls.push(args);
            if (args[1] === 'begin-recording') return 'undo-method';
            if (args[1] === 'execute-scene-script') return { executed: true, result: 7 };
            return true;
        },
        local: {},
    });
    const tool = tools.find((item) => item.name === 'scene_execute_component_method');
    const result = await tool.handler({
        uuid: 'component-uuid', name: 'rebuild', args: [7], operationId: 'op-component-method-1',
    });
    assert.deepEqual(result, { operationId: 'op-component-method-1', executed: true, result: 7 });
    assert.deepEqual(calls, [
        ['scene', 'begin-recording', ['component-uuid']],
        ['scene', 'execute-scene-script', {
            name: 'cocos-mcp', method: 'executeComponentMethod',
            args: [{ uuid: 'component-uuid', name: 'rebuild', args: [7] }],
        }],
        ['scene', 'end-recording', 'undo-method'],
    ]);
});

test('asset_create reports conflicts and returns structured create/overwrite state', async () => {
    const calls = [];
    let existing = { uuid: 'asset-1', url: 'db://assets/Test.json' };
    const tools = defineTools({
        msg: async function () {
            const args = Array.from(arguments);
            calls.push(args);
            if (args[1] === 'query-asset-info') return existing;
            if (args[1] === 'create-asset') {
                existing = { uuid: 'asset-1', url: args[2] };
                return existing;
            }
            return null;
        },
        local: {},
    });
    const tool = tools.find((item) => item.name === 'asset_create');
    await assert.rejects(
        tool.handler({ url: 'db://assets/Test.json', content: '{}' }),
        /asset already exists.*overwrite/i
    );
    assert.equal(calls.some((call) => call[1] === 'create-asset'), false);

    const overwritten = await tool.handler({
        url: 'db://assets/Test.json', content: '{"v":2}', overwrite: true,
    });
    assert.deepEqual(overwritten, { created: false, overwritten: true, asset: existing });

    existing = null;
    const created = await tool.handler({ url: 'db://assets/New.json', content: '{}' });
    assert.equal(created.created, true);
    assert.equal(created.overwritten, false);
    assert.equal(created.asset.url, 'db://assets/New.json');
});

test('asset lookup tools reject missing assets instead of returning empty success', async () => {
    const tools = defineTools({ msg: async () => null, local: {} });
    await assert.rejects(
        tools.find((item) => item.name === 'asset_query_info').handler({ urlOrUUID: 'db://assets/Missing.prefab' }),
        /asset not found/i
    );
    await assert.rejects(
        tools.find((item) => item.name === 'asset_query_url').handler({ uuid: 'missing-uuid' }),
        /asset url not found/i
    );
    await assert.rejects(
        tools.find((item) => item.name === 'asset_query_uuid').handler({ url: 'db://assets/Missing.prefab' }),
        /asset uuid not found/i
    );
});
