'use strict';
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const identity = require('./identity');
const storage = require('./storage');
const REGISTRY_DIR = path.join(os.homedir(), '.cocos-mcp', 'editors');
function registrationName(owner, instanceId) { return identity.hash(JSON.stringify(owner)).slice(0, 24) + '-' + instanceId + '.json'; }

function createRegistration(projectPath, directory = REGISTRY_DIR) {
    projectPath = identity.canonicalProject(projectPath);
    const owner = identity.processIdentity();
    const instanceId = crypto.randomUUID();
    const token = crypto.randomBytes(32).toString('hex');
    storage.directory(directory);
    const filename = path.join(directory, registrationName(owner, instanceId));
    let removed = false;
    return { instanceId, projectPath, owner, token,
        publish(info) {
            if (removed) throw identity.fault('TARGET_STALE', 'Service registration is closed');
            const { host, port, ...metadata } = info;
            if (host !== '127.0.0.1' || !Number.isInteger(port) || port < 1 || port > 65535) throw identity.fault('INVALID_ENDPOINT', 'A numeric loopback endpoint is required');
            storage.publish(filename, { ...metadata, schemaVersion: 1, projectPath, instanceId, pid: owner.pid,
                processIdentity: owner, updatedAt: new Date().toISOString(),
                transport: { url: 'http://' + host + ':' + port + '/mcp', bearerToken: token } }, true);
        },
        remove() { removed = true; if (fs.existsSync(filename)) storage.remove(filename); },
    };
}
function validateEntry(entry) {
    if (!entry || entry.schemaVersion !== 1 || !entry.instanceId || !entry.processIdentity || entry.pid !== entry.processIdentity.pid) return false;
    if (identity.canonicalProject(entry.projectPath) !== entry.projectPath || !identity.sameProcess(entry.processIdentity)) return false;
    const endpoint = new URL(entry.transport.url);
    return endpoint.protocol === 'http:' && endpoint.hostname === '127.0.0.1' && !!endpoint.port && endpoint.pathname === '/mcp' &&
        !endpoint.search && !endpoint.hash && !endpoint.username && !endpoint.password && /^[a-f0-9]{64}$/.test(entry.transport.bearerToken);
}
function readRegistry(directory = REGISTRY_DIR) {
    if (!fs.existsSync(directory)) return [];
    storage.privatePath(directory, true);
    const entries = [];
    entries.diagnostics = [];
    for (const name of fs.readdirSync(directory).filter(name => name.endsWith('.json')).sort()) {
        try {
            const entry = storage.read(path.join(directory, name));
            if (validateEntry(entry) && name === registrationName(entry.processIdentity, entry.instanceId)) entries.push(entry);
            else entries.diagnostics.push({ file: name, code: entry && entry.schemaVersion === 1 ? 'REGISTRATION_STALE' : 'CLIENT_MIGRATION_REQUIRED' });
        } catch (error) {
            entries.diagnostics.push({ file: name, code: error.code || 'REGISTRATION_INVALID' });
            // Discovery preserves legacy/corrupt records and never grants them authority.
        }
    }
    return entries;
}
function publicEntry(entry) {
    return Object.fromEntries(Object.entries(entry).filter(([key]) => !['transport', 'token', 'bearerToken', 'client'].includes(key)));
}
function assertTarget(target, entry) {
    if (entry.active === false) throw identity.fault('TARGET_STALE', 'This service generation has stopped');
    if (!target || typeof target.instanceId !== 'string' || typeof target.projectPath !== 'string') throw identity.fault('TARGET_REQUIRED', '_target requires projectPath and instanceId');
    if (identity.canonicalProject(target.projectPath) !== entry.projectPath || target.instanceId !== entry.instanceId) throw identity.fault('TARGET_STALE', 'Target does not identify this service generation');
}
module.exports = { REGISTRY_DIR, createRegistration, readRegistry, validateEntry, publicEntry, assertTarget };
