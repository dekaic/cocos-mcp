'use strict';

var PROJECT_ID_SCHEMA = {
    type: 'string',
    pattern: '^project_[a-f0-9]{16}$',
    description: 'router_list_editors 返回的稳定项目 ID。',
};

function cloneJson(value) {
    return JSON.parse(JSON.stringify(value));
}

function addProjectScope(tool) {
    var schema = cloneJson(tool.inputSchema || { type: 'object', properties: {} });
    if (!schema || schema.type !== 'object') {
        schema = { type: 'object', properties: {} };
    }
    if (!schema.properties) schema.properties = {};
    schema.properties.projectId = cloneJson(PROJECT_ID_SCHEMA);
    schema.required = Array.from(new Set((schema.required || []).concat(['projectId']))).sort();

    return {
        name: tool.name,
        description: '[project-scoped] ' + (tool.description || ''),
        inputSchema: schema,
    };
}

/**
 * 每种 Editor tool 只暴露一次，工具总量不随编辑器实例数增长。
 * 混跑 V2/V3 时合并同名工具的 properties，并对 required 取并集：新字段会暴露给 AI，
 * 旧 Editor 会忽略不认识的附加字段；实际调用前 Router 仍确认目标实例提供该工具。
 */
function buildProjectScopedToolList(editorValues) {
    var variantsByName = new Map();
    for (var editor of editorValues) {
        (editor.tools || []).forEach(function (tool) {
            var scoped = addProjectScope(tool);
            var key = JSON.stringify(scoped);
            var variants = variantsByName.get(tool.name) || [];
            variants.push({ key: key, tool: scoped });
            variantsByName.set(tool.name, variants);
        });
    }

    return Array.from(variantsByName.keys()).sort().map(function (name) {
        var variants = variantsByName.get(name).sort(function (a, b) {
            return a.key < b.key ? -1 : (a.key > b.key ? 1 : 0);
        });
        var merged = cloneJson(variants[0].tool);
        variants.slice(1).forEach(function (variant) {
            var candidate = variant.tool;
            if ((candidate.description || '').length > (merged.description || '').length) {
                merged.description = candidate.description;
            }
            var targetSchema = merged.inputSchema;
            var sourceSchema = candidate.inputSchema;
            Object.keys(sourceSchema.properties || {}).forEach(function (key) {
                if (!targetSchema.properties[key]) {
                    targetSchema.properties[key] = cloneJson(sourceSchema.properties[key]);
                    return;
                }
                var currentJson = JSON.stringify(targetSchema.properties[key]);
                var candidateJson = JSON.stringify(sourceSchema.properties[key]);
                if (candidateJson.length > currentJson.length ||
                    (candidateJson.length === currentJson.length && candidateJson > currentJson)) {
                    targetSchema.properties[key] = cloneJson(sourceSchema.properties[key]);
                }
            });
            targetSchema.required = Array.from(new Set(
                (targetSchema.required || []).concat(sourceSchema.required || [])
            )).sort();
        });
        return merged;
    });
}

module.exports = {
    PROJECT_ID_SCHEMA: PROJECT_ID_SCHEMA,
    addProjectScope: addProjectScope,
    buildProjectScopedToolList: buildProjectScopedToolList,
};
