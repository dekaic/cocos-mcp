'use strict';

/**
 * router/src/offline-tools.js
 *
 * Router 级 offline prefab tool 定义。
 * 这些 tool 直接调用 cli/src/index.js 的 editPrefab / queryPrefab，
 * 同进程执行，无需 Cocos 编辑器运行。
 *
 * [offline] tool 命名不加 shortName 前缀（router 全局工具）。
 */

var fs = require('fs');
var path = require('path');

// 延迟 require，避免 bin.js 加载时 cli 路径不对
// __dirname = router/src/，cli 相对路径为 ../../cli/src/index.js
var CLI_INDEX = path.resolve(__dirname, '../../cli/src/index.js');

var OFFLINE_EDIT_OPS = [
    'set-position', 'set-label-text', 'set-sprite-frame', 'set-active',
    'set-component-field', 'set-component-enabled', 'set-anchor', 'set-size',
    'adjust-position', 'rename-node', 'reparent', 'reorder-children', 'add-node',
    'remove-node', 'clone-node', 'add-component', 'remove-component',
    'set-component-ref', 'set-nested-component-field', 'bulk-set',
    'dedupe-component', 'set-editbox', 'set-label', 'set-button', 'set-layout',
    'set-richtext', 'set-sprite', 'set-node-color', 'replace-nested-prefab',
    'add-nested-prefab', 'add-spine-socket', 'reset-overrides', 'ensure-meta',
    'sync-nested-roots',
];

var NODE_SELECTOR_SCHEMA = {
    description: '节点选择器：名称字符串、非负整数 id，或 { id: N } / { path: "Root/Child" }',
    anyOf: [
        { type: 'string', minLength: 1 },
        { type: 'integer', minimum: 0 },
        {
            type: 'object',
            properties: {
                id: { type: 'integer', minimum: 0 },
                path: { type: 'string', minLength: 1 },
            },
        },
    ],
};

var STRING_OR_STRING_ARRAY_SCHEMA = {
    anyOf: [
        { type: 'string' },
        { type: 'array', items: { type: 'string' } },
    ],
};

var OP_NODE_SCHEMA = {
    description: '节点选择器；add-node 时也可传 { name, lpos?, components?, width?, height?, anchor?, active? }',
    anyOf: NODE_SELECTOR_SCHEMA.anyOf.concat([
        {
            type: 'object',
            properties: {
                name: { type: 'string' },
                lpos: { type: 'array', items: { type: 'number' }, minItems: 3, maxItems: 3 },
                components: { type: 'array', items: { type: 'string' } },
                width: { type: 'number' },
                height: { type: 'number' },
                anchor: { type: 'array', items: { type: 'number' }, minItems: 2, maxItems: 2 },
                active: { type: 'boolean' },
            },
            required: ['name'],
        },
    ]),
};

