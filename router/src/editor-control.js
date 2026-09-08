'use strict';
// Lifecycle executions share the same project guard as Editor and offline writers.
const fs = require('fs');
const path = require('path');
const os = require('os');
const cp = require('child_process');
const registry = require('../../cli/src/runtime/registry');
const identity = require('../../cli/src/runtime/identity');
const processes = require('../../cli/src/runtime/processes');
const { createClient } = require('../../cli/src/runtime/http-client');
const { executeLifecycle } = require('../../cli/src/runtime/lifecycle');
const { safeFailure } = require('../../cli/src/runtime/operations');
const results = require('../../cli/src/runtime/results');
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const isAlive = identity.alive;
const sanitize = value => String(value || 'unknown').replace(/[^a-zA-Z0-9_-]/g, '_');
const readRegistryEntries = () => registry.readRegistry();
const activeEditors = readRegistryEntries;

function resolveTarget(args, entries = activeEditors()) {
    const projectPath = identity.canonicalProject(args.projectPath);
    if (args.shortName) throw identity.fault('MIGRATION_REQUIRED', 'shortName is a display alias, not lifecycle authority');
    if (args.instanceId) {
        const matches = entries.filter(entry => entry.projectPath === projectPath && entry.instanceId === args.instanceId);
        if (matches.length !== 1) throw identity.fault('TARGET_STALE', 'Exact service generation is unavailable; restart never falls back to spawn');
        const target = matches[0];
        if ((args.pid !== undefined && args.pid !== target.pid) ||
            (args.processIdentity && (args.processIdentity.startId !== target.processIdentity.startId || args.processIdentity.pid !== target.pid))) {
            throw identity.fault('TARGET_CONFLICT', 'Lifecycle selectors identify different processes');
        }
        if (!identity.sameProcess(target.processIdentity)) throw identity.fault('TARGET_STALE', 'Process generation changed');
        return target;
    }
    if (!Number.isSafeInteger(args.pid) || !args.processIdentity || args.processIdentity.pid !== args.pid) throw identity.fault('TARGET_REQUIRED', 'Supply projectPath + instanceId, or projectPath + pid + processIdentity for an unregistered process');
    if (entries.some(entry => entry.pid === args.pid)) throw identity.fault('TARGET_REQUIRED', 'Registered processes require instanceId');
    const matches = processes.forProject(projectPath).filter(entry => entry.pid === args.pid && entry.startId === args.processIdentity.startId);
    if (matches.length !== 1) throw identity.fault('TARGET_STALE', 'Unregistered process identity or project did not match');
    return { projectPath, pid: args.pid, processIdentity: matches[0] };
}
function findEditorProcessByProject(projectPath) {
    const matches = processes.forProject(projectPath);
    if (matches.length > 1) throw identity.fault('TARGET_AMBIGUOUS', 'Multiple Creator processes own the project');
    return matches.length ? matches[0].pid : 0;
}
function uniqExisting(paths) {
    var seen = {};
    var out = [];
    (paths || []).forEach(function (p) {
        if (!p || seen[p]) return;
        seen[p] = true;
        try { if (fs.existsSync(p)) out.push(p); } catch (e) { /* ignore */ }
    });
    return out;
}

function registryExecPathEntries(version) {
    return readRegistryEntries().filter(function (e) {
        if (!e.execPath || !fs.existsSync(e.execPath)) return false;
        if (version && e.editorVersion !== version && e.execPath.indexOf(version) < 0) return false;
        return true;
    });
}

