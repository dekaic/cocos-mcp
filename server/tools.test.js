'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { defineTools } = require('./tools.js');

test('scene_create_component forwards node uuid and component class to Cocos', async () => {
    const calls = [];
    const tools = defineTools({
        msg: async function () {
            calls.push(Array.from(arguments));
            return 'created';
        },
        local: {},
    });
    const tool = tools.find(function (item) { return item.name === 'scene_create_component'; });

    assert.ok(tool, 'scene_create_component is registered');
    assert.deepEqual(tool.inputSchema.required, ['uuid', 'component']);
    assert.equal(
        await tool.handler({ uuid: 'node-uuid', component: 'cc.UISkew' }),
        'created'
    );
    assert.deepEqual(calls, [[
        'scene',
        'create-component',
        { uuid: 'node-uuid', component: 'cc.UISkew' },
    ]]);
});
