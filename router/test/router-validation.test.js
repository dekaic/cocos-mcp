'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const cp = require('node:child_process');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');

function waitForResponse(child, id) {
    return new Promise((resolve, reject) => {
        var buffer = '';
        var timer = setTimeout(function () {
            reject(new Error('router response timed out'));
        }, 5000);

        child.stdout.setEncoding('utf8');
        child.stdout.on('data', function (chunk) {
            buffer += chunk;
            var lines = buffer.split('\n');
            buffer = lines.pop();
            for (var line of lines) {
                if (!line.trim()) continue;
                var message = JSON.parse(line);
                if (message.id === id) {
                    clearTimeout(timer);
                    resolve(message);
                    return;
                }
            }
        });
        child.once('error', function (error) {
            clearTimeout(timer);
            reject(error);
        });
        child.once('exit', function (code, signal) {
            if (timer) {
                clearTimeout(timer);
                reject(new Error('router exited before response: code=' + code + ' signal=' + signal));
            }
        });
    });
}

test('router rejects missing editor-tool arguments before forwarding', async () => {
    var forwardedCalls = 0;
    var editor = http.createServer(function (request, response) {
        var chunks = [];
        request.on('data', function (chunk) { chunks.push(chunk); });
        request.on('end', function () {
            var rpc = JSON.parse(Buffer.concat(chunks).toString('utf8'));
            var result;
            if (rpc.method === 'tools/list') {
                result = { tools: [{
                    name: 'scene_open_scene',
                    description: 'open scene',
                    inputSchema: {
                        type: 'object',
                        properties: { uuid: { type: 'string' } },
                        required: ['uuid'],
                    },
                }] };
            } else if (rpc.method === 'resources/list') {
                result = { resources: [] };
            } else if (rpc.method === 'tools/call') {
                forwardedCalls++;
                result = { content: [{ type: 'text', text: '(ok)' }] };
            } else {
                result = { protocolVersion: '2024-11-05', capabilities: {}, serverInfo: { name: 'fixture' } };
            }
            var body = JSON.stringify({ jsonrpc: '2.0', id: rpc.id, result: result });
            response.writeHead(200, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) });
            response.end(body);
        });
    });

    await new Promise(function (resolve) { editor.listen(0, '127.0.0.1', resolve); });
    var home = fs.mkdtempSync(path.join(os.tmpdir(), 'cocos-mcp-router-home-'));
    var registry = path.join(home, '.cocos-mcp', 'editors');
    fs.mkdirSync(registry, { recursive: true });
    fs.writeFileSync(path.join(registry, process.pid + '.json'), JSON.stringify({
        pid: process.pid,
        projectPath: '/tmp/router-validation-project',
        projectShortName: 'fixture',
        startedAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        url: 'http://127.0.0.1:' + editor.address().port + '/mcp',
    }));

    var child = cp.spawn(process.execPath, [path.resolve(__dirname, '../bin.js')], {
        env: Object.assign({}, process.env, { HOME: home }),
        stdio: ['pipe', 'pipe', 'pipe'],
    });

    try {
        var id = 81;
        var responsePromise = waitForResponse(child, id);
        child.stdin.write(JSON.stringify({
            jsonrpc: '2.0',
            id: id,
            method: 'tools/call',
            params: {
                name: 'fixture__scene_open_scene',
                arguments: { url: 'db://assets/example.scene' },
            },
        }) + '\n');

        var response = await responsePromise;
        assert.equal(response.error, undefined);
        assert.equal(response.result.isError, true);
        assert.match(response.result.content[0].text, /\[scene_open_scene\] Missing required argument: uuid/);
        assert.equal(forwardedCalls, 0);
    } finally {
        child.kill('SIGTERM');
        await new Promise(function (resolve) { child.once('exit', resolve); });
        await new Promise(function (resolve) { editor.close(resolve); });
        fs.rmSync(home, { recursive: true, force: true });
    }
});

test('router stale cleanup preserves spawn locks', async () => {
    var home = fs.mkdtempSync(path.join(os.tmpdir(), 'cocos-mcp-router-home-'));
    var registry = path.join(home, '.cocos-mcp', 'editors');
    fs.mkdirSync(registry, { recursive: true });

    var staleEditor = path.join(registry, '99999999.json');
    var spawnLock = path.join(registry, 'spawn-lock-fixture-deadbeef00.json');
    fs.writeFileSync(staleEditor, JSON.stringify({ pid: 99999999 }));
    fs.writeFileSync(spawnLock, JSON.stringify({
        pid: process.pid,
        projectPath: '/tmp/router-validation-project',
        at: Date.now(),
    }));
    var staleTime = new Date(Date.now() - 5 * 60 * 1000);
    fs.utimesSync(staleEditor, staleTime, staleTime);
    fs.utimesSync(spawnLock, staleTime, staleTime);

    var child = cp.spawn(process.execPath, [path.resolve(__dirname, '../bin.js')], {
        env: Object.assign({}, process.env, { HOME: home }),
        stdio: ['pipe', 'pipe', 'pipe'],
    });

    try {
        var id = 82;
        var responsePromise = waitForResponse(child, id);
        child.stdin.write(JSON.stringify({
            jsonrpc: '2.0',
            id: id,
            method: 'initialize',
            params: {},
        }) + '\n');

        var response = await responsePromise;
        assert.equal(response.error, undefined);
        assert.equal(fs.existsSync(staleEditor), false);
        assert.equal(fs.existsSync(spawnLock), true);
    } finally {
        child.kill('SIGTERM');
        await new Promise(function (resolve) { child.once('exit', resolve); });
        fs.rmSync(home, { recursive: true, force: true });
    }
});
