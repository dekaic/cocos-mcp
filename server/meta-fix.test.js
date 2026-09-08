'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { makeTools, findTool } = require('./test/tool-fixture.js');

test('meta_fix is preview-only inside Creator and rejects explicit writes', async () => {
    const calls = [];
    const tool = findTool(makeTools({
        local: {
            fixMeta: function (options) {
                calls.push(options);
                return options;
            },
        },
    }), 'meta_fix');

    assert.equal(tool.inputSchema.properties.dryRun.default, true);
    assert.deepEqual(await tool.handler({}), { dryRun: true });
    await assert.rejects(tool.handler({ dryRun: false }), /OFFLINE_REQUIRED/);
    assert.deepEqual(calls, [{ dryRun: true }]);
});
