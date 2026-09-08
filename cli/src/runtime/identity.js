'use strict';
const fs = require('fs');
const path = require('path');
const cp = require('child_process');
const crypto = require('crypto');

function fault(code, message, details) { return Object.assign(new Error(message), { code, details }); }
function hash(value) { return crypto.createHash('sha256').update(value).digest('hex'); }
function stable(value) {
    if (Array.isArray(value)) return value.map(stable);
    if (!value || typeof value !== 'object') return value;
    return Object.fromEntries(Object.keys(value).sort().map(key => [key, stable(value[key])]));
}
function canonicalProject(projectPath) {
    if (typeof projectPath !== 'string' || !path.isAbsolute(projectPath)) throw fault('INVALID_PROJECT', 'An absolute project path is required');
    const real = fs.realpathSync(projectPath);
    if (!fs.statSync(path.join(real, 'assets')).isDirectory() || !fs.existsSync(path.join(real, 'package.json'))) {
        throw fault('INVALID_PROJECT', 'Not a Cocos project: ' + real);
    }
    return real;
}
function projectForFile(filename, explicitRoot) {
    if (!path.isAbsolute(filename)) throw fault('INVALID_PATH', 'An absolute resource path is required');
    let directory = path.dirname(filename);
    while (!fs.existsSync(directory)) {
        const parent = path.dirname(directory);
        if (parent === directory) throw fault('INVALID_PROJECT', 'Cannot locate project for ' + filename);
        directory = parent;
    }
    directory = fs.realpathSync(directory);
    if (explicitRoot) { const root = canonicalProject(explicitRoot); contained(root, filename); return root; }
    while (true) {
        if (fs.existsSync(path.join(directory, 'assets')) && fs.existsSync(path.join(directory, 'package.json'))) return canonicalProject(directory);
        const parent = path.dirname(directory);
        if (parent === directory) throw fault('INVALID_PROJECT', 'Cannot infer a Cocos project; supply projectRoot');
        directory = parent;
    }
}
function contained(root, filename) {
    const absolute = path.resolve(filename);
    let existing = absolute;
    const tail = [];
    while (!fs.existsSync(existing)) { tail.unshift(path.basename(existing)); existing = path.dirname(existing); }
    const real = path.join(fs.realpathSync(existing), ...tail);
    const relative = path.relative(root, real);
    if (relative === '..' || relative.startsWith('..' + path.sep) || path.isAbsolute(relative)) throw fault('PATH_OUTSIDE_PROJECT', 'Resource escapes project: ' + filename);
    return real;
}
function alive(pid) {
    if (!Number.isSafeInteger(pid) || pid < 1) return false;
    try { process.kill(pid, 0); return true; } catch (error) { return error.code !== 'ESRCH'; }
}
let selfIdentity;
function processIdentity(pid = process.pid) {
    if (!Number.isSafeInteger(pid) || pid < 1) throw fault('PROCESS_IDENTITY_UNAVAILABLE', 'Invalid process ID');
    if (pid === process.pid && selfIdentity) return { ...selfIdentity };
    if (!alive(pid)) return null;
    try {
        let start;
        if (process.platform === 'linux') {
            const stat = fs.readFileSync('/proc/' + pid + '/stat', 'utf8');
            const fields = stat.slice(stat.lastIndexOf(')') + 2).trim().split(/\s+/);
            start = fs.readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim() + ':' + fields[19];
        } else if (process.platform === 'darwin') {
            const raw = cp.execFileSync('/usr/bin/osascript', ['-l', 'JavaScript', path.join(__dirname, 'macos-process.js'), String(pid)],
                { encoding: 'utf8', timeout: 4000, stdio: ['ignore', 'pipe', 'ignore'] });
            const info = Buffer.from(raw.trim(), 'base64');
            if (info.length !== 136 || info.readUInt32LE(12) !== pid) throw new Error('Invalid BSD process identity');
            start = info.readBigUInt64LE(120).toString() + ':' + info.readBigUInt64LE(128).toString();
        } else if (process.platform === 'win32') {
            start = cp.execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
                '(Get-CimInstance Win32_Process -Filter "ProcessId = ' + pid + '").CreationDate.ToUniversalTime().Ticks'],
            { encoding: 'utf8', timeout: 4000, stdio: ['ignore', 'pipe', 'ignore'] }).trim();
        }
        if (!start) throw new Error('empty process start identity');
        const owner = { pid, startId: process.platform + ':' + start };
        if (pid === process.pid) selfIdentity = owner;
        return { ...owner };
    } catch (error) {
        if (!alive(pid)) return null;
        // Retain diagnostic codes, never subprocess output, arguments or environment.
        const code = /^[A-Z0-9_]{1,64}$/.test(error.code || '') ? error.code : 'IDENTITY_SAMPLE_FAILED';
        const details = { pid, platform: process.platform, code,
            status: Number.isInteger(error.status) ? error.status : null,
            signal: /^SIG[A-Z0-9]{1,16}$/.test(error.signal || '') ? error.signal : null };
        throw fault('PROCESS_IDENTITY_UNAVAILABLE', 'Cannot verify process start identity for PID ' + pid + ' (' + code + ')', details);
    }
}
function sameProcess(owner) {
    if (!owner || !owner.startId) throw fault('PROCESS_IDENTITY_UNAVAILABLE', 'Missing process start identity');
    const current = processIdentity(owner.pid);
    return !!current && current.startId === owner.startId;
}

module.exports = { fault, hash, stable, canonicalProject, projectForFile, contained, alive, processIdentity, sameProcess };
