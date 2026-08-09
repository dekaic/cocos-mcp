'use strict';

// ============================================================
// router/test/offline-tools.test.js
// T13 offline tool 测试
//
// 直接 require router/src/offline-tools.js，测：
//   1. prefab_query  happy path（tree / node / find）
//   2. prefab_edit   happy path（set-active 写 tmp 文件）
//   3. prefab_batch  happy path（opsJson 文件 → editPrefab）
//   4. 相对路径 filePath 报错
//   5. prefab_batch opsJsonPath 相对路径报错
// ============================================================

const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');
const {
    makeLabel,
    makeNode,
    makePrefabRoot,
} = require('../../cli/src/primitives.js');
const { parsePrefab } = require('../../cli/src/parse.js');
const { SCHEMAS: EDIT_OP_SCHEMAS } = require('../../cli/src/editor/op-schema.js');

const {
    isOfflineTool,
    handleOfflineToolCall,
    requireAbsolutePath,
    OFFLINE_TOOLS,
} = require('../src/offline-tools.js');

const TMP_FILES = [];
const TMP_DIRS = [];
var nextTmpId = 0;

after(() => {
    for (var filePath of TMP_FILES) {
        try { fs.unlinkSync(filePath); } catch (_) {}
    }
    for (var dirPath of TMP_DIRS) {
        try { fs.rmSync(dirPath, { recursive: true, force: true }); } catch (_) {}
    }
});

function makeMinimalFixturePrefab() {
    return [
        makePrefabRoot({ name: 'FixtureRoot', rootId: 1 }),
        makeNode({ name: 'FixtureRoot', childIds: [2], active: true }),
        makeNode({ name: 'title', parentId: 1, componentIds: [3], active: true }),
        makeLabel({ nodeId: 2, string: 'Start' }),
    ];
}

function makeFixture(tag) {
    var dst = path.join(
        os.tmpdir(),
        'Fixture-router-fixture-' + tag + '-' + process.pid + '-' + nextTmpId++ + '.prefab'
    );
    fs.writeFileSync(dst, JSON.stringify(makeMinimalFixturePrefab(), null, 2) + '\n', 'utf-8');
    TMP_FILES.push(dst);
    return dst;
}

// 复制 fixture 到 tmp 用于写操作
function makeTmp(tag) {
    return makeFixture(tag);
}

function makeProjectFixture(tag) {
    var root = fs.mkdtempSync(path.join(os.tmpdir(), 'cocos-mcp-router-' + tag + '-'));
    var scriptsDir = path.join(root, 'assets', 'scripts');
    fs.mkdirSync(scriptsDir, { recursive: true });
    fs.writeFileSync(path.join(root, 'package.json'), '{"name":"router-test"}\n', 'utf-8');
    var scriptPath = path.join(scriptsDir, 'RuntimeComp.ts');
    fs.writeFileSync(scriptPath, 'export class RuntimeComp {}\n', 'utf-8');
    TMP_DIRS.push(root);
    return { root: root, scriptPath: scriptPath };
}

// ── OFFLINE_TOOLS 定义完整性 ────────────────────────────────────

test('OFFLINE_TOOLS 导出 3 个 tool，名称正确', () => {
    assert.equal(OFFLINE_TOOLS.length, 3);
    var names = OFFLINE_TOOLS.map(function (t) { return t.name; });
    assert.ok(names.includes('prefab_query'));
    assert.ok(names.includes('prefab_edit'));
    assert.ok(names.includes('prefab_batch'));
});

test('isOfflineTool 对已知 name 返回 true，未知 name 返回 false', () => {
    assert.equal(isOfflineTool('prefab_query'), true);
    assert.equal(isOfflineTool('prefab_edit'), true);
    assert.equal(isOfflineTool('prefab_batch'), true);
    assert.equal(isOfflineTool('router_list_editors'), false);
    assert.equal(isOfflineTool('scene_set_property'), false);
    assert.equal(isOfflineTool(''), false);
});

test('每个 offline tool description 包含 "[offline]" 标注', () => {
    for (var t of OFFLINE_TOOLS) {
        assert.ok(
            t.description.includes('[offline]'),
            'tool ' + t.name + ' description 应包含 "[offline]"'
        );
    }
});

