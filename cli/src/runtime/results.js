'use strict';

// Only infer bare content when every block has a known type and its required fields.
function isContentBlock(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
    switch (value.type) {
        case 'text': return typeof value.text === 'string';
        case 'image':
        case 'audio': return typeof value.data === 'string' && typeof value.mimeType === 'string';
        case 'resource_link': return typeof value.uri === 'string' && typeof value.name === 'string';
        case 'resource': {
            const resource = value.resource;
            return !!resource && typeof resource === 'object' && !Array.isArray(resource) &&
                typeof resource.uri === 'string' &&
                (typeof resource.text === 'string' || typeof resource.blob === 'string');
        }
        default: return false;
    }
}


const CONTROL_SCHEMA = { type: 'object', required: ['cocosMcpControl'], additionalProperties: false,
    properties: { cocosMcpControl: { type: 'object', required: ['code', 'state', 'nextAction'],
        properties: { code: { type: 'string' }, state: { type: 'string' }, operationId: { type: 'string' },
            projectPath: { type: 'string' }, originalTarget: { type: 'object' }, nextAction: { type: 'string' },
            blockers: {}, effects: {}, message: { type: 'string' } } } } };
function normalize(result) {
    if (result && typeof result === 'object' && !Array.isArray(result)) {
        const metadata = result._meta || {};
        const business = Object.fromEntries(Object.entries(result).filter(([key]) => !['content', 'structuredContent', '_meta', 'isError'].includes(key)));
        if (result.content || result.structuredContent || result.isError !== undefined) {
            return { ...result, content: result.content || [{ type: 'text', text: JSON.stringify(result.structuredContent || business) }] };
        }
        return { content: [{ type: 'text', text: JSON.stringify(business) }], ...(Object.keys(metadata).length ? { _meta: metadata } : {}) };
    }
    return { content: Array.isArray(result) && result.length > 0 && result.every(isContentBlock) ? result : [{ type: 'text', text: typeof result === 'string' ? result : JSON.stringify(result === undefined ? null : result) }] };
}
function control(code, context = {}) {
    const state = context.state || 'failed';
    const pending = state === 'running' || state === 'submitted';
    const uncertain = state === 'unknown';
    const nextAction = context.nextAction || (pending || uncertain ? 'Query this operationId; do not retry the mutation with a new ID.' : 'Inspect the cause before starting a new operation.');
    const value = { code, state, operationId: context.operationId, projectPath: context.projectPath,
        originalTarget: context.originalTarget, blockers: context.blockers, effects: context.effects,
        message: context.message, nextAction,
        ...(context.tool === 'local_reload_package' && (pending || uncertain) ? { scheduled: true, completionObserved: false } : {}) };
    const heading = pending ? 'Operation has not completed.' : uncertain ? 'Operation result is unknown; this does not mean execution failed.' : 'Operation could not complete.';
    return { content: [{ type: 'text', text: heading + '\n' + JSON.stringify(value, null, 2) }],
        structuredContent: { cocosMcpControl: value }, isError: !pending, _meta: { cocosMcp: value } };
}
function fromRecord(record) {
    if (record.state !== 'succeeded') return control(record.result && record.result.code || 'OPERATION_' + record.state.toUpperCase(), record);
    const result = normalize(record.result);
    return { ...result, _meta: { ...(result._meta || {}), cocosMcp: { state: record.state, operationId: record.operationId,
        projectPath: record.projectPath, originalTarget: record.originalTarget, effects: record.effects } } };
}
function fromError(error, context = {}) { return control(error.code || 'EXECUTION_FAILED', { ...context, message: error.message, blockers: error.details }); }
function outputSchema(schema) { return schema ? { type: 'object', anyOf: [schema, CONTROL_SCHEMA] } : undefined; }
module.exports = { CONTROL_SCHEMA, normalize, control, fromRecord, fromError, outputSchema };
