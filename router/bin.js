#!/usr/bin/env node
'use strict';

// The stdio Router observes and forwards. Actual executors own project execution locks.
var fs = require('fs');
var path = require('path');
var crypto = require('crypto');
var cp = require('child_process');
var registry = require('../cli/src/runtime/registry');
var identity = require('../cli/src/runtime/identity');
var createClient = require('../cli/src/runtime/http-client').createClient;
var createStore = require('../cli/src/runtime/operations').createStore;
var classify = require('../cli/src/runtime/effects').classify;
var results = require('../cli/src/runtime/results');
var offlineTools = require('./src/offline-tools.js');
var editorControl = require('./src/editor-control.js');
var ROUTER_INFO = { name: 'cocos-mcp-router', version: '2.1.0' };
var PROTOCOL_VERSION = '2025-06-18';

function sanitize(name) { return String(name || 'unknown').replace(/[^a-zA-Z0-9_-]/g, '_'); }
function assignAliases(entries) {
    var counts = new Map();
    entries.forEach(function (entry) { var base = sanitize(entry.projectShortName); counts.set(base, (counts.get(base) || 0) + 1); });
    var used = new Set();
    return entries.slice().sort(function (a, b) { return a.instanceId.localeCompare(b.instanceId); }).map(function (entry) {
        var base = sanitize(entry.projectShortName);
        var candidate = counts.get(base) === 1 ? base : base + '-' + sanitize(path.basename(entry.projectPath));
        var suffix = 1;
        var alias = candidate;
        while (used.has(alias)) alias = candidate + '-' + (++suffix);
        used.add(alias);
        return Object.assign({}, entry, { shortName: alias });
    });
}
function validateArguments(tool, args) {
    var error = require('../mcp-sdk/protocol/dispatcher').validateArguments(tool.inputSchema, args);
    if (error) throw identity.fault('INVALID_ARGUMENTS', '[' + tool.name + '] ' + error);
}
function routerIdentity() {
    var root = fs.realpathSync(path.resolve(__dirname, '..'));
    var digest = crypto.createHash('sha256');
    function visit(filename, relative) {
        if (fs.statSync(filename).isDirectory()) {
            if (['test', 'node_modules', '.git'].includes(path.basename(filename))) return;
            fs.readdirSync(filename).sort().forEach(function (name) { visit(path.join(filename, name), relative + '/' + name); });
        } else if (/\.(js|json)$/.test(filename)) digest.update(relative).update('\0').update(fs.readFileSync(filename)).update('\0');
    }
    ['router', 'cli/src', 'cli/bin', 'mcp-sdk'].forEach(function (entry) { visit(path.join(root, entry), entry); });
    function git(args) { try { return cp.execFileSync('git', ['-C', root].concat(args), { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim(); } catch (_) { return ''; } }
    return { sourceRealPath: root, sourceGitHead: git(['rev-parse', 'HEAD']), sourceDirty: !!git(['status', '--porcelain']),
        runtimeBuildId: digest.digest('hex'), loadedAt: new Date().toISOString() };
}

function createRouter(options) {
    options = options || {};
    var store = options.store || createStore();
    var editors = new Map();
    var toolMap = new Map();
    var discovery;
    var discoveryDiagnostics = [];
    var initialized = false;
    var runtime = routerIdentity();
    var notify = options.notify || function () {};
    var readRegistry = options.readRegistry || registry.readRegistry;
    var makeClient = options.createClient || createClient;

    function tools() {
        var list = [];
        toolMap = new Map();
        for (var editor of editors.values()) {
            editor.tools.forEach(function (tool) {
                var name = editor.shortName + '__' + tool.name;
                if (toolMap.has(name)) throw identity.fault('TOOL_NAME_CONFLICT', 'Ambiguous tool name: ' + name);
                toolMap.set(name, { editor, tool });
                list.push(Object.assign({}, tool, { name, description: '[' + editor.shortName + '] ' + (tool.description || ''),
                    _meta: { ...(tool._meta || {}), cocosMcp: { ...(tool._meta && tool._meta.cocosMcp),
                        underlyingTool: tool.name, target: { projectPath: editor.projectPath, instanceId: editor.instanceId } } } }));
            });
        }
        return list.concat([
            { name: 'router_list_editors', description: 'List authenticated service generations and runtime identities; never includes credentials.',
                inputSchema: { type: 'object', properties: {}, additionalProperties: false } },
            { name: 'operation_status', description: 'Query a durable operation; without operationId list unresolved operations.',
                inputSchema: { type: 'object', additionalProperties: false, required: ['projectPath'],
                    properties: { projectPath: { type: 'string' }, operationId: { type: 'string' } } } },
            { name: 'operation_reconcile', description: 'Record caller disposition only after machine-verifiable execution stop. Does not roll back resources.',
                inputSchema: { type: 'object', additionalProperties: false, required: ['projectPath', 'operationId', 'outcome', 'evidence'],
                    properties: { projectPath: { type: 'string' }, operationId: { type: 'string' },
                        outcome: { type: 'string', enum: ['accept_current_state', 'confirm_no_effect'] }, evidence: { type: 'string' } } } },
        ], offlineTools.OFFLINE_TOOLS, editorControl.EDITOR_TOOLS);
    }
    function signature() { return identity.hash(JSON.stringify(identity.stable(tools()))); }
    function discover() {
        if (discovery) return discovery;
        discovery = (async function () {
            var before = signature();
            var entries = await readRegistry();
            discoveryDiagnostics = entries.diagnostics || [];
            var next = [];
            await Promise.all(entries.map(async function (entry) {
                try {
                    var client = makeClient(entry);
                    await client.initialize();
                    var status = await client.request('tools/call', { name: 'local_get_status', arguments: { _target: client.target } });
                    if (status.error || !status.result || status.result.isError) return;
                    var value = status.result.structuredContent || JSON.parse(status.result.content[0].text);
                    if (value.instanceId !== entry.instanceId || value.projectPath !== entry.projectPath ||
                        !value.processIdentity || value.processIdentity.startId !== entry.processIdentity.startId ||
                        value.processIdentity.pid !== entry.pid) return;
                    var toolResponse = await client.request('tools/list');
                    var resourceResponse = await client.request('resources/list');
                    if (toolResponse.error || resourceResponse.error) return;
                    next.push(Object.assign({}, entry, { client, tools: toolResponse.result.tools || [], resources: resourceResponse.result.resources || [] }));
                } catch (_) {
                    // No endpoint-based cache fallback: a new generation never inherits an old generation's authority.
                }
            }));
            editors = new Map(assignAliases(next).map(function (entry) { return [entry.instanceId, entry]; }));
            var after = signature();
            runtime.toolSchemaHash = after;
            if (initialized && before !== after) notify({ jsonrpc: '2.0', method: 'notifications/tools/list_changed' });
        })().finally(function () { discovery = null; });
        return discovery;
    }
    function logicalRequest(tool, args, editor) {
        var { _target, operationId, ...business } = args;
        return { projectPath: _target.projectPath, operationId, target: _target, tool, args: business,
            expectedExecutor: editor && editor.processIdentity };
    }
    async function call(name, args) {
        try {
            var known = tools().find(function (tool) { return tool.name === name; });
            if (known && !name.includes('__')) validateArguments(known, args);
            if (name === 'router_list_editors') {
                await discover();
                return Object.assign(results.normalize(Array.from(editors.values()).map(function (editor) {
                    var value = registry.publicEntry(editor);
                    delete value.tools; delete value.resources;
                    return Object.assign(value, { toolCount: editor.tools.length });
                })), { ...(discoveryDiagnostics.length ? { structuredContent: { discoveryDiagnostics } } : {}),
                    _meta: { cocosMcp: { routerRuntime: runtime } } });
            }
            if (name === 'operation_status') {
                var records = store.status(args.projectPath, args.operationId);
                return results.normalize(Array.isArray(records) ? records.filter(function (record) { return record.unresolved; }) : records);
            }
            if (name === 'operation_reconcile') return results.normalize(store.reconcile(args.projectPath, args.operationId, args.outcome, args.evidence));
            if (offlineTools.isOfflineTool(name)) return await offlineTools.handleOfflineToolCall(name, args, { store });
            if (editorControl.isEditorTool(name)) return await editorControl.handleEditorToolCall(name, args, { store });

            // Retry lookup precedes liveness and current alias resolution. It cannot grant execution.
            if (args.operationId && args._target) {
                var previous;
                try { previous = store.status(args._target.projectPath, args.operationId); }
                catch (error) { if (error.code !== 'OPERATION_NOT_FOUND') throw error; }
                if (previous) {
                    if (!name.endsWith('__' + previous.tool)) throw identity.fault('OPERATION_ID_CONFLICT', 'operationId belongs to another tool');
                    store.reserve(logicalRequest(previous.tool, args));
                    return results.fromRecord(previous);
                }
            }
            var hit = toolMap.get(name);
            if (!hit) { await discover(); hit = toolMap.get(name); }
            if (!hit) throw identity.fault('TARGET_STALE', 'Tool or service generation is unavailable; refresh editor discovery');
            validateArguments(hit.tool, args);
            registry.assertTarget(args._target, hit.editor);
            if (classify(hit.tool.name, args) === 'query') {
                var read = await hit.editor.client.request('tools/call', { name: hit.tool.name, arguments: args });
                if (read.error) throw identity.fault('EDITOR_REJECTED', read.error.message);
                return read.result;
            }
            var input = logicalRequest(hit.tool.name, args, hit.editor);
            var reservation = store.reserve(input);
            if (!reservation.created) return results.fromRecord(store.status(input.projectPath, input.operationId));
            store.observe(input, 'dispatched');
            try {
                var response = await hit.editor.client.request('tools/call', { name: hit.tool.name, arguments: args,
                    _meta: { cocosMcp: { submissionId: reservation.request.submissionId } } });
                if (response.error) throw identity.fault('EDITOR_REJECTED', response.error.message);
                return response.result;
            } catch (error) {
                store.observe(input, 'transport_unknown', { code: error.code || 'DISCONNECTED' });
                return results.fromRecord(store.status(input.projectPath, input.operationId));
            }
        } catch (error) { return error.operation ? results.fromRecord(error.operation) : results.fromError(error, { operationId: args && args.operationId,
            originalTarget: args && args._target, projectPath: args && (args.projectPath || args.projectRoot || args._target && args._target.projectPath) }); }
    }
    async function resources() {
        await discover();
        return Array.from(editors.values()).flatMap(function (editor) { return editor.resources.map(function (resource) {
            return Object.assign({}, resource, { uri: 'cocos-router://' + editor.instanceId + '/' + encodeURIComponent(resource.uri), name: '[' + editor.shortName + '] ' + resource.name });
        }); });
    }
    async function readResource(uri) {
        var match = String(uri || '').match(/^cocos-router:\/\/([^/]+)\/(.+)$/);
        if (!match) throw identity.fault('INVALID_RESOURCE', 'Invalid Router resource URI');
        await discover();
        var editor = editors.get(match[1]);
        if (!editor) throw identity.fault('TARGET_STALE', 'Resource service generation is unavailable');
        var response = await editor.client.request('resources/read', { uri: decodeURIComponent(match[2]) });
        if (response.error) throw Object.assign(new Error(response.error.message), { code: response.error.code });
        return { ...response.result, contents: response.result.contents.map(function (content) {
            return { ...content, uri: 'cocos-router://' + editor.instanceId + '/' + encodeURIComponent(content.uri) };
        }) };
    }
    return { discover, tools, call, resources, readResource, runtime,
        initialized() { initialized = true; }, signature };
}

function createHandler(router) {
    var protocolVersion = PROTOCOL_VERSION;
    var handshake = false;
    var initializing = false;
    var ready = false;
    async function handle(message) {
        if (Array.isArray(message)) {
            if (protocolVersion !== '2025-03-26' || !message.length || message.some(item => item && item.method === 'initialize')) return { jsonrpc: '2.0', id: null, error: { code: -32600, message: 'Invalid batch' } };
            var responses = (await Promise.all(message.map(item => Array.isArray(item)
                ? { jsonrpc: '2.0', id: null, error: { code: -32600, message: 'Batch entries must be single messages' } }
                : handle(item)))).filter(Boolean);
            return responses.length ? responses : null;
        }
        if (message && message.jsonrpc === '2.0' && message.method === undefined && message.id !== undefined && ((message.result !== undefined) !== (message.error !== undefined))) return null;
        if (!message || message.jsonrpc !== '2.0' || typeof message.method !== 'string' ||
            message.id !== undefined && !['string', 'number'].includes(typeof message.id) ||
            message.params !== undefined && (!message.params || typeof message.params !== 'object' || Array.isArray(message.params)) ||
            message.id === undefined && !message.method.startsWith('notifications/')) return { jsonrpc: '2.0', id: null, error: { code: -32600, message: 'Invalid Request' } };
        var params = message.params || {};
        try {
            if (message.method !== 'initialize' && message.method !== 'ping' && message.method !== 'notifications/initialized' && !ready) throw Object.assign(new Error('Initialization must complete before use'), { code: -32600 });
            var result;
            switch (message.method) {
                case 'initialize':
                    if (handshake || initializing || !params.clientInfo || typeof params.clientInfo.name !== 'string' || typeof params.clientInfo.version !== 'string' || !params.capabilities || typeof params.capabilities !== 'object' || Array.isArray(params.capabilities) || typeof params.protocolVersion !== 'string') throw Object.assign(new Error('Invalid initialization'), { code: -32602 });
                    protocolVersion = ['2025-03-26', '2025-06-18'].includes(params.protocolVersion) ? params.protocolVersion : PROTOCOL_VERSION;
                    initializing = true;
                    try { await router.discover(); }
                    finally { initializing = false; }
                    handshake = true;
                    result = { protocolVersion, serverInfo: ROUTER_INFO, capabilities: { tools: { listChanged: true }, resources: {} },
                        _meta: { cocosMcp: { routerRuntime: router.runtime } } }; break;
                case 'notifications/initialized':
                    if (message.id !== undefined) throw Object.assign(new Error('initialized must be a notification'), { code: -32600 });
                    if (handshake) { ready = true; router.initialized(); } return;
                case 'ping': result = {}; break;
                case 'tools/list': await router.discover(); result = { tools: router.tools() }; break;
                case 'tools/call':
                    if (typeof params.name !== 'string' || !params.name || params.arguments !== undefined && (!params.arguments || typeof params.arguments !== 'object' || Array.isArray(params.arguments))) throw Object.assign(new Error('Invalid tool call parameters'), { code: -32602 });
                    result = await router.call(params.name, params.arguments === undefined ? {} : params.arguments); break;
                case 'resources/list': result = { resources: await router.resources() }; break;
                case 'resources/read': result = await router.readResource(params.uri); break;
                default: throw Object.assign(new Error('Method not found'), { code: -32601 });
            }
            if (message.id !== undefined) return { jsonrpc: '2.0', id: message.id, result };
        } catch (error) {
            if (message.id !== undefined) return { jsonrpc: '2.0', id: message.id, error: { code: typeof error.code === 'number' ? error.code : -32603, message: error.message } };
        }
    }
    return handle;
}

function startRouter() {
    function send(value) { if (value) process.stdout.write(JSON.stringify(value) + '\n'); }
    var router = createRouter({ notify: send });
    var handle = createHandler(router);
    var buffer = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', function (chunk) {
        buffer += chunk;
        var lines = buffer.split('\n'); buffer = lines.pop();
        lines.filter(function (line) { return line.trim(); }).forEach(function (line) {
            try { handle(JSON.parse(line)).then(send).catch(function (error) { process.stderr.write(error.message + '\n'); }); }
            catch (_) { send({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } }); }
        });
    });
    var timer = setInterval(function () { router.discover().catch(function (error) { process.stderr.write(error.message + '\n'); }); }, 15000);
    process.stdin.on('end', function () { clearInterval(timer); });
    router.discover().catch(function (error) { process.stderr.write(error.message + '\n'); });
}

module.exports = { createRouter, createHandler, assignAliases, validateArguments };
if (require.main === module) startRouter();