// cli/src/editor/op-schema.js 中 34 种 op 所有对外字段的并集。
// 每种 op 的必填与业务约束由 CLI validateOps 统一校验；Router 这里负责让 MCP client
// 能看到并传入完整参数，避免 schema 在调用前丢字段。
var EDIT_OP_PROPERTIES = {
    op: { type: 'string', enum: OFFLINE_EDIT_OPS },
    node: OP_NODE_SCHEMA,
    parent: NODE_SELECTOR_SCHEMA,
    target: {
        description: '节点选择器；bulk-set 时为 "node" 或 "component:<Type>"',
        anyOf: NODE_SELECTOR_SCHEMA.anyOf,
    },
    source: NODE_SELECTOR_SCHEMA,
    refNode: NODE_SELECTOR_SCHEMA,
    componentType: { type: 'string' },
    property: STRING_OR_STRING_ARRAY_SCHEMA,
    refType: { type: 'string' },
    refSubNode: STRING_OR_STRING_ARRAY_SCHEMA,
    value: {},
    props: { type: 'object' },
    selector: {
        type: 'object',
        properties: {
            byComponent: { type: 'string' },
            byNamePrefix: { type: 'string' },
            byNameRegex: { type: 'string' },
        },
    },
    order: { type: 'array' },
    text: { type: 'string' },
    name: { type: 'string' },
    uuid: { type: 'string' },
    prefabUuid: { type: 'string' },
    active: { type: 'boolean' },
    enabled: { type: 'boolean' },
    compensatePosition: { type: 'boolean' },
    clearOverrides: { type: 'boolean' },
    bold: { type: 'boolean' },
    italic: { type: 'boolean' },
    underline: { type: 'boolean' },
    enableWrapText: { type: 'boolean' },
    grayscale: { type: 'boolean' },
    trim: { type: 'boolean' },
    affectedByScale: { type: 'boolean' },
    interactable: { type: 'boolean' },
    all: { type: 'boolean' },
    x: { type: 'number' },
    y: { type: 'number' },
    z: { type: 'number' },
    dx: { type: 'number' },
    dy: { type: 'number' },
    dz: { type: 'number' },
    width: { type: 'number' },
    height: { type: 'number' },
    r: { type: 'number' },
    g: { type: 'number' },
    b: { type: 'number' },
    a: { type: 'number' },
    fontSize: { type: 'number' },
    lineHeight: { type: 'number' },
    maxWidth: { type: 'number' },
    maxLength: { type: 'number' },
    inputMode: { type: 'number' },
    inputFlag: { type: 'number' },
    zoomScale: { type: 'number' },
    duration: { type: 'number' },
    type: { type: 'number' },
    sizeMode: { type: 'number' },
    overflow: { type: 'number' },
    horizontalAlign: { type: 'number' },
    verticalAlign: { type: 'number' },
    transition: { type: 'number' },
    resizeMode: { type: 'number' },
    paddingLeft: { type: 'number' },
    paddingRight: { type: 'number' },
    paddingTop: { type: 'number' },
    paddingBottom: { type: 'number' },
    spacingX: { type: 'number' },
    spacingY: { type: 'number' },
    startAxis: { type: 'number' },
    constraint: { type: 'number' },
    constraintNum: { type: 'number' },
    placeholder: { type: 'string' },
    string: { type: 'string' },
    path: { type: 'string' },
    labelNode: { type: 'string' },
    spriteNode: { type: 'string' },
    subNode: STRING_OR_STRING_ARRAY_SCHEMA,
    index: { type: 'integer', minimum: 0 },
    lpos: { type: 'array', items: { type: 'number' }, minItems: 3, maxItems: 3 },
};

function getCli() {
    return require(CLI_INDEX);
}

// ── 工具：绝对路径校验 ──────────────────────────────────────────

/**
 * 校验 filePath 是否为绝对路径，否则抛错。
 * 原因：router 以 stdio 方式运行，cwd 不确定，相对路径有歧义。
 *
 * @param {string} filePath
 * @param {string} toolName
 */
function requireAbsolutePath(filePath, toolName, fieldName) {
    var name = fieldName || 'filePath';
    if (typeof filePath !== 'string' || !path.isAbsolute(filePath)) {
        throw new Error(
            '[' + toolName + '] ' + name + ' 必须是绝对路径，收到: ' + JSON.stringify(filePath) +
            '\n原因：router 以 stdio 模式运行，cwd 不确定，相对路径会产生歧义。'
        );
    }
}

function getEditOptions(args, toolName) {
    var options = {};
    if (args.projectRoot !== undefined) {
        requireAbsolutePath(args.projectRoot, toolName, 'projectRoot');
        options.projectRoot = args.projectRoot;
    }
    if (args.dryRun !== undefined) {
        if (typeof args.dryRun !== 'boolean') {
            throw new Error('[' + toolName + '] dryRun 必须是 boolean');
        }
        options.dryRun = args.dryRun;
    }
    if (args.expectedHash !== undefined) {
        if (typeof args.expectedHash !== 'string' || !/^[a-f0-9]{64}$/.test(args.expectedHash)) {
            throw new Error('[' + toolName + '] expectedHash 必须是 64 位小写 SHA-256');
        }
        options.expectedHash = args.expectedHash;
    }
    return options;
}

