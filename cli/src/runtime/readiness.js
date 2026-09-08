'use strict';
const identity = require('./identity');
const registry = require('./registry');
const processes = require('./processes');
const { createClient } = require('./http-client');
const activeEditors = registry.readRegistry;
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function probeReady(entry) {
    try {
        const client = createClient(entry);
        await client.initialize();
        const response = await client.request('tools/call', { name: 'local_get_status', arguments: { _target: client.target } });
        if (!response.result || response.result.isError) return false;
        const status = response.result.structuredContent || JSON.parse(response.result.content[0].text);
        return status.instanceId === entry.instanceId && status.projectPath === entry.projectPath &&
            status.processIdentity.pid === entry.pid && status.processIdentity.startId === entry.processIdentity.startId;
    } catch (_) { return false; }
}
async function probeProjectReady(entry) {
    try {
        const client = createClient(entry);
        return hasReadyAssetResult(await client.request('tools/call', { name: 'asset_query_assets', arguments: { pattern: 'db://assets/*', _target: client.target } }));
    } catch (_) { return false; }
}
function hasReadyAssetResult(r) {
    if (!r || r.error || !r.result || r.result.isError) return false;

    var content = r.result.content;
    if (Array.isArray(content)) {
        if (content.length === 0) return false;
        if (content[0] && content[0].type === 'text') {
            return hasReadyAssetText(content[0].text);
        }
        return true;
    }

    if (Array.isArray(r.result)) return true;
    return false;
}

function hasReadyAssetText(txt) {
    if (!txt) return false;
    try {
        var parsed = JSON.parse(txt);
        if (Array.isArray(parsed)) return true;
        if (parsed && Array.isArray(parsed.assets)) return true;
        if (parsed && Array.isArray(parsed.content)) return parsed.content.length > 0;
    } catch (e) {
        return false;
    }
    return false;
}


async function waitReady(projectPath, opts = {}) {
    projectPath = identity.canonicalProject(projectPath);
    const start = Date.now();
    const timeoutMs = opts.timeoutMs || 90000;
    const unready = { ready: false, processReady: false, registryReady: false, mcpReady: false, assetDbReady: false, projectReady: false, runtimeHealth: 'not_checked' };
    let state = { ...unready };
    let lastIdentityError;
    while (Date.now() - start < timeoutMs) {
        state = { ...unready };
        try {
            const entries = (opts.readRegistry || activeEditors)().filter(entry => entry.projectPath === projectPath &&
                (!opts.instanceId || entry.instanceId === opts.instanceId) && entry.instanceId !== opts.excludeInstanceId &&
                (!opts.processIdentity || (entry.pid === opts.processIdentity.pid && entry.processIdentity.startId === opts.processIdentity.startId)));
            if (entries.length > 1) throw identity.fault('TARGET_AMBIGUOUS', 'Multiple service generations match; bind an instanceId');
            const entry = entries[0];
            if (entry) {
                state.processReady = state.registryReady = true;
                if (await probeReady(entry)) {
                    state.mcpReady = true;
                    if (await probeProjectReady(entry)) return { ...state, ready: true, assetDbReady: true, projectReady: true, entry: registry.publicEntry(entry), waitedMs: Date.now() - start };
                }
            } else if (processes.forProject(projectPath).length) state.processReady = true;
            lastIdentityError = null;
        } catch (error) {
            if (error.code !== 'PROCESS_IDENTITY_UNAVAILABLE') throw error;
            // Retry only observation inside this wait. Never relaunch, infer exit, or release an execution lock.
            lastIdentityError = error;
        }
        await sleep(Math.min(500, Math.max(1, timeoutMs - (Date.now() - start))));
    }
    return { ...state, waitedMs: Date.now() - start, reason: 'Readiness not confirmed. Query the original operation; timeout does not cancel Creator.' +
        (lastIdentityError ? ' Last observation: ' + lastIdentityError.code + ': ' + lastIdentityError.message : '') };
}

module.exports = { probeReady, probeProjectReady, hasReadyAssetResult, waitReady };