test('prefab_query schema 完整暴露 field / overrides 选择器', () => {
    var tool = OFFLINE_TOOLS.find(function (item) { return item.name === 'prefab_query'; });
    var selector = tool.inputSchema.properties.selector;
    assert.ok(selector.properties.type.enum.includes('field'));
    assert.ok(selector.properties.type.enum.includes('overrides'));
    assert.ok(selector.properties.componentType);
    assert.ok(selector.properties.field);
    assert.ok(selector.properties.node);
    assert.ok(selector.properties.withComps);
});

test('prefab_edit schema 只强制 op，不强制每个 op 都有 node', () => {
    var tool = OFFLINE_TOOLS.find(function (item) { return item.name === 'prefab_edit'; });
    var itemSchema = tool.inputSchema.properties.ops.items;
    assert.deepEqual(itemSchema.required, ['op']);
    assert.ok(itemSchema.properties.op.enum.includes('ensure-meta'));
    assert.ok(itemSchema.properties.op.enum.includes('add-nested-prefab'));
    assert.ok(itemSchema.properties.op.enum.includes('reparent'));
});

test('prefab_edit schema 暴露 CLI 全部 op 字段与代表性参数', () => {
    var tool = OFFLINE_TOOLS.find(function (item) { return item.name === 'prefab_edit'; });
    var itemSchema = tool.inputSchema.properties.ops.items;
    var cliFields = new Set(['op']);
    Object.values(EDIT_OP_SCHEMAS).forEach(function (schema) {
        schema.required.concat(schema.optional).forEach(function (field) {
            cliFields.add(field);
        });
    });

    cliFields.forEach(function (field) {
        assert.ok(itemSchema.properties[field], 'schema 应暴露 CLI op 字段 ' + field);
    });
    ['active', 'x', 'componentType', 'value', 'path', 'lpos', 'selector', 'props'].forEach(function (field) {
        assert.ok(itemSchema.properties[field], '缺少代表性字段 ' + field);
    });
    assert.deepEqual(
        new Set(itemSchema.properties.op.enum),
        new Set(Object.keys(EDIT_OP_SCHEMAS))
    );
});

test('prefab_edit 和 prefab_batch schema 都暴露 dryRun / projectRoot / expectedHash', () => {
    ['prefab_edit', 'prefab_batch'].forEach(function (name) {
        var tool = OFFLINE_TOOLS.find(function (item) { return item.name === name; });
        assert.equal(tool.inputSchema.properties.dryRun.type, 'boolean');
        assert.equal(tool.inputSchema.properties.projectRoot.type, 'string');
        assert.match(tool.inputSchema.properties.projectRoot.description, /绝对路径/);
        assert.equal(tool.inputSchema.properties.expectedHash.type, 'string');
        assert.equal(tool.inputSchema.properties.expectedHash.pattern, '^[a-f0-9]{64}$');
    });
});

// ── requireAbsolutePath ────────────────────────────────────────

test('requireAbsolutePath 相对路径抛错', () => {
    assert.throws(
        function () { requireAbsolutePath('relative/path.prefab', 'test'); },
        /必须是绝对路径/
    );
});

test('requireAbsolutePath 绝对路径不抛错', () => {
    assert.doesNotThrow(function () {
        requireAbsolutePath('/absolute/path.prefab', 'test');
    });
});

// ── prefab_query happy path ─────────────────────────────────────

test('prefab_query type=tree 返回 MCP content，根节点名称为 FixtureRoot', async () => {
    var fixturePath = makeFixture('query-tree');
    var result = await handleOfflineToolCall('prefab_query', {
        filePath: fixturePath,
        selector: { type: 'tree' },
    });

    assert.ok(Array.isArray(result.content), 'result.content 应是数组');
    assert.equal(result.content[0].type, 'text');

    var data = JSON.parse(result.content[0].text);
    assert.equal(data.name, 'FixtureRoot', '根节点 name 应为 FixtureRoot');
    assert.ok(Array.isArray(data.children), 'children 应是数组');
    assert.match(result.structuredContent.revision, /^[a-f0-9]{64}$/);
});

test('prefab_query 无 selector 默认返回 tree', async () => {
    var fixturePath = makeFixture('query-default');
    var result = await handleOfflineToolCall('prefab_query', {
        filePath: fixturePath,
    });

    var data = JSON.parse(result.content[0].text);
    assert.equal(data.name, 'FixtureRoot');
});

