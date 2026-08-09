'use strict';

/**
 * MCP Tools 注册表
 * 每个 tool 透传到对应的 Editor.Message.request 或本地 helper。
 * ctx 提供：editor message 封装、本地辅助函数。
 */

function defineTools(ctx) {
    var msg = ctx.msg;   // async (target, name, ...args) => result
    var local = ctx.local; // { getPreviewUrl, doReimport, doRefreshAssets, doReloadScene, listWorktrees, openDevDir, cleanDevDir, getStatus }
    var sceneTimeoutMs = Number.isFinite(ctx.sceneTimeoutMs) ? ctx.sceneTimeoutMs : 15000;

    function requireString(args, key) {
        if (!args || typeof args[key] !== 'string' || args[key].trim().length === 0) {
            throw new Error(key + ' is required');
        }
        return args[key];
    }

    function sceneRequest(name) {
        var rest = Array.prototype.slice.call(arguments, 1);
        var request = Promise.resolve().then(function () {
            return msg.apply(null, ['scene', name].concat(rest));
        });
        return new Promise(function (resolve, reject) {
            var timer = setTimeout(function () {
                reject(new Error('scene ' + name + ' timed out after ' + sceneTimeoutMs + 'ms; close any Creator modal and retry'));
            }, sceneTimeoutMs);
            request.then(function (value) {
                clearTimeout(timer);
                resolve(value);
            }, function (error) {
                clearTimeout(timer);
                reject(error);
            });
        });
    }

    function stripEditorSceneRoots(tree) {
        if (!tree || !Array.isArray(tree.children)) return tree;
        var editorRoots = {
            'Editor Scene Foreground': true,
            'Editor Scene Background': true,
        };
        tree.children = tree.children.filter(function (child) {
            return !(child && editorRoots[child.name]);
        });
        return tree;
    }

    function readDumpPath(dump, pathText) {
        var current = dump;
        var parts = String(pathText).split('.').filter(Boolean);
        for (var i = 0; i < parts.length; i++) {
            // Inspector wraps component and nested value dumps in { value: ... },
            // while set-property still expects the logical path without ".value".
            // Only unwrap when the requested segment is absent so explicit value
            // paths and ordinary objects that happen to own a value field still work.
            while (
                current !== null &&
                current !== undefined &&
                typeof current === 'object' &&
                !Object.prototype.hasOwnProperty.call(current, parts[i]) &&
                Object.prototype.hasOwnProperty.call(current, 'value')
            ) {
                current = current.value;
            }
            if (current === null || current === undefined || !Object.prototype.hasOwnProperty.call(current, parts[i])) {
                return { found: false, value: undefined };
            }
            current = current[parts[i]];
        }
        return { found: true, value: current };
    }

    function unwrapDump(value) {
        if (value && typeof value === 'object' && Object.prototype.hasOwnProperty.call(value, 'value')) {
            return value.value;
        }
        return value;
    }

    function sameJson(left, right) {
        return JSON.stringify(left) === JSON.stringify(right);
    }

    async function queryCurrentSceneAsset() {
        var state = await sceneRequest('execute-scene-script', {
            name: 'cocos-mcp',
            method: 'querySceneState',
            args: [],
        });
        if (!state || !state.uuid) throw new Error('current scene is not loaded');
        var info = await msg('asset-db', 'query-asset-info', state.uuid);
        return { state: state, info: info };
    }

    // execute-scene-script runs inside the Scene process and bypasses the
    // Inspector's normal undo/dirty path. Wrap structural edits in an editor
    // recording so they are persisted by scene_save_scene and can be undone.
    async function runSceneMutation(method, args, recordUuids) {
        var undoId = await sceneRequest('begin-recording', recordUuids);
        try {
            var result = await sceneRequest('execute-scene-script', {
                name: 'cocos-mcp',
                method: method,
                args: [args],
            });
            await sceneRequest('end-recording', undoId);
            return result;
        } catch (error) {
            if (undoId) {
                try {
                    await sceneRequest('cancel-recording', undoId);
                } catch (_) {
                    // Keep the mutation failure actionable; cancellation is best-effort cleanup.
                }
            }
            throw error;
        }
    }

    return [
        // ── scene 域 ──
        {
            name: 'scene_query_node_tree',
            description: '查询当前场景节点树。传 uuid 查子树，不传查根。',
            inputSchema: {
                type: 'object',
                properties: { uuid: { type: 'string', description: '可选：节点 uuid' } },
            },
            handler: async function (args) {
                args = args || {};
                var tree = await sceneRequest('execute-scene-script', {
                    name: 'cocos-mcp',
                    method: 'queryNodeTree',
                    args: [args.uuid],
                });
                return args.uuid ? tree : stripEditorSceneRoots(tree);
            },
        },
        {
            name: 'scene_query_node',
            description: '查询单个节点完整 dump（含所有组件属性）',
            inputSchema: {
                type: 'object',
                properties: { uuid: { type: 'string' } },
                required: ['uuid'],
            },
            handler: async function (args) {
                var uuid = requireString(args, 'uuid');
                var result = await sceneRequest('query-node', uuid);
                if (result === null || result === undefined) {
                    throw new Error('node not found: ' + uuid);
                }
                return result;
            },
        },
        {
            name: 'scene_add_node',
            description: '在当前场景中创建一个真实子节点。可选设置本地 position 与 active；随后可用 scene_create_component、scene_set_property 继续配置。',
            inputSchema: {
                type: 'object',
                properties: {
                    parentUuid: { type: 'string', description: '父节点 uuid' },
                    name: { type: 'string', description: '新节点名称' },
                    position: {
                        type: 'object',
                        properties: { x: { type: 'number' }, y: { type: 'number' }, z: { type: 'number' } },
                    },
                    active: { type: 'boolean' },
                },
                required: ['parentUuid', 'name'],
            },
            handler: async function (args) {
                requireString(args, 'parentUuid');
                requireString(args, 'name');
                return await runSceneMutation('addNode', args, [args.parentUuid]);
            },
        },
        {
            name: 'scene_clone_node',
            description: '复制当前场景中的节点树，并作为指定父节点的子节点。',
            inputSchema: {
                type: 'object',
                properties: {
                    sourceUuid: { type: 'string', description: '源节点 uuid' },
                    parentUuid: { type: 'string', description: '目标父节点 uuid' },
                    name: { type: 'string', description: '可选：复制后名称' },
                    position: {
                        type: 'object',
                        properties: { x: { type: 'number' }, y: { type: 'number' }, z: { type: 'number' } },
                    },
                    active: { type: 'boolean' },
                },
                required: ['sourceUuid', 'parentUuid'],
            },
            handler: async function (args) {
                requireString(args, 'sourceUuid');
                requireString(args, 'parentUuid');
                return await runSceneMutation('cloneNode', args, [args.sourceUuid, args.parentUuid]);
            },
        },
        {
            name: 'scene_remove_node',
            description: '从当前场景移除指定节点及其子树；不能移除 Scene 根。',
            inputSchema: {
                type: 'object',
                properties: { uuid: { type: 'string', description: '目标节点 uuid' } },
                required: ['uuid'],
            },
            handler: async function (args) {
                requireString(args, 'uuid');
                return await runSceneMutation('removeNode', args, [args.uuid]);
            },
        },
        {
            name: 'scene_reparent_node',
            description: '调整当前场景节点的父节点；可选设置新的本地 position。',
            inputSchema: {
                type: 'object',
                properties: {
                    uuid: { type: 'string', description: '目标节点 uuid' },
                    parentUuid: { type: 'string', description: '新父节点 uuid' },
                    position: {
                        type: 'object',
                        properties: { x: { type: 'number' }, y: { type: 'number' }, z: { type: 'number' } },
                    },
                },
                required: ['uuid', 'parentUuid'],
            },
            handler: async function (args) {
                requireString(args, 'uuid');
                requireString(args, 'parentUuid');
                return await runSceneMutation('reparentNode', args, [args.uuid, args.parentUuid]);
            },
        },
        {
            name: 'scene_remove_component',
            description: '从当前场景节点移除指定组件。',
            inputSchema: {
                type: 'object',
                properties: {
                    uuid: { type: 'string', description: '目标节点 uuid' },
                    component: { type: 'string', description: '组件类名，如 cc.LabelOutline' },
                },
                required: ['uuid', 'component'],
            },
            handler: async function (args) {
                requireString(args, 'uuid');
                requireString(args, 'component');
                return await runSceneMutation('removeComponent', args, [args.uuid]);
            },
        },
        {
            name: 'scene_create_component',
            description: '为场景节点添加指定组件（如 cc.UISkew）',
            inputSchema: {
                type: 'object',
                properties: {
                    uuid: { type: 'string', description: '目标节点 uuid' },
                    component: { type: 'string', description: 'Cocos 组件类名，如 cc.UISkew' },
                },
                required: ['uuid', 'component'],
            },
            handler: async function (args) {
                var uuid = requireString(args, 'uuid');
                requireString(args, 'component');
                return await runSceneMutation('createComponent', args, [uuid]);
            },
        },
        {
            name: 'scene_set_property',
            description: '设置节点/组件属性。path 是 dump path（如 "position" 或 "__comps__.0.string"），dump 是 {type,value}。\n⚠️ 注意：若目的是修改 prefab 资源文件的属性，建议改用 prefab_edit（offline，不需要编辑器运行，直接读写 .prefab 文件，支持嵌套 prefab override）；scene_set_property 仅适用于修改运行时场景节点或需要编辑器上下文的场景。',
            inputSchema: {
                type: 'object',
                properties: {
                    uuid: { type: 'string' },
                    path: { type: 'string' },
                    dump: { type: 'object' },
                },
                required: ['uuid', 'path', 'dump'],
            },
            handler: async function (args) {
                if (!args || !args.dump || typeof args.dump !== 'object') throw new Error('dump is required');
                var uuid = requireString(args, 'uuid');
                var propertyPath = requireString(args, 'path');
                var beforeDump = await sceneRequest('query-node', uuid);
                if (!beforeDump) throw new Error('node not found: ' + uuid);
                var beforeEntry = readDumpPath(beforeDump, propertyPath);
                if (!beforeEntry.found) throw new Error('property path not found: ' + propertyPath);
                await sceneRequest('set-property', {
                    uuid: uuid,
                    path: propertyPath,
                    dump: args.dump,
                });
                var afterDump = await sceneRequest('query-node', uuid);
                if (!afterDump) throw new Error('node disappeared after set-property: ' + uuid);
                var afterEntry = readDumpPath(afterDump, propertyPath);
                if (!afterEntry.found) throw new Error('property path disappeared after mutation: ' + propertyPath);
                var before = unwrapDump(beforeEntry.value);
                var after = unwrapDump(afterEntry.value);
                var expected = unwrapDump(args.dump);
                if (!sameJson(after, expected)) {
                    throw new Error(
                        'set-property postcondition failed for ' + propertyPath +
                        ': expected ' + JSON.stringify(expected) + ', got ' + JSON.stringify(after)
                    );
                }
                return {
                    changed: !sameJson(before, after),
                    target: uuid,
                    path: propertyPath,
                    before: before,
                    after: after,
                };
            },
        },
        {
            name: 'scene_open_scene',
            description: '打开场景',
            inputSchema: {
                type: 'object',
                properties: { uuid: { type: 'string', description: '场景资源 uuid' } },
                required: ['uuid'],
            },
            handler: async function (args) {
                var uuid = requireString(args, 'uuid');
                var info = await msg('asset-db', 'query-asset-info', uuid);
                if (!info) throw new Error('scene asset not found: ' + uuid);
                if (info.type && info.type !== 'cc.SceneAsset') {
                    throw new Error('asset is not a cc.SceneAsset: ' + uuid + ' (' + info.type + ')');
                }
                return await sceneRequest('open-scene', uuid);
            },
        },
        {
            name: 'scene_save_scene',
            description: '保存当前场景',
            inputSchema: { type: 'object', properties: {} },
            handler: async function () {
                var current = await queryCurrentSceneAsset();
                if (!current.info) {
                    throw new Error('untitled scene cannot be saved through MCP; save it in Creator first');
                }
                return await sceneRequest('save-scene');
            },
        },
        {
            name: 'scene_soft_reload',
            description: '软重载场景（不清编辑器状态）',
            inputSchema: { type: 'object', properties: {} },
            handler: async function () {
                return await sceneRequest('soft-reload');
            },
        },
        {
            name: 'scene_execute_component_method',
            description: '调用指定组件 UUID 上的方法；会校验组件和方法存在，并通过 undo recording 执行。',
            inputSchema: {
                type: 'object',
                properties: {
                    uuid: { type: 'string' },
                    name: { type: 'string', description: '方法名' },
                    args: { type: 'array', items: {} },
                },
                required: ['uuid', 'name'],
            },
            handler: async function (args) {
                var uuid = requireString(args, 'uuid');
                requireString(args, 'name');
                if (args.args !== undefined && !Array.isArray(args.args)) throw new Error('args must be an array');
                return await runSceneMutation('executeComponentMethod', {
                    uuid: uuid,
                    name: args.name,
                    args: args.args || [],
                }, [uuid]);
            },
        },

        // ── asset-db 域 ──
        {
            name: 'asset_query_assets',
            description: '按 pattern 列出资源（glob，如 db://assets/**/*.prefab）',
            inputSchema: {
                type: 'object',
                properties: {
                    pattern: { type: 'string' },
                    ccType: { type: 'string', description: '可选：cc 类型过滤，如 cc.Prefab' },
                },
            },
            handler: async function (args) {
                var assets = await msg('asset-db', 'query-assets', {
                    pattern: args.pattern,
                    ccType: args.ccType,
                });
                return { assets: assets || [] };
            },
        },
        {
            name: 'asset_query_info',
            description: '按 url 或 uuid 查询资源元数据',
            inputSchema: {
                type: 'object',
                properties: {
                    urlOrUUID: { type: 'string' },
                },
                required: ['urlOrUUID'],
            },
            handler: async function (args) {
                var key = requireString(args, 'urlOrUUID');
                var info = await msg('asset-db', 'query-asset-info', key);
                if (!info) throw new Error('asset not found: ' + key);
                return info;
            },
        },
        {
            name: 'asset_query_url',
            description: '由 uuid 反查 url',
            inputSchema: {
                type: 'object',
                properties: { uuid: { type: 'string' } },
                required: ['uuid'],
            },
            handler: async function (args) {
                var uuid = requireString(args, 'uuid');
                var url = await msg('asset-db', 'query-url', uuid);
                if (!url) throw new Error('asset url not found for uuid: ' + uuid);
                return url;
            },
        },
        {
            name: 'asset_query_uuid',
            description: '由 url 反查 uuid',
            inputSchema: {
                type: 'object',
                properties: { url: { type: 'string' } },
                required: ['url'],
            },
            handler: async function (args) {
                var url = requireString(args, 'url');
                var uuid = await msg('asset-db', 'query-uuid', url);
                if (!uuid) throw new Error('asset uuid not found for url: ' + url);
                return uuid;
            },
        },
        {
            name: 'asset_refresh',
            description: '刷新资源（可指定子目录）',
            inputSchema: {
                type: 'object',
                properties: { url: { type: 'string', description: '默认 db://assets/' } },
            },
            handler: async function (args) {
                return await msg('asset-db', 'refresh-asset', args.url || 'db://assets/');
            },
        },
        {
            name: 'asset_reimport',
            description: '重新导入指定资源',
            inputSchema: {
                type: 'object',
                properties: { url: { type: 'string' } },
                required: ['url'],
            },
            handler: async function (args) {
                return await msg('asset-db', 'reimport-asset', args.url);
            },
        },
        {
            name: 'asset_create',
            description: '创建资源（文本内容）',
            inputSchema: {
                type: 'object',
                properties: {
                    url: { type: 'string' },
                    content: { type: 'string' },
                    overwrite: { type: 'boolean' },
                },
                required: ['url', 'content'],
            },
            handler: async function (args) {
                var url = requireString(args, 'url');
                if (typeof args.content !== 'string') throw new Error('content is required');
                var existing = await msg('asset-db', 'query-asset-info', url);
                if (existing && !args.overwrite) {
                    throw new Error('asset already exists: ' + url + '; pass overwrite=true to replace it');
                }
                var result = await msg('asset-db', 'create-asset', url, args.content, { overwrite: !!args.overwrite });
                var asset = await msg('asset-db', 'query-asset-info', url);
                if (!asset) throw new Error('asset create postcondition failed: ' + url);
                return { created: !existing, overwritten: !!existing, asset: asset || result };
            },
        },
        {
            name: 'asset_save',
            description: '保存已有资源内容',
            inputSchema: {
                type: 'object',
                properties: {
                    url: { type: 'string' },
                    content: { type: 'string' },
                },
                required: ['url', 'content'],
            },
            handler: async function (args) {
                return await msg('asset-db', 'save-asset', args.url, args.content);
            },
        },
        {
            name: 'asset_delete',
            description: '删除资源',
            inputSchema: {
                type: 'object',
                properties: { url: { type: 'string' } },
                required: ['url'],
            },
            handler: async function (args) {
                return await msg('asset-db', 'delete-asset', args.url);
            },
        },
        {
            name: 'asset_move',
            description: '移动资源',
            inputSchema: {
                type: 'object',
                properties: {
                    source: { type: 'string' },
                    target: { type: 'string' },
                },
                required: ['source', 'target'],
            },
            handler: async function (args) {
                return await msg('asset-db', 'move-asset', args.source, args.target);
            },
        },

        // ── preview 域 ──
        {
            name: 'preview_query_url',
            description: '查询当前预览地址',
            inputSchema: { type: 'object', properties: {} },
            handler: async function () {
                return { url: await local.getPreviewUrl() };
            },
        },
        {
            name: 'preview_refresh_and_reload',
            description: '一键：刷新资源 + 软重载场景',
            inputSchema: { type: 'object', properties: {} },
            handler: async function () {
                await local.doRefreshAssets();
                await local.doReloadScene();
                return 'ok';
            },
        },

        // ── local 域 ──
        {
            name: 'local_reload_package',
            description: 'reload（disable→enable）指定编辑器扩展，让其 JS 代码改动生效，无需重启编辑器。本质 Editor.Package.disable→enable，fire-and-forget 立即返回。',
            inputSchema: {
                type: 'object',
                properties: { name: { type: 'string', description: '扩展名（package.json 的 name，如 state-ctrl-gen）' } },
                required: ['name'],
            },
            handler: async function (args) {
                local.reloadPackage(args.name);
                return { ok: true, reloaded: args.name };
            },
        },
        {
            name: 'local_get_status',
            description: '获取插件本地状态（git 分支/HEAD、watchers、预览、命令日志）',
            inputSchema: { type: 'object', properties: {} },
            handler: async function () {
                return await local.getStatus();
            },
        },
        {
            name: 'local_list_worktrees',
            description: '扫描同机其他 worktree 的 dev-reload-info.json',
            inputSchema: { type: 'object', properties: {} },
            handler: async function () {
                return local.listWorktrees();
            },
        },
        {
            name: 'local_open_dev_dir',
            description: '在 Finder 打开 .dev 目录',
            inputSchema: { type: 'object', properties: {} },
            handler: async function () {
                return local.openDevDir();
            },
        },
        {
            name: 'local_clean_dev_dir',
            description: '清理 .dev 临时产物',
            inputSchema: { type: 'object', properties: {} },
            handler: async function () {
                return local.cleanDevDir();
            },
        },
        {
            name: 'meta_fix',
            description: '清理 Cocos 重启造成的图片 meta 噪音（保守，只还原能确认是破坏的）：① 纯 key 顺序/格式变化还原 git 原文；② 九宫格 border 被重置成 0 精准还原；③ trimType 从 none 被改成自动裁剪还原该 frame 到 git。靠 git 对比、正确处理中文路径。dryRun=true 只预览不写。',
            inputSchema: {
                type: 'object',
                properties: { dryRun: { type: 'boolean', description: 'true=只预览不写文件，列出将还原的 meta' } },
            },
            handler: async function (args) {
                return local.fixMeta({ dryRun: !!(args && args.dryRun) });
            },
        },
    ];
}

function defineResources(ctx) {
    var msg = ctx.msg;
    var local = ctx.local;
    return [
        {
            uri: 'cocos://project/info',
            name: 'Project Info',
            description: '项目路径、名称、引擎版本',
            mimeType: 'application/json',
            read: async function () {
                return await local.getStatus();
            },
        },
        {
            uri: 'cocos://scene/tree',
            name: 'Current Scene Tree',
            description: '当前场景节点树 dump',
            mimeType: 'application/json',
            read: async function () {
                return await msg('scene', 'query-node-tree');
            },
        },
        {
            uri: 'cocos://preview/url',
            name: 'Preview URL',
            description: '当前预览地址',
            mimeType: 'text/plain',
            read: async function () {
                return await local.getPreviewUrl();
            },
        },
    ];
}

module.exports = { defineTools: defineTools, defineResources: defineResources };