function buildCocosExecPathCandidates(version, platform, env, homeDir) {
    var candidates = [];
    var versions = version ? [version] : [];
    env = env || {};
    homeDir = homeDir || os.homedir();

    if (platform === 'win32') {
        var roots = [];
        if (env.ProgramFiles) roots.push(env.ProgramFiles);
        if (env['ProgramFiles(x86)']) roots.push(env['ProgramFiles(x86)']);
        if (env.LOCALAPPDATA) roots.push(path.win32.join(env.LOCALAPPDATA, 'Programs'));

        roots.forEach(function (root) {
            versions.forEach(function (v) {
                candidates.push(path.win32.join(root, 'Cocos', 'Creator', v, 'CocosCreator.exe'));
                candidates.push(path.win32.join(root, 'CocosCreator_' + v, 'CocosCreator.exe'));
            });
        });

        // Windows 流程验证过的公司内便携安装路径，作为版本化冷启动兜底。
        versions.forEach(function (v) {
            candidates.push(path.win32.join('H:\\', 'cocos', 'editors', 'Creator', v, 'CocosCreator.exe'));
            candidates.push(path.win32.join('D:\\', 'cocos', 'editors', 'Creator', v, 'CocosCreator.exe'));
            candidates.push(path.win32.join('C:\\', 'cocos', 'editors', 'Creator', v, 'CocosCreator.exe'));
        });
    } else if (platform === 'darwin') {
        versions.forEach(function (v) {
            candidates.push('/Applications/Cocos/Creator/' + v + '/CocosCreator.app/Contents/MacOS/CocosCreator');
            candidates.push('/Applications/CocosCreator/Creator/' + v + '/CocosCreator.app/Contents/MacOS/CocosCreator');
            candidates.push('/Applications/CocosCreator_' + v + '.app/Contents/MacOS/CocosCreator');
        });
    } else {
        versions.forEach(function (v) {
            candidates.push('/opt/Cocos/Creator/' + v + '/CocosCreator');
            candidates.push('/opt/cocos/creator/' + v + '/CocosCreator');
            candidates.push(path.posix.join(homeDir, 'Cocos', 'Creator', v, 'CocosCreator'));
        });
    }

    return candidates;
}

function scanCocosExecPaths(version) {
    return uniqExisting(buildCocosExecPathCandidates(version, process.platform, process.env, os.homedir()));
}

/** 从运行中进程的命令行抓可执行路径（编辑器启动命令首段，--project 之前） */
function execPathFromPs(pid) {
    try {
        if (process.platform === 'win32') {
            // TODO[win-verify]: Win 没有 ps。下面用 wmic 拿可执行路径，需在 Win 上实测确认（新版 Win 可能要改 PowerShell Get-CimInstance）
            var winOut = cp.execFileSync('wmic', ['process', 'where', 'processid=' + pid, 'get', 'ExecutablePath', '/value'], { encoding: 'utf-8' });
            var wm = winOut.match(/ExecutablePath=(.+)/);
            return wm ? wm[1].trim() : '';
        }
        // mac / linux: ps 抓命令行首段（--project 之前）
        var out = cp.execFileSync('ps', ['-p', String(pid), '-o', 'command='], { encoding: 'utf-8' }).trim();
        if (!out) return '';
        var idx = out.indexOf(' --');
        return (idx >= 0 ? out.slice(0, idx) : out.split(/\s+/)[0]).trim();
    } catch (e) { return ''; }
}


function resolvePreviewPort(projectPath, pid) {
    try {
        var info = JSON.parse(fs.readFileSync(path.join(projectPath, '.dev', 'dev-reload-info.json'), 'utf-8'));
        if (info && Number.isInteger(info.previewPort) && info.previewPort > 0 && info.previewPort <= 65535 &&
            (pid === undefined || info.editorPid === pid)) return info.previewPort;
    } catch (e) { /* 没装 dev-reload 扩展或文件未生成 */ }
    throw identity.fault('PREVIEW_STATE_UNAVAILABLE', 'Cannot verify the target preview port; inspect the exact Creator before explicitly overriding only the preview-session prompt');
}

/** 数编辑器进程预览端口上的 ESTABLISHED 连接数（0 = 没有调试现场）。 */
function countPreviewConnections(pid, previewPort) {
    try {
        if (process.platform === 'win32') {
            throw identity.fault('PREVIEW_STATE_UNAVAILABLE', 'Preview connection inspection has not been verified on Windows');
        }
        var out = cp.execFileSync('lsof', ['-nP', '-a', '-p', String(pid), '-iTCP:' + previewPort, '-sTCP:ESTABLISHED'], { encoding: 'utf-8' });
        return out.split('\n').filter(function (l) { return l.indexOf('ESTABLISHED') >= 0; }).length;
    } catch (e) {
        // lsof status 1 with no diagnostics means no matches; inability to inspect is not an empty result.
        if (e.status === 1 && !String(e.stderr || '').trim()) return 0;
        throw identity.fault('PREVIEW_STATE_UNAVAILABLE', 'Cannot inspect Creator preview connections: ' + e.message);
    }
}

/** restart/kill 前的现场闸门：有活跃预览连接且没传 force 就抛错。 */
function assertNoDebugSession(action, target, force) {
    if (force) return;
    var port = resolvePreviewPort(target.projectPath, target.pid);
    var n = countPreviewConnections(target.pid, port);
    if (n > 0) {
        throw new Error(
            action + ': 预览端口 ' + port + ' 上有 ' + n + ' 条活跃连接 —— 用户或其他 agent 正开着游戏预览/引导编辑器调试，现在动编辑器会打断现场。\n' +
            '请先与用户确认；确认后重试并显式传 force:true。'
        );
    }
}

