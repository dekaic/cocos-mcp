'use strict';

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const root = path.resolve(__dirname, '..');
const testRoots = ['cli/test', 'router/test', 'server', 'mcp-sdk/test'];

function collect(dir, out) {
    fs.readdirSync(dir, { withFileTypes: true }).forEach((entry) => {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) collect(full, out);
        else if (entry.isFile() && entry.name.endsWith('.test.js')) out.push(full);
    });
}

const files = [];
testRoots.forEach((relative) => collect(path.join(root, relative), files));
files.sort();

const result = spawnSync(process.execPath, ['--test'].concat(files), {
    cwd: root,
    stdio: 'inherit',
});

if (result.error) throw result.error;
process.exit(result.status === null ? 1 : result.status);
