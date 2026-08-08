'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const main = require('../../main.js');

test('cleanDevDir preserves the refresh command file', () => {
    const projectPath = fs.mkdtempSync(path.join(os.tmpdir(), 'cocos-mcp-clean-dev-'));
    const devDir = path.join(projectPath, '.dev');
    const previousEditor = global.Editor;

    fs.mkdirSync(devDir);
    fs.writeFileSync(path.join(devDir, 'refresh'), 'restart-package\n');
    fs.writeFileSync(path.join(devDir, 'temporary.log'), 'remove me');
    global.Editor = { Project: { path: projectPath } };

    try {
        const removed = main.methods.cleanDevDir();

        assert.deepEqual(removed, ['temporary.log']);
        assert.equal(fs.readFileSync(path.join(devDir, 'refresh'), 'utf-8'), 'restart-package\n');
        assert.equal(fs.existsSync(path.join(devDir, 'temporary.log')), false);
    } finally {
        if (previousEditor === undefined) delete global.Editor;
        else global.Editor = previousEditor;
        fs.rmSync(projectPath, { recursive: true, force: true });
    }
});