test('prefab_query type=find 返回 cc.Label id 列表', async () => {
    var fixturePath = makeFixture('query-find');
    var result = await handleOfflineToolCall('prefab_query', {
        filePath: fixturePath,
        selector: { type: 'find', nodeType: 'cc.Label' },
    });

    var ids = JSON.parse(result.content[0].text);
    assert.ok(Array.isArray(ids), 'find 结果应是数组');
    assert.ok(ids.length > 0, '应找到至少一个 cc.Label');
    ids.forEach(function (id) { assert.equal(typeof id, 'number'); });
});

test('prefab_query type=field 返回组件字段', async () => {
    var fixturePath = makeFixture('query-field');
    var result = await handleOfflineToolCall('prefab_query', {
        filePath: fixturePath,
        selector: {
            type: 'field',
            name: 'title',
            componentType: 'cc.Label',
            field: '_string',
        },
    });

    assert.equal(JSON.parse(result.content[0].text), 'Start');
});

// ── prefab_query 相对路径报错 ────────────────────────────────────

test('prefab_query 相对路径 filePath 抛错', async () => {
    await assert.rejects(
        function () {
            return handleOfflineToolCall('prefab_query', {
                filePath: 'relative/Fixture.prefab',
            });
        },
        /必须是绝对路径/
    );
});

// ── prefab_edit happy path ──────────────────────────────────────

test('prefab_edit set-active 成功，返回 changed=true + opsApplied=1', async () => {
    var tmp = makeTmp('edit');
    try {
        var result = await handleOfflineToolCall('prefab_edit', {
            filePath: tmp,
            ops: [
                { op: 'set-active', node: 'FixtureRoot', active: false },
            ],
        });

        var data = JSON.parse(result.content[0].text);
        assert.equal(data.changed, true, 'changed 应为 true');
        assert.equal(data.opsApplied, 1, 'opsApplied 应为 1');
        assert.ok(Array.isArray(data.nodesAffected), 'nodesAffected 应是数组');
    } finally {
        try { fs.unlinkSync(tmp); } catch (_) {}
    }
});

test('prefab_edit dryRun 返回 diff 且不写回 prefab', async () => {
    var tmp = makeTmp('edit-dry-run');
    var before = fs.readFileSync(tmp, 'utf-8');
    var result = await handleOfflineToolCall('prefab_edit', {
        filePath: tmp,
        ops: [{ op: 'set-active', node: 'FixtureRoot', active: false }],
        dryRun: true,
    });

    var data = JSON.parse(result.content[0].text);
    assert.equal(data.dryRun, true);
    assert.ok(data.diff.length > 0);
    assert.equal(fs.readFileSync(tmp, 'utf-8'), before);
});

test('prefab_edit 接受查询 revision，并拒绝过期 expectedHash', async () => {
    var tmp = makeTmp('edit-revision');
    var queryResult = await handleOfflineToolCall('prefab_query', {
        filePath: tmp,
    });
    var revision = queryResult.structuredContent.revision;

    var result = await handleOfflineToolCall('prefab_edit', {
        filePath: tmp,
        ops: [{ op: 'set-active', node: 'FixtureRoot', active: false }],
        expectedHash: revision,
    });
    var data = JSON.parse(result.content[0].text);
    assert.equal(data.beforeHash, revision);
    assert.match(data.afterHash, /^[a-f0-9]{64}$/);

    await assert.rejects(function () {
        return handleOfflineToolCall('prefab_edit', {
            filePath: tmp,
            ops: [{ op: 'set-active', node: 'FixtureRoot', active: true }],
            expectedHash: revision,
        });
    }, /revision conflict/);
});

test('prefab_edit 将 projectRoot / dryRun 透传给 CLI，相对 path 可解析且不创建 meta', async () => {
    var tmp = makeTmp('edit-project-root');
    var project = makeProjectFixture('edit-project-root');
    var result = await handleOfflineToolCall('prefab_edit', {
        filePath: tmp,
        ops: [{ op: 'ensure-meta', path: 'assets/scripts/RuntimeComp.ts' }],
        projectRoot: project.root,
        dryRun: true,
    });

    var data = JSON.parse(result.content[0].text);
    assert.equal(data.dryRun, true);
    assert.equal(fs.existsSync(project.scriptPath + '.meta'), false);
});

// ── prefab_edit 相对路径报错 ─────────────────────────────────────