// ── Tool 定义 ───────────────────────────────────────────────────

/**
 * offline tool 定义列表（与 router 自身 buildAggregatedToolList 合并）
 * 格式与编辑器 tool 相同，供 handleOfflineToolCall 分发。
 */
var OFFLINE_TOOLS = [
    {
        name: 'prefab_query',
        description: '[offline] 不需要 Cocos 编辑器运行。查询 prefab 树、节点、类型、组件字段或嵌套 Prefab overrides。\n' +
            'selector.type 可选：\n' +
            '  tree（默认）→ 精简节点树，withComps 可展开组件\n' +
            '  node → name 按名称查单节点，withComps 可展开组件\n' +
            '  find → nodeType 返回所有匹配 __type__ 的元素 id\n' +
            '  field → name + componentType + field 读取组件字段\n' +
            '  overrides → node 查询 stub 的 propertyOverrides 和 rootTargetOverrides\n' +
            '返回 structuredContent.revision，可作为下一次 prefab_edit 的 expectedHash。',
        inputSchema: {
            type: 'object',
            properties: {
                filePath: {
                    type: 'string',
                    description: 'prefab 文件的绝对路径，如 /path/to/HomeUI.prefab',
                },
                selector: {
                    type: 'object',
                    description: '查询选择器，不传时默认 type="tree"',
                    properties: {
                        type: { type: 'string', enum: ['tree', 'node', 'find', 'field', 'overrides'] },
                        withComps: { type: 'boolean', description: 'tree/node 时是否展开组件字段' },
                        name: { type: 'string', description: 'selector.type="node" 或 "field" 时必填' },
                        nodeType: { type: 'string', description: 'selector.type="find" 时必填，如 "cc.Label"' },
                        componentType: { type: 'string', description: 'selector.type="field" 时必填，如 "cc.Label"' },
                        field: { type: 'string', description: 'selector.type="field" 时必填，如 "_string"' },
                        node: NODE_SELECTOR_SCHEMA,
                    },
                },
            },
            required: ['filePath'],
        },
    },
    {
        name: 'prefab_edit',
        description: '[offline] 不需要 Cocos 编辑器运行。声明式批量编辑 prefab 文件，全部 op 成功后一次性落盘。\n' +
            '主要能力：节点层级/变换/样式，组件增删/字段/引用，UI 便捷配置，嵌套 Prefab，Spine socket，meta 和 nested roots 维护。\n' +
            '支持的 op.op：' + OFFLINE_EDIT_OPS.join(' / ') + '\n' +
            'node / parent / target / source / refNode 按各 op 需求传入，不是每个 op 都需要 node。',
        inputSchema: {
            type: 'object',
            properties: {
                filePath: {
                    type: 'string',
                    description: 'prefab 文件的绝对路径',
                },
                ops: {
                    type: 'array',
                    description: 'op 描述数组，参考 cli editPrefab 文档',
                    items: {
                        type: 'object',
                        properties: EDIT_OP_PROPERTIES,
                        required: ['op'],
                    },
                },
                dryRun: {
                    type: 'boolean',
                    description: 'true 时只返回 diff，不写回 prefab 或创建外部文件',
                },
                projectRoot: {
                    type: 'string',
                    description: '项目根目录绝对路径（包含 assets/），用于 UUID / @ccclass / 相对 path 解析',
                },
                expectedHash: {
                    type: 'string',
                    pattern: '^[a-f0-9]{64}$',
                    description: '上次查询/编辑得到的 SHA-256 revision；文件已变化时拒绝覆盖。',
                },
            },
            required: ['filePath', 'ops'],
        },
    },
    {
        name: 'prefab_batch',
        description: '[offline] 不需要 Cocos 编辑器运行。从 JSON 文件读取 ops 后批量编辑 prefab。\n' +
            'opsJsonPath 指向一个 JSON 文件，内容为 op 数组（与 prefab_edit 的 ops 格式相同）。\n' +
            '两个路径均必须为绝对路径。',
        inputSchema: {
            type: 'object',
            properties: {
                filePath: {
                    type: 'string',
                    description: 'prefab 文件的绝对路径',
                },
                opsJsonPath: {
                    type: 'string',
                    description: 'ops JSON 文件的绝对路径',
                },
                dryRun: {
                    type: 'boolean',
                    description: 'true 时只返回 diff，不写回 prefab 或创建外部文件',
                },
                projectRoot: {
                    type: 'string',
                    description: '项目根目录绝对路径（包含 assets/），用于 UUID / @ccclass / 相对 path 解析',
                },
                expectedHash: {
                    type: 'string',
                    pattern: '^[a-f0-9]{64}$',
                    description: '上次查询/编辑得到的 SHA-256 revision；文件已变化时拒绝覆盖。',
                },
            },
            required: ['filePath', 'opsJsonPath'],
        },
    },
];

