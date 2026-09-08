'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { makeTools, findTool } = require('./test/tool-fixture.js');

test('local_reload_package records completion only after the reload completion promise', async () => {
    const scheduled = [];
    const tool = findTool(makeTools({
        local: {
            getStatus: async function () {
                return {
                    extensionRuntime: {
                        runtimeBuildId: 'before-build',
                        toolSchemaHash: 'before-schema',
                        loadedAt: '2026-08-12T00:00:00.000Z',
                    },
                };
            },
            reloadPackage: async function (name) { scheduled.push(name); return { instanceId: 'next-generation', verified: true }; },
        },
    }), 'local_reload_package');

    const result = await tool.handler({ name: 'cocos-mcp' });

    assert.deepEqual(scheduled, ['cocos-mcp']);
    assert.equal(result.ok, true);
    assert.equal(result.reloaded, 'cocos-mcp');
    assert.equal(result.accepted, true);
    assert.equal(result.state, 'completed');
    assert.equal(result.completionObserved, true);
    assert.deepEqual(result.runtimeIdentityBefore, {
        runtimeBuildId: 'before-build',
        toolSchemaHash: 'before-schema',
        loadedAt: '2026-08-12T00:00:00.000Z',
    });
});
