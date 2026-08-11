'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { makeTools, findTool } = require('./test/tool-fixture.js');

test('local_reload_package reports scheduled state and the runtime identity to compare', async () => {
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
            reloadPackage: function (name) { scheduled.push(name); },
        },
    }), 'local_reload_package');

    const result = await tool.handler({ name: 'cocos-mcp' });

    assert.deepEqual(scheduled, ['cocos-mcp']);
    assert.equal(result.ok, true);
    assert.equal(result.reloaded, 'cocos-mcp');
    assert.equal(result.accepted, true);
    assert.equal(result.state, 'scheduled');
    assert.equal(result.completionObserved, false);
    assert.deepEqual(result.runtimeIdentityBefore, {
        runtimeBuildId: 'before-build',
        toolSchemaHash: 'before-schema',
        loadedAt: '2026-08-12T00:00:00.000Z',
    });
});
