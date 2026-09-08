'use strict';

const Module = require('node:module');
const path = require('node:path');
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { defineTools } = require('./tools.js');

function createTools(calls) {
    return defineTools({
        msg: async function () {
            calls.push(Array.from(arguments));
            return 'ok';
        },
        local: {},
    });
}

function loadSceneMethods(scene) {
    const filename = path.resolve(__dirname, '../scene/index.js');
    const originalLoad = Module._load;
    const originalEditor = global.Editor;

    global.Editor = { App: { path: '/tmp/cocos-creator' } };
    Module._load = function (request) {
        if (request === 'cc') {
            return { director: { getScene: function () { return scene; } } };
        }
        return originalLoad.apply(this, arguments);
    };
    delete require.cache[filename];

    try {
        return require(filename).methods;
    } finally {
        Module._load = originalLoad;
        global.Editor = originalEditor;
        delete require.cache[filename];
    }
}

test('scene_query_node_tree reads through the cocos-mcp scene script', async () => {
    const calls = [];
    const tool = createTools(calls).find((item) => item.name === 'scene_query_node_tree');

    assert.equal(await tool.handler({ uuid: 'node' }), 'ok');
    assert.deepEqual(calls, [[
        'scene',
        'execute-scene-script',
        { name: 'cocos-mcp', method: 'queryNodeTree', args: ['node'] },
    ]]);
});

test('scene_execute_component_method validates before using the Creator scene message', async () => {
    const calls = [];
    const tool = createTools(calls).find((item) => item.name === 'scene_execute_component_method');
    const args = { uuid: 'component', name: 'runProbe', args: ['value'] };

    assert.equal(await tool.handler(args), 'ok');
    assert.equal(tool.inputSchema.properties.uuid.description, '组件 UUID（从 scene_query_node 的组件 dump 中取得）');
    assert.deepEqual(calls, [
        ['scene', 'execute-scene-script', {
            name: 'cocos-mcp',
            method: 'validateComponentMethod',
            args: [args],
        }],
        ['scene', 'execute-component-method', args],
    ]);
});

test('scene component method validation fails closed without invoking the method', () => {
    let callCount = 0;
    const component = {
        uuid: 'component',
        runProbe: function () { callCount += 1; },
    };
    const node = { uuid: 'node', components: [component], children: [] };
    const scene = { uuid: 'scene', components: [], children: [node] };
    const methods = loadSceneMethods(scene);

    assert.deepEqual(methods.validateComponentMethod({
        uuid: 'component',
        name: 'runProbe',
        args: [],
    }), { uuid: 'component', name: 'runProbe' });
    assert.equal(callCount, 0, 'validation must not invoke the component method');
    Object.defineProperty(component, 'getterMethod', { get() { callCount++; return () => {}; } });
    assert.throws(() => methods.validateComponentMethod({ uuid: 'component', name: 'getterMethod', args: [] }), /method not found/);
    assert.equal(callCount, 0, 'validation must not invoke a method accessor');

    assert.throws(
        () => methods.validateComponentMethod({ uuid: 'node', name: 'runProbe', args: [] }),
        /component not found: node/,
    );
    assert.throws(
        () => methods.validateComponentMethod({ uuid: 'missing', name: 'runProbe', args: [] }),
        /component not found: missing/,
    );
    assert.throws(
        () => methods.validateComponentMethod({ uuid: 'component', name: 'missing', args: [] }),
        /method not found: missing/,
    );
    assert.throws(
        () => methods.validateComponentMethod({
            uuid: 'component',
            name: 'runProbe',
            args: 'not-an-array',
        }),
        /args must be an array/,
    );
});

test('scene_instantiate_prefab exposes the minimal prefab instance schema', () => {
    const tool = createTools([]).find((item) => item.name === 'scene_instantiate_prefab');

    assert.ok(tool, 'scene_instantiate_prefab is registered');
    assert.deepEqual(tool.inputSchema.required, ['parentUuid', 'prefabUuid']);
    assert.deepEqual(Object.keys(tool.inputSchema.properties), [
        'parentUuid',
        'prefabUuid',
        'name',
        'position',
        'active',
    ]);
});

test('scene_instantiate_prefab records prefab root name and active overrides', async () => {
    const calls = [];
    const tool = defineTools({
        msg: async function () {
            const call = Array.from(arguments);
            calls.push(call);
            if (call[1] === 'execute-scene-script') {
                return { uuid: 'instance', name: 'Prefab', parentUuid: 'parent' };
            }
            return 'undo';
        },
        local: {},
    }).find((item) => item.name === 'scene_instantiate_prefab');

    assert.deepEqual(await tool.handler({
        parentUuid: 'parent',
        prefabUuid: 'prefab',
        name: 'Renamed',
        active: false,
    }), { uuid: 'instance', name: 'Renamed', parentUuid: 'parent' });
    assert.deepEqual(calls, [
        ['scene', 'begin-recording', ['parent']],
        ['scene', 'execute-scene-script', {
            name: 'cocos-mcp',
            method: 'instantiatePrefab',
            args: [{
                parentUuid: 'parent',
                prefabUuid: 'prefab',
                name: 'Renamed',
                active: false,
            }],
        }],
        ['scene', 'set-property', {
            uuid: 'instance',
            path: 'name',
            dump: { type: 'String', value: 'Renamed' },
        }],
        ['scene', 'set-property', {
            uuid: 'instance',
            path: 'active',
            dump: { type: 'Boolean', value: false },
        }],
        ['scene', 'end-recording', 'undo'],
    ]);
});

test('scene node tools route through the cocos-mcp scene script', async () => {
    const calls = [];
    const tools = createTools(calls);
    const cases = [
        ['scene_add_node', { parentUuid: 'parent', name: 'Child' }, 'addNode'],
        ['scene_instantiate_prefab', { parentUuid: 'parent', prefabUuid: 'prefab' }, 'instantiatePrefab'],
        ['scene_clone_node', { sourceUuid: 'source', parentUuid: 'parent' }, 'cloneNode'],
        ['scene_remove_node', { uuid: 'child' }, 'removeNode'],
        ['scene_reparent_node', { uuid: 'child', parentUuid: 'parent' }, 'reparentNode'],
        ['scene_remove_component', { uuid: 'child', component: 'cc.LabelOutline' }, 'removeComponent'],
    ];

    for (const [name, args, method] of cases) {
        const tool = tools.find((item) => item.name === name);
        assert.ok(tool, name + ' is registered');
        assert.equal(await tool.handler(args), 'ok');
        assert.deepEqual(calls.splice(-3), [
            ['scene', 'begin-recording', name === 'scene_add_node' || name === 'scene_instantiate_prefab'
                ? ['parent']
                : name === 'scene_clone_node'
                    ? ['source', 'parent']
                    : name === 'scene_reparent_node'
                        ? ['child', 'parent']
                        : ['child']],
            ['scene', 'execute-scene-script', { name: 'cocos-mcp', method, args: [args] }],
            ['scene', 'end-recording', 'ok'],
        ]);
    }
});
