'use strict';

var buildProjectScopedToolList = require('./project-tools.js').buildProjectScopedToolList;

function stableValue(value) {
    if (Array.isArray(value)) return value.map(stableValue);
    if (!value || typeof value !== 'object') return value;

    var out = {};
    Object.keys(value).sort().forEach(function (key) {
        out[key] = stableValue(value[key]);
    });
    return out;
}

/**
 * 根据 Router 最终暴露的 project-scoped 工具定义生成稳定签名。
 * 工具顺序和 schema 字段顺序不影响签名；名称、描述或 inputSchema 变化会影响签名。
 */
function toolListSignature(editorValues) {
    var tools = buildProjectScopedToolList(editorValues);

    var normalized = tools.map(stableValue).map(function (tool) {
        return JSON.stringify(tool);
    });
    normalized.sort();
    return JSON.stringify(normalized);
}

module.exports = {
    toolListSignature: toolListSignature,
};
