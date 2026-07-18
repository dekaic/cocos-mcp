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

test('scene node tools route through the cocos-mcp scene script', async () => {
    const calls = [];
    const tools = createTools(calls);
    const cases = [
        ['scene_add_node', { parentUuid: 'parent', name: 'Child' }, 'addNode'],
        ['scene_clone_node', { sourceUuid: 'source', parentUuid: 'parent' }, 'cloneNode'],
        ['scene_remove_node', { uuid: 'child' }, 'removeNode'],
        ['scene_reparent_node', { uuid: 'child', parentUuid: 'parent' }, 'reparentNode'],
        ['scene_remove_component', { uuid: 'child', component: 'cc.LabelOutline' }, 'removeComponent'],
    ];

    for (const [name, args, method] of cases) {
        const tool = tools.find((item) => item.name === name);
        assert.ok(tool, name + ' is registered');
        assert.equal(await tool.handler(args), 'ok');
        assert.deepEqual(calls.pop(), [
            'scene',
            'execute-scene-script',
            { name: 'cocos-mcp', method, args: [args] },
        ]);
    }
});
