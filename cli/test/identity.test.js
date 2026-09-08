'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const cp = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const identity = require('../src/runtime/identity');

test('macOS process sampling preserves bounded failure diagnostics without subprocess output', { skip: process.platform !== 'darwin' }, t => {
    let calls = 0;
    t.mock.method(cp, 'execFileSync', (command, args, options) => {
        calls++;
        assert.equal(command, '/usr/bin/osascript');
        assert.equal(args.at(-1), String(process.ppid));
        assert.equal(options.timeout, 4000);
        throw Object.assign(new Error('untrusted subprocess output'), { code: 'ETIMEDOUT', status: null, signal: 'SIGTERM', stderr: 'private-output' });
    });
    assert.throws(() => identity.processIdentity(process.ppid), error => {
        assert.equal(error.code, 'PROCESS_IDENTITY_UNAVAILABLE');
        assert.match(error.message, /ETIMEDOUT/);
        assert.deepEqual(error.details, { pid: process.ppid, platform: 'darwin', code: 'ETIMEDOUT', status: null, signal: 'SIGTERM' });
        assert.doesNotMatch(JSON.stringify(error) + error.message, /private-output|untrusted subprocess output/);
        return true;
    });
    assert.equal(calls, 1, 'identity authority does not retry or fall back to PID-only');
});

test('a failed sample is not exit evidence; only an ESRCH recheck proves exit', { skip: process.platform !== 'darwin' }, t => {
    let checks = 0;
    t.mock.method(process, 'kill', (pid, signal) => {
        assert.equal(pid, process.ppid);
        assert.equal(signal, 0);
        if (++checks === 2) throw Object.assign(new Error('exited'), { code: 'ESRCH' });
    });
    t.mock.method(cp, 'execFileSync', () => { throw Object.assign(new Error('timeout'), { code: 'ETIMEDOUT' }); });
    assert.equal(identity.processIdentity(process.ppid), null);
    assert.equal(checks, 2);
});

test('offline admission still rejects an unreadable live Creator identity immediately', { skip: process.platform !== 'darwin' }, t => {
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cocos-identity-test-')));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    fs.mkdirSync(path.join(root, 'assets'));
    fs.writeFileSync(path.join(root, 'package.json'), '{}');
    const executable = path.join(root, 'CocosCreator');
    fs.writeFileSync(executable, 'synthetic process inventory fixture');
    let samples = 0;
    t.mock.method(cp, 'execFileSync', command => {
        if (command === '/bin/ps') return process.ppid + ' ' + executable + ' --project ' + root + '\n';
        assert.equal(command, '/usr/bin/osascript');
        samples++;
        throw Object.assign(new Error('timeout'), { code: 'ETIMEDOUT' });
    });
    assert.throws(() => require('../src/runtime/processes').assertClosed(root), { code: 'PROCESS_IDENTITY_UNAVAILABLE' });
    assert.equal(samples, 1);
});
