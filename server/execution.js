'use strict';
const { createStore } = require('../cli/src/runtime/operations');
const { assertTarget } = require('../cli/src/runtime/registry');
const { classify } = require('../cli/src/runtime/effects');
const results = require('../cli/src/runtime/results');
const { AsyncLocalStorage } = require('async_hooks');
const scope = new AsyncLocalStorage();
const { fault } = require('../cli/src/runtime/identity');
const { validateArguments } = require('../mcp-sdk/protocol/dispatcher');

function normalizeOutput(result, schema) {
    if (!schema) return result;
    const normalized = results.normalize(result);
    if (!normalized.structuredContent && result && typeof result === 'object' && !Array.isArray(result)) {
        normalized.structuredContent = Object.fromEntries(Object.entries(result).filter(([key]) => !['content', '_meta', 'isError'].includes(key)));
    }
    const invalid = validateArguments(schema, normalized.structuredContent, 'result');
    if (invalid) throw fault('OUTPUT_SCHEMA_MISMATCH', invalid);
    return normalized;
}
async function runLocal(tool, registration, store, fn, args = {}, operationId = require('crypto').randomUUID()) {
    const parent = scope.getStore();
    if (parent && parent.request.projectPath === registration.projectPath) return fn();
    const record = await store.execute({ projectPath: registration.projectPath, operationId, target: { projectPath: registration.projectPath, instanceId: registration.instanceId }, tool, args },
        entry => scope.run(entry, fn), { assertTarget: () => assertTarget({ projectPath: registration.projectPath, instanceId: registration.instanceId }, registration) });
    if (record.state === 'succeeded') return record.result;
    throw Object.assign(fault('OPERATION_' + record.state.toUpperCase(), 'Query operation ' + operationId + '; do not replay with a new ID'), { operation: record });
}

const TARGET_SCHEMA = { type: 'object', additionalProperties: false, required: ['projectPath', 'instanceId'],
    properties: { projectPath: { type: 'string' }, instanceId: { type: 'string', minLength: 1 } } };

function wrapTools(definitions, registration, store = createStore()) {
    const tools = definitions.concat([{ name: 'local_operation_status', description: 'Query durable operation facts, including operations from earlier service generations.',
        inputSchema: { type: 'object', properties: { operationId: { type: 'string' } } },
        handler: args => { const records = store.status(registration.projectPath, args.operationId); return Array.isArray(records) ? records.filter(record => record.unresolved) : records; } }]);
    return tools.map(tool => {
        const effect = classify(tool.name);
        const schema = tool.inputSchema || { type: 'object', properties: {} };
        return { ...tool, inputSchema: { ...schema, additionalProperties: false,
            properties: { ...(schema.properties || {}), _target: TARGET_SCHEMA,
                ...(effect !== 'query' ? { operationId: { type: 'string', minLength: 1, maxLength: 128 } } : {}) },
            required: Array.from(new Set([...(schema.required || []), '_target', ...(effect !== 'query' ? ['operationId'] : [])])) },
        outputSchema: results.outputSchema(tool.outputSchema),
        annotations: { ...(tool.annotations || {}), readOnlyHint: effect === 'query' },
        async handler(args, context = {}) {
            const { _target, operationId, ...business } = args;
            try {
                if (effect === 'query') {
                    assertTarget(_target, registration);
                    return normalizeOutput(await tool.handler(operationId === undefined ? business : { ...business, operationId }), tool.outputSchema);
                }
                const request = { projectPath: registration.projectPath, target: _target, operationId, tool: tool.name, args: business };
                const execute = tool.name === 'local_reload_package' ? store.executeDetached : store.execute;
                const record = await execute(request, entry => scope.run(entry, async () => {
                    const result = await tool.handler(business, entry);
                    if (result && result.isError) throw fault('BUSINESS_EFFECTS_UNCONFIRMED', 'Tool reported an error after dispatch; inspect the original operation effects');
                    return normalizeOutput(result, tool.outputSchema);
                }), {
                    assertTarget: () => assertTarget(_target, registration), submissionId: context.requestMeta && context.requestMeta.cocosMcp && context.requestMeta.cocosMcp.submissionId });
                return results.fromRecord(record);
            } catch (error) { return results.fromError(error, { projectPath: registration.projectPath, operationId, originalTarget: _target }); }
        } };
    });
}
module.exports = { wrapTools, TARGET_SCHEMA, runLocal, currentExecution: () => scope.getStore(), normalizeOutput };
