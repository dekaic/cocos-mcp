'use strict';

var fs = require('fs');
var path = require('path');
var cp = require('child_process');
var crypto = require('crypto');

var RUNTIME_ENTRIES = [
    'package.json',
    'main.js',
    'panel',
    'scene',
    'server',
    path.join('cli', 'src'),
    path.join('cli', 'bin'),
    'mcp-sdk',
];

function collectRuntimeFiles(root) {
    var out = [];

    function visit(abs, rel) {
        var stat;
        try { stat = fs.statSync(abs); } catch (e) { return; }

        if (stat.isDirectory()) {
            var base = path.basename(abs);
            if (base === '.git' || base === 'node_modules' || base === 'test') return;
            fs.readdirSync(abs).sort().forEach(function (name) {
                visit(path.join(abs, name), path.join(rel, name));
            });
            return;
        }

        if (!stat.isFile()) return;
        if (/\.test\.js$/.test(rel)) return;
        if (!/\.(js|json)$/.test(rel)) return;
        out.push({ abs: abs, rel: rel.split(path.sep).join('/') });
    }

    RUNTIME_ENTRIES.forEach(function (entry) {
        visit(path.join(root, entry), entry);
    });
    return out.sort(function (a, b) { return a.rel.localeCompare(b.rel); });
}

function hashRuntimeFiles(root) {
    var hash = crypto.createHash('sha256');
    collectRuntimeFiles(root).forEach(function (file) {
        hash.update(file.rel);
        hash.update('\0');
        hash.update(fs.readFileSync(file.abs));
        hash.update('\0');
    });
    return hash.digest('hex');
}

function git(root, args) {
    try {
        return cp.execFileSync('git', ['-C', root].concat(args), {
            encoding: 'utf-8',
            stdio: ['ignore', 'pipe', 'ignore'],
        }).trim();
    } catch (e) {
        return '';
    }
}

function createRuntimeIdentity(root) {
    var realRoot;
    try { realRoot = fs.realpathSync(root); } catch (e) { realRoot = path.resolve(root); }
    var status = git(realRoot, ['status', '--porcelain', '--untracked-files=normal']);
    return {
        sourceRealPath: realRoot,
        sourceGitHead: git(realRoot, ['rev-parse', 'HEAD']),
        sourceDirty: !!status,
        runtimeBuildId: hashRuntimeFiles(realRoot),
        toolSchemaHash: '',
        loadedAt: new Date().toISOString(),
    };
}

function sortObject(value) {
    if (Array.isArray(value)) return value.map(sortObject);
    if (!value || typeof value !== 'object') return value;
    var out = {};
    Object.keys(value).sort().forEach(function (key) {
        out[key] = sortObject(value[key]);
    });
    return out;
}

function hashToolSchemas(tools) {
    var stable = (tools || []).map(function (tool) {
        return {
            name: tool.name,
            description: tool.description || '',
            inputSchema: sortObject(tool.inputSchema || {}),
        };
    }).sort(function (a, b) { return a.name.localeCompare(b.name); });
    return crypto.createHash('sha256').update(JSON.stringify(stable)).digest('hex');
}

module.exports = {
    createRuntimeIdentity: createRuntimeIdentity,
    hashRuntimeFiles: hashRuntimeFiles,
    hashToolSchemas: hashToolSchemas,
};
