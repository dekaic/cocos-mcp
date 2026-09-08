'use strict';
const fs = require('fs');
const path = require('path');
const { AsyncLocalStorage } = require('async_hooks');
const { canonicalProject, contained, hash, fault } = require('./identity');
const scope = new AsyncLocalStorage();

function readDisk(filename) {
    try {
        const stat = fs.lstatSync(filename);
        if (!stat.isFile() || stat.isSymbolicLink()) throw fault('UNSAFE_RESOURCE_PATH', 'Expected a regular resource: ' + filename);
        const bytes = fs.readFileSync(filename);
        return { bytes, hash: hash(bytes), mode: stat.mode & 0o777 };
    } catch (e) { if (e.code === 'ENOENT') return { bytes: null, hash: null, mode: 0o644 }; throw e; }
}
function createPlan(projectPath) {
    const root = canonicalProject(projectPath);
    const baseline = new Map();
    const staged = new Map();
    function filename(file) { return contained(root, path.isAbsolute(file) ? file : path.resolve(root, file)); }
    function original(file) {
        const absolute = filename(file);
        if (!baseline.has(absolute)) baseline.set(absolute, readDisk(absolute));
        return baseline.get(absolute);
    }
    function read(file, encoding = 'utf8') {
        const absolute = filename(file);
        const before = original(absolute);
        const bytes = staged.has(absolute) ? staged.get(absolute).bytes : before.bytes;
        if (bytes === null) throw Object.assign(new Error('Missing resource: ' + absolute), { code: 'ENOENT' });
        return encoding ? bytes.toString(encoding) : Buffer.from(bytes);
    }
    function exists(file) { try { read(file, null); return true; } catch (e) { if (e.code === 'ENOENT') return false; throw e; } }
    function write(file, data, options = {}) {
        const absolute = filename(file);
        const before = original(absolute);
        if (options.create && before.bytes !== null) throw fault('RESOURCE_EXISTS', 'Refusing to overwrite existing resource: ' + absolute);
        if (!fs.statSync(path.dirname(absolute)).isDirectory()) throw fault('INVALID_PATH', 'Resource parent directory must exist');
        staged.set(absolute, { bytes: Buffer.isBuffer(data) ? Buffer.from(data) : Buffer.from(data, 'utf8'), create: !!options.create });
    }
    function changes() {
        return [...staged].filter(([file, after]) => hash(after.bytes) !== original(file).hash)
            .map(([file, after]) => ({ file, before: original(file), after: after.bytes }));
    }
    function verifyBaseline() {
        for (const [file, before] of baseline) {
            if (filename(file) !== file || readDisk(file).hash !== before.hash) throw fault('BASELINE_CONFLICT', 'Resource or dependency changed during planning: ' + file);
        }
    }
    return { root, baseline, staged, read, exists, write, filename, changes, verifyBaseline,
        run: fn => scope.run({ read, exists, write, root }, fn) };
}
function readFile(file, encoding = 'utf8') { const plan = scope.getStore(); return plan ? plan.read(file, encoding) : fs.readFileSync(file, encoding); }
function existsFile(file) { const plan = scope.getStore(); return plan ? plan.exists(file) : fs.existsSync(file); }
function listFiles(roots, predicate) {
    const out = [];
    function visit(directory) {
        if (!fs.existsSync(directory)) return;
        for (const entry of fs.readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
            const file = path.join(directory, entry.name);
            if (entry.isDirectory() && !['.git', 'node_modules'].includes(entry.name)) visit(file);
            else if (entry.isFile() && predicate(file)) out.push(file);
        }
    }
    roots.forEach(visit);
    return out;
}
module.exports = { createPlan, readDisk, readFile, existsFile, listFiles, currentPlan: () => scope.getStore() };
