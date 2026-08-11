'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { makeTools, findTool } = require('./test/tool-fixture.js');

test('meta_fix defaults to dry-run and requires explicit dryRun=false to write', async () => {
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
    assert.deepEqual(await tool.handler({ dryRun: false }), { dryRun: false });
    assert.deepEqual(calls, [{ dryRun: true }, { dryRun: false }]);
});
