'use strict';
const http = require('http');
const { fault } = require('./identity');

function createClient(entry, options = {}) {
    const transport = entry.transport;
    if (!transport || typeof transport.bearerToken !== 'string' || !transport.bearerToken) throw fault('CLIENT_MIGRATION_REQUIRED', 'Authenticated service registration is required');
    const endpoint = new URL(transport.url);
    if (endpoint.protocol !== 'http:' || endpoint.hostname !== '127.0.0.1' || !endpoint.port || endpoint.pathname !== '/mcp' || endpoint.search || endpoint.hash || endpoint.username || endpoint.password) throw fault('INVALID_ENDPOINT', 'Only a numeric local MCP endpoint is supported');
    let nextId = 1;
    let protocolVersion = '2025-06-18';
    let initialized;
    let sessionId;
    function post(method, params, notification) {
        return new Promise((resolve, reject) => {
            const body = JSON.stringify({ jsonrpc: '2.0', ...(notification ? {} : { id: nextId++ }), method, params });
            const req = http.request({ hostname: endpoint.hostname, port: endpoint.port, path: endpoint.pathname, method: 'POST',
                headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream',
                    'MCP-Protocol-Version': protocolVersion, Authorization: 'Bearer ' + transport.bearerToken,
                    ...(sessionId ? { 'Mcp-Session-Id': sessionId } : {}),
                    'Content-Length': Buffer.byteLength(body) }, timeout: options.timeoutMs || 8000,
            }, res => {
                const chunks = [];
                res.on('data', chunk => chunks.push(chunk));
                res.on('error', reject);
                res.on('end', () => {
                    if (method === 'initialize' && res.statusCode === 200) sessionId = res.headers['mcp-session-id'];
                    if (res.statusCode === 202 && notification) return resolve(null);
                    if (res.statusCode === 404 && sessionId) { initialized = undefined; sessionId = undefined; return reject(fault('SESSION_EXPIRED', 'Session expired. Initialize again, then query the same operationId; mutation was not automatically replayed')); }
                    if (res.statusCode !== 200) return reject(fault('HTTP_REJECTED', 'MCP HTTP rejected request (' + res.statusCode + ')'));
                    try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
                    catch (_) { reject(fault('INVALID_RESPONSE', 'MCP response was not valid JSON')); }
                });
            });
            req.on('error', reject);
            req.on('timeout', () => req.destroy(fault('TRANSPORT_UNKNOWN', 'MCP request timed out; execution is not cancelled')));
            req.end(body);
        });
    }
    async function initialize() {
        if (!initialized) initialized = (async () => {
            const response = await post('initialize', { protocolVersion, capabilities: {}, clientInfo: { name: 'cocos-mcp-client', version: '1' } });
            if (response.error || !response.result || !['2025-03-26', '2025-06-18'].includes(response.result.protocolVersion)) throw fault('PROTOCOL_MISMATCH', 'MCP protocol negotiation failed');
            protocolVersion = response.result.protocolVersion;
            await post('notifications/initialized', undefined, true);
        })();
        return initialized;
    }
    async function request(method, params) { await initialize(); return post(method, params, false); }
    return { initialize, request, target: { projectPath: entry.projectPath, instanceId: entry.instanceId } };
}
module.exports = { createClient };