/**
 * 解析编辑器可执行路径，两级 fallback：
 *   1. 注册文件 execPath 字段（main.js 写入，最准）
 *   2. 从活进程命令行抓（编辑器还活着时）—— restart 会在 kill 前调用，此时旧进程还在
 * 全部失败抛错。
 */
function resolveExecPath(entry) {
    if (entry.execPath && fs.existsSync(entry.execPath)) return entry.execPath;

    if (entry.pid && isAlive(entry.pid)) {
        var fromPs = execPathFromPs(entry.pid);
        if (fromPs && fs.existsSync(fromPs)) return fromPs;
    }

    throw new Error(
        'editor-control: 无法解析 Cocos 编辑器可执行路径。\n' +
        '  注册文件 execPath: ' + (entry.execPath || '(无)') + '\n' +
        '  editorVersion: ' + (entry.editorVersion || '(无)') + '\n' +
        '请重启编辑器让扩展写入 execPath 字段，或用 editor_spawn 显式传 execPath。'
    );
}


function resolveExecPathForSpawn(args, projectPath) {
    if (args.execPath && fs.existsSync(args.execPath)) return args.execPath;

    var version = args.version || '';
    if (version) {
        var sameVersion = registryExecPathEntries(version)[0];
        if (sameVersion) return sameVersion.execPath;

        var scanned = scanCocosExecPaths(version)[0];
        if (scanned) return scanned;

        throw new Error('editor_spawn: 找不到 Cocos Creator ' + version + '。请传 execPath，或先用该版本打开任意项目让扩展写入注册表。');
    }

    var borrowed = registryExecPathEntries('');
    if (borrowed.length === 1) return borrowed[0].execPath;
    if (borrowed.length > 1) {
        throw new Error('editor_spawn: 检测到多个 Cocos Creator 安装路径，请传 version 或 execPath 明确指定。可用版本: ' +
            borrowed.map(function (e) { return (e.editorVersion || '?') + '=' + e.execPath; }).join(', '));
    }

    throw new Error('editor_spawn: 无法解析 Cocos 可执行路径。请传 version 或 execPath。');
}


function buildEditorSpawnArgs(projectPath, opts) {
    opts = opts || {};
    var args = ['--project', projectPath];
    if (opts.noLogin !== false) args.push('--nologin');
    return args;
}


