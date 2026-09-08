'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const {
    resolvePackagePath,
    purgePackageRequireCache,
} = require('./package-reload.js');

test('resolvePackagePath requires a unique registered package, including path selectors', () => {
    const api = {
        getPackages: () => [
            { name: 'other', path: '/extensions/other' },
            { info: { name: 'cocos-mcp' }, path: '/project/extensions/cocos-mcp' },
        ],
    };

    assert.throws(() => resolvePackagePath(api, '/tmp/custom-extension'), /找不到扩展/);
    assert.throws(() => resolvePackagePath(api, '/'), /找不到扩展/);
    assert.equal(resolvePackagePath(api, 'cocos-mcp'), '/project/extensions/cocos-mcp');
    assert.equal(resolvePackagePath({ getPackages: () => [{ name: 'here', path: __dirname }] }, __dirname), __dirname);
    assert.throws(() => resolvePackagePath({ getPackages: () => [{ name: 'x', path: '/one' }, { name: 'x', path: '/two' }] }, 'x'), /找不到扩展/);
    assert.throws(() => resolvePackagePath(api, 'missing'), /找不到扩展/);
});

test('purgePackageRequireCache removes only modules inside registered and real package roots', () => {
    const registeredRoot = path.resolve('/project/extensions/cocos-mcp');
    const realRoot = path.resolve('/repo/cocos-mcp');
    const registeredMain = path.join(registeredRoot, 'main.js');
    const realTool = path.join(realRoot, 'server', 'tools.js');
    const sibling = path.resolve('/repo/cocos-mcp-extra/main.js');
    const editorModule = path.resolve('/creator/editor.js');
    const cache = {
        [registeredMain]: {},
        [realTool]: {},
        [sibling]: {},
        [editorModule]: {},
    };

    const removed = purgePackageRequireCache(registeredRoot, cache, () => realRoot);

    assert.deepEqual(new Set(removed), new Set([registeredMain, realTool]));
    assert.deepEqual(Object.keys(cache).sort(), [editorModule, sibling].sort());
});