// ── Tool 名称集合（用于快速判断是否是 offline tool）──────────────

var OFFLINE_TOOL_NAMES = new Set(OFFLINE_TOOLS.map(function (t) { return t.name; }));

/**
 * 判断 name 是否是 offline tool
 * @param {string} name
 * @returns {boolean}
 */
function isOfflineTool(name) {
    return OFFLINE_TOOL_NAMES.has(name);
}

// ── Tool 调用处理 ───────────────────────────────────────────────

/**
 * 处理 offline tool 调用，返回 MCP content 对象。
 *
 * @param {string} name   tool 名称
 * @param {object} args   tool 参数
 * @returns {{ content: Array }}
 */
async function handleOfflineToolCall(name, args) {
    var cli = getCli();

    if (name === 'prefab_query') {
        requireAbsolutePath(args.filePath, 'prefab_query');
        var snapshot = cli.queryPrefabWithRevision(args.filePath, args.selector);
        return {
            content: [{ type: 'text', text: JSON.stringify(snapshot.result, null, 2) }],
            structuredContent: { revision: snapshot.revision },
        };
    }

    if (name === 'prefab_edit') {
        requireAbsolutePath(args.filePath, 'prefab_edit');
        var editOptions = getEditOptions(args, 'prefab_edit');
        if (!Array.isArray(args.ops) || args.ops.length === 0) {
            throw new Error('[prefab_edit] ops 必须是非空数组');
        }
        var editResult = cli.editPrefab(args.filePath, args.ops, editOptions);
        return {
            content: [{ type: 'text', text: JSON.stringify(editResult, null, 2) }],
        };
    }

    if (name === 'prefab_batch') {
        requireAbsolutePath(args.filePath, 'prefab_batch');
        requireAbsolutePath(args.opsJsonPath, 'prefab_batch');
        var batchOptions = getEditOptions(args, 'prefab_batch');
        var opsRaw = fs.readFileSync(args.opsJsonPath, 'utf-8');
        var ops;
        try {
            ops = JSON.parse(opsRaw);
        } catch (e) {
            throw new Error('[prefab_batch] opsJsonPath 解析失败: ' + e.message);
        }
        if (!Array.isArray(ops) || ops.length === 0) {
            throw new Error('[prefab_batch] opsJsonPath 文件内容必须是非空数组');
        }
        var batchResult = cli.editPrefab(args.filePath, ops, batchOptions);
        return {
            content: [{ type: 'text', text: JSON.stringify(batchResult, null, 2) }],
        };
    }

    throw new Error('offline-tools: 未知 tool "' + name + '"');
}

module.exports = {
    OFFLINE_TOOLS: OFFLINE_TOOLS,
    isOfflineTool: isOfflineTool,
    handleOfflineToolCall: handleOfflineToolCall,
    requireAbsolutePath: requireAbsolutePath,
};