async function killEditor(target, opts = {}) {
    function stillSame() { return identity.sameProcess(target.processIdentity); }
    async function waitStopped(timeout) {
        const deadline = Date.now() + timeout;
        do {
            try { if (!stillSame()) return true; }
            catch (error) { if (error.code !== 'PROCESS_IDENTITY_UNAVAILABLE') throw error; }
            // A terminating child can be a zombie until Node reaps it. Unknown identity is not stop evidence.
            await sleep(100);
        } while (Date.now() < deadline);
        return false;
    }
    if (!stillSame()) throw safeFailure(identity.fault('TARGET_STALE', 'Process exited or PID was reused before signalling'));
    const signal = opts.hard ? 'SIGKILL' : 'SIGTERM';
    process.kill(target.pid, signal);
    let stopped = await waitStopped(opts.graceMs || 6000);
    let escalated = false;
    if (!stopped && stillSame()) { escalated = true; process.kill(target.pid, 'SIGKILL'); stopped = await waitStopped(3000); }
    if (!stopped) throw identity.fault('EXECUTION_NOT_STOPPED', 'The exact Creator process has not stopped');
    // Only the service itself removes its own generation file. Stale discovery records retain diagnostic evidence.
    return { killed: true, pid: target.pid, processIdentity: target.processIdentity, signal, escalatedToSigkill: escalated };
}
async function spawnEditor(execPath, projectPath, opts) {
    const child = cp.spawn(execPath, buildEditorSpawnArgs(projectPath, opts), { detached: true, stdio: 'ignore' });
    await new Promise((resolve, reject) => { child.once('spawn', resolve); child.once('error', reject); });
    child.unref();
    return child.pid;
}
const { probeReady, probeProjectReady, hasReadyAssetResult, waitReady } = require('../../cli/src/runtime/readiness');
const targetProperties = {
    projectPath: { type: 'string' }, instanceId: { type: 'string' }, pid: { type: 'integer', minimum: 1 },
    processIdentity: { type: 'object', additionalProperties: false, required: ['pid', 'startId'], properties: { pid: { type: 'integer', minimum: 1 }, startId: { type: 'string' } } },
};
const EDITOR_TOOLS = [
    { name: 'editor_spawn', description: 'Cold start only. Requires a closed project, an operationId, and the shared execution guard.', properties: {
        projectPath: targetProperties.projectPath, version: { type: 'string' }, execPath: { type: 'string' }, noLogin: { type: 'boolean', default: true }, timeoutMs: { type: 'number', minimum: 1 },
    } },
    { name: 'editor_restart', description: 'Restart one exact process/service generation. No cold-start fallback. Timeout is not cancellation.', properties: {
        ...targetProperties, hard: { type: 'boolean' }, noLogin: { type: 'boolean', default: true }, timeoutMs: { type: 'number', minimum: 1 },
        force: { type: 'boolean', description: 'Only bypasses the existing preview-session prompt; never identity, locks, unknown or transaction protection.' },
    } },
    { name: 'editor_kill', description: 'Close one exact Creator process. Cannot override project freeze or lock ownership.', properties: {
        ...targetProperties, hard: { type: 'boolean' }, graceMs: { type: 'number', minimum: 1 },
        force: { type: 'boolean', description: 'Only the preview-session prompt, never execution protection.' },
    } },
    { name: 'editor_wait_ready', description: 'Authenticated readiness of an explicitly specified project/generation. Does not resolve unknown operations.', properties: {
        projectPath: targetProperties.projectPath, instanceId: targetProperties.instanceId, timeoutMs: { type: 'number', minimum: 1 }, excludeInstanceId: { type: 'string' },
    } },
].map(tool => {
    const query = tool.name === 'editor_wait_ready';
    return { name: tool.name, description: tool.description, annotations: { readOnlyHint: query }, inputSchema: {
        type: 'object', additionalProperties: false, required: query ? ['projectPath'] : ['projectPath', 'operationId'],
        properties: { ...tool.properties, ...(!query ? { operationId: { type: 'string', minLength: 1, maxLength: 128 } } : {}) },
    } };
});
const isEditorTool = name => EDITOR_TOOLS.some(tool => tool.name === name);
async function handleEditorToolCall(name, args, context = {}) {
    if (name === 'editor_wait_ready') return results.normalize({ action: 'wait_ready', projectPath: identity.canonicalProject(args.projectPath), result: await waitReady(args.projectPath, args) });
    if (!isEditorTool(name)) throw identity.fault('UNKNOWN_TOOL', 'Unknown lifecycle tool');
    const projectPath = identity.canonicalProject(args.projectPath);
    let target;
    const record = await executeLifecycle(name, { ...args, projectPath }, { store: context.store,
        assertTarget: () => {
            if (name !== 'editor_spawn') target = resolveTarget(args);
            else processes.assertClosed(projectPath);
        },
    }, async entry => {
        let executable;
        try {
            if (target) { assertNoDebugSession(name, target, args.force); if (name === 'editor_restart') executable = resolveExecPath(target); }
            else executable = resolveExecPathForSpawn(args, projectPath);
        } catch (error) { throw safeFailure(error); }
        const killed = target ? await killEditor(target, args) : null;
        if (name === 'editor_kill') return { action: 'kill', projectPath, result: killed };
        processes.assertClosed(projectPath);
        const pid = await spawnEditor(executable, projectPath, args);
        const owner = entry.child(pid);
        const ready = await waitReady(projectPath, { timeoutMs: args.timeoutMs, processIdentity: owner, excludeInstanceId: target && target.instanceId });
        if (!ready.ready) throw identity.fault('OPERATION_UNKNOWN', ready.reason);
        return { action: name === 'editor_spawn' ? 'spawn' : 'restart', projectPath, execPath: executable,
            launchedPid: pid, spawnArgs: buildEditorSpawnArgs(projectPath, args), kill: killed, ready };
    });
    return results.fromRecord(record);
}
module.exports = { EDITOR_TOOLS, isEditorTool, handleEditorToolCall, resolveTarget, readRegistryEntries, activeEditors,
    killEditor,
    resolveExecPath, resolveExecPathForSpawn, buildCocosExecPathCandidates, buildEditorSpawnArgs, findEditorProcessByProject,
    resolvePreviewPort, countPreviewConnections, assertNoDebugSession, waitReady, probeReady, probeProjectReady, hasReadyAssetResult, isAlive };
