'use strict';

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

test('scene_query_node_tree hides Creator editor-only helper roots', async () => {
    const tools = defineTools({
        msg: async () => ({
            uuid: 'scene',
            name: 'Main',
            children: [
                { uuid: 'canvas', name: 'Canvas', children: [] },
                { uuid: 'fg', name: 'Editor Scene Foreground', children: [] },
                { uuid: 'bg', name: 'Editor Scene Background', children: [] },
            ],
        }),
        local: {},
    });
    const tool = tools.find((item) => item.name === 'scene_query_node_tree');
    const result = await tool.handler({});
    assert.deepEqual(result.children.map((child) => child.name), ['Canvas']);
});

test('scene node tools route through the cocos-mcp scene script', async () => {
    const calls = [];
    const tools = createTools(calls);
    const cases = [
        ['scene_add_node', { parentUuid: 'parent', name: 'Child', operationId: 'op-add-node-1' }, 'addNode'],
        ['scene_clone_node', { sourceUuid: 'source', parentUuid: 'parent', operationId: 'op-clone-node-1' }, 'cloneNode'],
        ['scene_remove_node', { uuid: 'child', operationId: 'op-remove-node-1' }, 'removeNode'],
        ['scene_reparent_node', { uuid: 'child', parentUuid: 'parent', operationId: 'op-reparent-node-1' }, 'reparentNode'],
        ['scene_remove_component', { uuid: 'child', component: 'cc.LabelOutline', operationId: 'op-remove-comp-1' }, 'removeComponent'],
    ];

    for (const [name, args, method] of cases) {
        const tool = tools.find((item) => item.name === name);
        assert.ok(tool, name + ' is registered');
        assert.deepEqual(await tool.handler(args), { operationId: args.operationId, result: 'ok' });
        const forwarded = Object.assign({}, args);
        delete forwarded.operationId;
        assert.deepEqual(calls.splice(-3), [
            ['scene', 'begin-recording', name === 'scene_add_node'
                ? ['parent']
                : name === 'scene_clone_node'
                    ? ['source', 'parent']
                    : name === 'scene_reparent_node'
                        ? ['child', 'parent']
                        : ['child']],
            ['scene', 'execute-scene-script', { name: 'cocos-mcp', method, args: [forwarded] }],
            ['scene', 'end-recording', 'ok'],
        ]);
    }
});