test('prefab_edit 接受 schema 声明的数字节点 id', async () => {
    var tmp = makeTmp('edit-number-id');
    var result = await handleOfflineToolCall('prefab_edit', {
        filePath: tmp,
        ops: [
            { op: 'set-active', node: 1, active: false },
        ],
    });

    assert.equal(JSON.parse(result.content[0].text).changed, true);
    assert.equal(parsePrefab(tmp).elements[1]._active, false);
});

test('prefab_edit 相对路径 filePath 抛错', async () => {
    await assert.rejects(
        function () {
            return handleOfflineToolCall('prefab_edit', {
                filePath: './relative.prefab',
                ops: [{ op: 'set-active', node: 'FixtureRoot', active: false }],
            });
        },
        /必须是绝对路径/
    );
});

// ── prefab_batch happy path ─────────────────────────────────────

test('prefab_batch 从 JSON 文件读取 ops，成功写回', async () => {
    var tmp = makeTmp('batch');
    var opsJson = path.join(os.tmpdir(), 'router-batch-ops-' + Date.now() + '.json');
    var ops = [
        { op: 'set-active', node: 'FixtureRoot', active: false },
    ];
    fs.writeFileSync(opsJson, JSON.stringify(ops), 'utf-8');

    try {
        var result = await handleOfflineToolCall('prefab_batch', {
            filePath: tmp,
            opsJsonPath: opsJson,
        });

        var data = JSON.parse(result.content[0].text);
        assert.equal(data.changed, true);
        assert.equal(data.opsApplied, 1);

        var reparsed = parsePrefab(tmp);
        var root = reparsed.findNodeByName('FixtureRoot');
        assert.equal(root._active, false, 'prefab_batch 应实际写回 _active=false');
    } finally {
        try { fs.unlinkSync(tmp); } catch (_) {}
        try { fs.unlinkSync(opsJson); } catch (_) {}
    }
});

test('prefab_batch 将 projectRoot / dryRun 透传给 CLI，相对 path 可解析且不创建 meta', async () => {
    var tmp = makeTmp('batch-project-root');
    var project = makeProjectFixture('batch-project-root');
    var opsJson = path.join(project.root, 'ops.json');
    fs.writeFileSync(opsJson, JSON.stringify([
        { op: 'ensure-meta', path: 'assets/scripts/RuntimeComp.ts' },
    ]), 'utf-8');

    var result = await handleOfflineToolCall('prefab_batch', {
        filePath: tmp,
        opsJsonPath: opsJson,
        projectRoot: project.root,
        dryRun: true,
    });

    var data = JSON.parse(result.content[0].text);
    assert.equal(data.dryRun, true);
    assert.equal(fs.existsSync(project.scriptPath + '.meta'), false);
});

test('prefab_edit / prefab_batch 拒绝相对 projectRoot', async () => {
    var tmp = makeTmp('relative-project-root');
    var opsJson = path.join(os.tmpdir(), 'router-relative-root-ops-' + process.pid + '.json');
    fs.writeFileSync(opsJson, JSON.stringify([
        { op: 'set-active', node: 'FixtureRoot', active: false },
    ]), 'utf-8');
    TMP_FILES.push(opsJson);

    await assert.rejects(function () {
        return handleOfflineToolCall('prefab_edit', {
            filePath: tmp,
            ops: [{ op: 'set-active', node: 'FixtureRoot', active: false }],
            projectRoot: './project',
        });
    }, /projectRoot 必须是绝对路径/);

    await assert.rejects(function () {
        return handleOfflineToolCall('prefab_batch', {
            filePath: tmp,
            opsJsonPath: opsJson,
            projectRoot: './project',
        });
    }, /projectRoot 必须是绝对路径/);
});

// ── prefab_batch 相对路径报错 ────────────────────────────────────

test('prefab_batch 相对路径 filePath 抛错', async () => {
    await assert.rejects(
        function () {
            return handleOfflineToolCall('prefab_batch', {
                filePath: 'relative.prefab',
                opsJsonPath: '/absolute/ops.json',
            });
        },
        /必须是绝对路径/
    );
});

test('prefab_batch 相对路径 opsJsonPath 抛错', async () => {
    var fixturePath = makeFixture('batch-relative-ops');
    await assert.rejects(
        function () {
            return handleOfflineToolCall('prefab_batch', {
                filePath: fixturePath,
                opsJsonPath: 'relative/ops.json',
            });
        },
        /必须是绝对路径/
    );
});
