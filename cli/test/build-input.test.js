'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

test('build config is rechecked at the lifecycle admission boundary before spawn', async t => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cocos-build-input-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const config = path.join(root, 'build.json');
    fs.writeFileSync(config, '{"platform":"web-mobile"}');
    t.mock.method(require('../src/runtime/processes'), 'assertClosed', () => {});
    t.mock.method(require('../src/runtime/lifecycle'), 'executeLifecycle', async (tool, args, options) => {
        fs.writeFileSync(config, '{"platform":"changed-after-request"}');
        options.assertTarget();
        throw new Error('Changed config incorrectly admitted');
    });
    delete require.cache[require.resolve('../src/cli/build-cmd')];
    const { cmdBuild } = require('../src/cli/build-cmd');
    await assert.rejects(cmdBuild(['--project', root, '--cocos', process.execPath, '--config', config, '--operation-id', 'build-input']), { code: 'INPUT_CHANGED' });
});
