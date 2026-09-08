'use strict';

var fs = require('fs');
var path = require('path');
var { execFile, execFileSync } = require('child_process');
var runtimeIdentity = require('./server/runtime-identity');
var packageReload = require('./server/package-reload');
var registry = require('./cli/src/runtime/registry');
var operationStore = require('./cli/src/runtime/operations').createStore();
var execution = require('./server/execution');
var storage = require('./cli/src/runtime/storage');
var _reloadEntry = null;

var _runtimeIdentity = runtimeIdentity.createRuntimeIdentity(__dirname);

var DEV_DIR = '.dev';

// 缓存预览地址
var _previewUrl = '';
// 定时刷新 dev-reload-info.json 的 interval handle
var _infoInterval = null;
// `.dev/refresh` 命令文件 watcher（唯一保留的 watcher）
var _refreshWatcher = null;
var _refreshDebounceTimer = null;

// dev-reload-info.json 输出路径（被 listWorktrees / getStatus / panel 读取，必须保留）
var INFO_FILE = '.dev/dev-reload-info.json';
// 信号文件：外部脚本写命令到此文件，插件读后执行（每行一条命令，读完清空）
var REFRESH_FILE = '.dev/refresh';
// 自定义按钮配置（用户可在 .dev/cc-mcp-panel.json 或旧名 .dev/dev-reload-panel.json 里维护）
var PANEL_CONFIG_FILE = '.dev/dev-reload-panel.json';

// 最近命令日志环形缓冲（供面板展示）
var _commandLog = [];
var COMMAND_LOG_MAX = 30;
function pushCommandLog(source, cmd) {
    _commandLog.push({ t: new Date().toISOString(), source: source, cmd: cmd });
    if (_commandLog.length > COMMAND_LOG_MAX) _commandLog.shift();
}

/**
 * 把当前预览状态写入 .dev/dev-reload-info.json。
 * 外部脚本（playwright/designer）通过此文件反查"本 worktree 对应哪个预览端口"。
 * 只在 previewUrl 已知时写入；previewUrl 为空则跳过，等待首次 getPreviewUrl 成功。
 * @param {string} previewUrl  已知的预览 URL（非空）
 */
function writeDevReloadInfo(previewUrl) {
    if (!previewUrl) return;
    var portMatch = previewUrl.match(/:(\d+)/);
    var previewPort = portMatch ? parseInt(portMatch[1], 10) : null;
    // 读取项目名（package.json name 字段）
    var projectName = '';
    try {
        var pkgPath = path.join(Editor.Project.path, 'package.json');
        if (fs.existsSync(pkgPath)) {
            var pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf-8'));
            projectName = pkg.name || '';
        }
    } catch (e) { /* ignore */ }
    var info = {
        projectPath: Editor.Project.path,
        projectName: projectName,
        editorPid: process.pid,
        editorVersion: (Editor.App && Editor.App.version) ? Editor.App.version : '',
        previewUrl: previewUrl,
        previewPort: previewPort,
        updatedAt: new Date().toISOString(),
    };
    try {
        var devDir = path.join(Editor.Project.path, DEV_DIR);
        if (!fs.existsSync(devDir)) {
            fs.mkdirSync(devDir, { recursive: true });
        }
        fs.writeFileSync(
            path.join(Editor.Project.path, INFO_FILE),
            JSON.stringify(info, null, 2),
            'utf-8'
        );
        log('dev-reload-info.json updated — port:' + (previewPort || 'null'));
    } catch (e) {
        console.warn('[dev-reload] writeDevReloadInfo failed:', e.message || e);
    }
}

/** 启动 30s 定时刷新，保持 updatedAt 活跃供外部 stale 检测 */
function startInfoInterval() {
    if (_infoInterval) clearInterval(_infoInterval);
    _infoInterval = setInterval(function () {
        if (_previewUrl) writeDevReloadInfo(_previewUrl);
        // 顺便刷 registry，让 router 判活
        if (typeof writeRegistry === 'function') writeRegistry();
    }, 30000);
}

/** 停止定时刷新 */
function stopInfoInterval() {
    if (_infoInterval) { clearInterval(_infoInterval); _infoInterval = null; }
}

function log(msg) {
    console.log('[dev-reload] ' + msg);
}

function getFilePath(filename) {
    return path.join(Editor.Project.path, filename);
}

/**
 * 获取当前编辑器预览地址。
 * 每次都重新向 preview 扩展查询，避免首次预览未启动时缓存旧值。
 * 成功拿到 URL 后才更新 _previewUrl 缓存（供 writeDevReloadInfo 等用）。
 */
async function getPreviewUrl() {
    try {
        // CC3.8.x preview 扩展正式消息名：query-preview-url（见 builtin/preview/package.json contributions.messages）
        var url = await Editor.Message.request('preview', 'query-preview-url');
        if (url && typeof url === 'string' && url.startsWith('http')) {
            // host 规范化为 loopback：编辑器用 os.networkInterfaces() 挑的网卡 IP，在多网卡 /
            // 切换网络（家↔公司）时会指向当前不通的网卡。本机访问统一走 127.0.0.1，预览 server
            // 监听 0.0.0.0，loopback 永远通且与网卡/环境无关。写信号文件、open、返回值都用它。
            url = url.replace(/^(https?:\/\/)[^:\/]+/, '$1127.0.0.1');
            if (url !== _previewUrl) {
                log('preview url updated: ' + url);
            }
            _previewUrl = url;
            return _previewUrl;
        }
    } catch (e) {
        // Editor.Message.request 失败（消息不存在、preview 扩展未启动等）必须打印，不能静默
        console.error('[dev-reload] getPreviewUrl: Editor.Message.request failed —', e && (e.stack || e.message) || e);
    }

    // 降级：如果已有缓存（上次成功查到的），直接复用
    if (_previewUrl) return _previewUrl;

    // 无缓存、无法从编辑器获取，返回未知标记而非错误的硬编码端口
    log('preview url: unable to query from editor — preview may not be running');
    return 'http://localhost:unknown-port';
}

function sleep(ms) {
    return new Promise(function (resolve) { setTimeout(resolve, ms); });
}

async function doReimport(url) {
    log('reimporting: ' + url);
    await Editor.Message.request('asset-db', 'reimport-asset', url);
    log('reimported: ' + url);
}

async function doRefreshAssets() {
    log('refreshing assets...');
    await Editor.Message.request('asset-db', 'refresh-asset', 'db://assets/');
    log('assets refreshed.');
}

async function doReloadScene() {
    log('reloading scene...');
    await Editor.Message.request('scene', 'soft-reload');
    log('scene reloaded.');
}

// ── 消息处理（支持从其他扩展或命令行调用） ──

exports.methods = {
    async refreshAssets() {
        await doRefreshAssets();
        await doReloadScene();
    },
    async queryPreviewUrl() {
        var url = await getPreviewUrl();
        // 顺便刷新 dev-reload-info.json，让外部脚本拿到最新端口
        writeDevReloadInfo(url);
        return url;
    },
    async openPanel() {
        await Editor.Panel.open('cocos-mcp');
    },
    async restartServer() {
        await stopMcpServer();
        await startMcpServer();
        return { port: _mcpServer ? _mcpServer.port : null };
    },
    async getMcpConfig() {
        if (!_mcpServer) return { running: false };
        var url = 'http://' + _mcpServer.host + ':' + _mcpServer.port + '/mcp';
        return {
            running: _mcpServer.started,
            url: url,
            port: _mcpServer.port,
            host: _mcpServer.host,
            toolCount: _mcpServer.toolCount,
            resourceCount: _mcpServer.resourceCount,
            stats: _mcpServer.stats,
            migrationRequired: true,
            connectionPolicy: 'Authenticated generation-bound Router only; old direct URL clients must migrate.',
            cliAddCommand: 'Use the verified local Router entry; do not configure an unauthenticated HTTP URL.',
            jsonConfig: null,
        };
    },
    /** Panel 使用：刷新资源 + 重载场景 */
    async triggerRefresh() {
        await doRefreshAssets();
        await doReloadScene();
        return true;
    },
    /** Panel 使用：重新导入指定 assetUrl */
    async triggerReimport(url) {
        if (!url) return false;
        await doReimport(url);
        return true;
    },
    /** Panel 使用：打开 .dev 目录 */
    async openDevDir() {
        var devDir = path.join(Editor.Project.path, DEV_DIR);
        if (!fs.existsSync(devDir)) fs.mkdirSync(devDir, { recursive: true });
        // 跨平台在系统文件管理器打开：mac=open / win=explorer / linux=xdg-open
        var opener = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'explorer' : 'xdg-open';
        await new Promise((resolve, reject) => execFile(opener, [devDir], error => error ? reject(error) : resolve()));
        return devDir;
    },
    /** Panel 使用：只做场景软重载 */
    async softReloadScene() {
        pushCommandLog('panel', 'reload-scene');
        await doReloadScene();
        return true;
    },
    /** Panel 使用：清理 .dev 临时产物（保留 dev-reload-info.json / dev-reload-panel.json / cc-mcp-panel.json） */
    cleanDevDir() {
        pushCommandLog('panel', 'clean-dev');
        var devDir = path.join(Editor.Project.path, DEV_DIR);
        var keep = { 'dev-reload-info.json': 1, 'dev-reload-panel.json': 1, 'cc-mcp-panel.json': 1 };
        var removed = [];
        try {
            var entries = fs.readdirSync(devDir);
            entries.forEach(function (name) {
                if (keep[name]) return;
                var full = path.join(devDir, name);
                try {
                    var st = fs.statSync(full);
                    if (st.isFile()) { fs.unlinkSync(full); removed.push(name); }
                } catch (e) { /* ignore */ }
            });
        } catch (e) { /* ignore */ }
        return removed;
    },
    /** Panel 使用：扫同机其他 worktree 的 dev-reload-info.json */
    listWorktrees() {
        var results = [];
        // 扫当前项目同级目录里其它含 .dev/dev-reload-info.json 的项目实例（不假设目录命名）
        var cur = Editor.Project.path;
        var roots = [];
        try {
            var siblingDir = path.dirname(cur);
            fs.readdirSync(siblingDir).forEach(function (name) {
                var p = path.join(siblingDir, name);
                if (p !== cur && fs.existsSync(path.join(p, '.dev', 'dev-reload-info.json'))) {
                    roots.push(p);
                }
            });
        } catch (e) { /* ignore */ }
        // 再扫 worktree：`git worktree list` 输出的路径
        try {
            var wtOut = execFileSync('git', ['-C', cur, 'worktree', 'list', '--porcelain'], { encoding: 'utf-8' });
            wtOut.split('\n').forEach(function (line) {
                if (line.indexOf('worktree ') === 0) {
                    var p = line.substring('worktree '.length).trim();
                    if (p && roots.indexOf(p) < 0) roots.push(p);
                }
            });
        } catch (e) { /* ignore */ }

        roots.forEach(function (root) {
            var candidates = [
                path.join(root, '.dev', 'dev-reload-info.json'),
            ];
            candidates.forEach(function (infoPath) {
                if (!fs.existsSync(infoPath)) return;
                try {
                    var info = JSON.parse(fs.readFileSync(infoPath, 'utf-8'));
                    var ageMs = Date.now() - new Date(info.updatedAt).getTime();
                    results.push({
                        projectPath: info.projectPath,
                        projectName: info.projectName,
                        previewPort: info.previewPort,
                        previewUrl: info.previewUrl,
                        editorPid: info.editorPid,
                        updatedAt: info.updatedAt,
                        staleSec: Math.floor(ageMs / 1000),
                        self: info.projectPath === Editor.Project.path,
                    });
                } catch (e) { /* ignore */ }
            });
        });
        return results;
    },
    /** Panel 使用：返回当前插件状态快照 */
    async getStatus() {
        var url = await getPreviewUrl();
        writeDevReloadInfo(url);
        var portMatch = url ? url.match(/:(\d+)/) : null;
        var infoPath = path.join(Editor.Project.path, INFO_FILE);
        var updatedAt = '';
        try {
            if (fs.existsSync(infoPath)) {
                var info = JSON.parse(fs.readFileSync(infoPath, 'utf-8'));
                updatedAt = info.updatedAt || '';
            }
        } catch (e) { /* ignore */ }
        // git 分支/commit
        var gitBranch = '', gitHead = '';
        try {
            gitBranch = execFileSync('git', ['-C', Editor.Project.path, 'rev-parse', '--abbrev-ref', 'HEAD'], { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
            gitHead = execFileSync('git', ['-C', Editor.Project.path, 'rev-parse', '--short', 'HEAD'], { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
        } catch (e) { /* ignore */ }
        return {
            previewUrl: url,
            previewPort: portMatch ? parseInt(portMatch[1], 10) : null,
            editorPid: process.pid,
            instanceId: _registration && _registration.instanceId,
            processIdentity: _registration && _registration.owner,
            editorVersion: (Editor.App && Editor.App.version) ? Editor.App.version : '',
            projectPath: _registration ? _registration.projectPath : Editor.Project.path,
            updatedAt: updatedAt,
            infoFile: INFO_FILE,
            watchers: {
                refresh: !!_refreshWatcher,
                infoInterval: !!_infoInterval,
            },
            gitBranch: gitBranch,
            gitHead: gitHead,
            extensionRuntime: Object.assign({}, _runtimeIdentity),
            commandLog: _commandLog.slice().reverse(),
            mcpServer: _mcpServer ? {
                running: _mcpServer.started,
                url: 'http://' + _mcpServer.host + ':' + _mcpServer.port + '/mcp',
                port: _mcpServer.port,
                toolCount: _mcpServer.toolCount,
                resourceCount: _mcpServer.resourceCount,
                stats: _mcpServer.stats,
            } : { running: false },
        };
    }
};

// ── MCP Server ──

var _mcpServer = null;
var _registration = null;
var MCP_DEFAULT_PORT = 7523;
var SDK_PATH = path.join(__dirname, 'mcp-sdk', 'index.js');

/**
 * 计算项目短名（MCP 工具名前缀，需能区分不同项目）。
 * 禁 worktree（cocos 不支持同一项目多 worktree 同开），故不再为 worktree 做 parent 启发式；
 * base 是常见通用名（client/game/app/src）时取 parent 段区分不同项目，否则直接用 base。
 */
function getProjectShortName() {
    var p = Editor.Project.path || '';
    var parent = path.basename(path.dirname(p));
    var base = path.basename(p);
    if (base === 'client' || base === 'game' || base === 'app' || base === 'src') {
        return parent || base;
    }
    return base;
}

/**
 * 解析 Cocos 编辑器主进程可执行路径，写进注册文件供 router 的 editor_restart 拉起用。
 * 取 process.argv[0] / process.execPath（编辑器主进程可执行，跨平台）。
 * 排除 Helper（渲染/GPU 子进程），解析不到返回空串。
 */
function getEditorExecPath() {
    var candidates = [];
    try { if (process.argv && process.argv[0]) candidates.push(process.argv[0]); } catch (e) { /* ignore */ }
    try { if (process.execPath) candidates.push(process.execPath); } catch (e) { /* ignore */ }
    for (var i = 0; i < candidates.length; i++) {
        var c = candidates[i];
        if (c && /CocosCreator/.test(c) && c.indexOf('Helper') < 0) {
            try { if (fs.existsSync(c)) return c; } catch (e) { /* ignore */ }
        }
    }
    return '';
}

function writeRegistry() {
    if (!_mcpServer || !_mcpServer.started) return;
    try {
        var entry = {
            pid: process.pid,
            projectPath: Editor.Project.path,
            projectShortName: getProjectShortName(),
            host: _mcpServer.host,
            port: _mcpServer.port,
            editorVersion: (Editor.App && Editor.App.version) ? Editor.App.version : '',
            execPath: getEditorExecPath(),
            startedAt: _mcpServer.stats.startedAt,
            updatedAt: new Date().toISOString(),
            sourceRealPath: _runtimeIdentity.sourceRealPath,
            sourceGitHead: _runtimeIdentity.sourceGitHead,
            sourceDirty: _runtimeIdentity.sourceDirty,
            runtimeBuildId: _runtimeIdentity.runtimeBuildId,
            toolSchemaHash: _runtimeIdentity.toolSchemaHash,
            loadedAt: _runtimeIdentity.loadedAt,
        };
        _registration.publish(entry);
    } catch (e) {
        console.warn('[cc-mcp] writeRegistry failed:', e.message || e);
    }
}

function removeRegistry() {
    try {
        if (_registration) _registration.remove();
    } catch (e) { /* ignore */ }
}

async function startMcpServer() {
    if (_mcpServer && _mcpServer.started) return;
    var sdk = require(SDK_PATH);

    // ── 使用 mcp-sdk ──────────────────────────────────────────────
    var tdef = require('./server/tools');
    _registration = registry.createRegistration(Editor.Project.path);
    var ctx = buildToolCtx();
    var toolDefs = execution.wrapTools(tdef.defineTools(ctx), _registration, operationStore);
    var resourceDefs = tdef.defineResources(ctx);
    _runtimeIdentity.toolSchemaHash = runtimeIdentity.hashToolSchemas(toolDefs);

    // 只计真实的工具调用 / 资源读取，不计 router 每 15s 的 initialize/tools-list 探活——
    // 否则计数永远在涨，无法用于判断「业务指令到没到编辑器」。
    // lastRequestAt/lastTool 是判活主信号（曾因 requestCount 初始化后无人自增、恒 0，被当成转发断裂误诊）。
    var stats = { startedAt: new Date().toISOString(), requestCount: 0, lastRequestAt: null, lastTool: null };
    function countCall(name, fn) {
        return function () {
            stats.requestCount++;
            stats.lastRequestAt = new Date().toISOString();
            stats.lastTool = name;
            return fn.apply(this, arguments);
        };
    }

    var server = sdk.createServer({
        name: 'cocos-mcp',
        version: '3.0.0',
        port: MCP_DEFAULT_PORT,
        bearerToken: _registration.token,
        allowedOrigins: [],
        maxBodyBytes: 8 * 1024 * 1024,
        tools: toolDefs.map(function (t) {
            return Object.assign({}, t, { handler: countCall(t.name, t.handler) });
        }),
        resources: resourceDefs.map(function (r) {
            return {
                uri: r.uri,
                name: r.name,
                description: r.description,
                mimeType: r.mimeType,
                read: countCall('resource:' + r.uri, r.read),
            };
        }),
    });

    // 启动 HTTP（cocos-mcp 只跑 HTTP，不跑 stdio）
    var started = await server.start('http');
    var port = started.port;
    _mcpServer = {
        started: true,
        host: '127.0.0.1',
        port: port,
        toolCount: toolDefs.length,
        resourceCount: resourceDefs.length,
        stats: stats,
        stop: function () { return server.stop(); },
    };
    writeRegistry();
    log('MCP server up (SDK) — http://127.0.0.1:' + port + '/mcp  (tools:' + toolDefs.length + ') shortName=' + getProjectShortName());
}

/**
 * 构建 tool/resource 的 ctx（共享给 SDK 和 fallback）
 */
function buildToolCtx() {
    return {
        msg: function (target, name /*, ...args */) {
            var args = Array.prototype.slice.call(arguments, 2);
            return Editor.Message.request.apply(Editor.Message, [target, name].concat(args));
        },
        local: {
            getPreviewUrl: getPreviewUrl,
            doReimport: doReimport,
            doRefreshAssets: doRefreshAssets,
            doReloadScene: doReloadScene,
            listWorktrees: function () { return exports.methods.listWorktrees(); },
            openDevDir: function () { return exports.methods.openDevDir(); },
            cleanDevDir: function () { return exports.methods.cleanDevDir(); },
            getStatus: function () { return exports.methods.getStatus(); },
            reloadPackage: doRestartSelf,
            fixMeta: function (opts) {
                var mod = require('./cli/src/editor/fix-meta.js');
                return mod.fixMeta(Editor.Project.path, opts || {});
            },
        },
    };
}

async function stopMcpServer() {
    if (!_mcpServer) return;
    if (_registration) _registration.active = false;
    removeRegistry();
    if (_mcpServer.stop) {
        try { await _mcpServer.stop(); } catch (e) { /* ignore */ }
    }
    _mcpServer = null;
}

// ── .dev/refresh 文件命令协议 ──

/**
 * 打开 prefab 到编辑器场景视图（等价于双击 prefab）。
 * @param {string} urlOrPath  db:// 路径 或 绝对路径
 */
async function doOpenPrefab(urlOrPath) {
    var dbUrl = urlOrPath;
    // 绝对路径 → 先通过 asset-db 反查 db:// url，再走统一路径
    if (!urlOrPath.startsWith('db://')) {
        var info = await Editor.Message.request('asset-db', 'query-asset-info', urlOrPath);
        if (!info || !info.url) throw new Error('open-prefab: cannot find db:// url for ' + urlOrPath);
        dbUrl = info.url;
    }
    var uuid = await Editor.Message.request('asset-db', 'query-uuid', dbUrl);
    if (!uuid) throw new Error('open-prefab: cannot resolve uuid for ' + dbUrl);
    await Editor.Message.request('asset-db', 'open-asset', uuid);
    log('open-prefab: opened ' + dbUrl + ' (uuid=' + uuid + ')');
}

/** 通过 Creator 自带的扩展管理器重新加载指定插件；name 缺省为本插件 cocos-mcp。
 *  HTTP 派发先返回非终态；实际执行上下文继续持锁，直至交接和新运行身份核验完成。
 *  不能只调用 Editor.Package.disable → enable：Creator 会复用旧的 CommonJS 模块对象，
 *  生命周期会重启，但改动后的 JS 与 loadedAt 不会更新。扩展管理器的 reload 消息会执行
 *  Creator 自己的完整刷新流程。
 */
async function doRestartSelf(name) {
    name = name || 'cocos-mcp';
    const entry = execution.currentExecution();
    if (!entry) throw new Error('Reload requires a claimed operation and project execution lock');
    const pkgPath = packageReload.resolvePackagePath(Editor.Package, name);
    const selfReload = fs.realpathSync(pkgPath) === fs.realpathSync(__dirname);
    const oldRegistration = _registration;
    const expected = selfReload ? runtimeIdentity.createRuntimeIdentity(__dirname) : null;
    const handoff = { packageName: name, packagePath: pkgPath, oldInstanceId: oldRegistration.instanceId,
        oldLoadedAt: _runtimeIdentity.loadedAt, expectedRuntime: expected };
    storage.publish(path.join(entry.directory, 'handoff.json'), handoff);
    if (selfReload) _reloadEntry = entry;
    packageReload.purgePackageRequireCache(pkgPath);
    await Editor.Message.request('extension', 'reload', pkgPath);
    if (!selfReload) return { packageName: name, completionEvidence: 'Extension Manager reload request completed' };
    const stopped = storage.read(path.join(entry.directory, 'service-stopped.json'));
    if (!stopped || stopped.instanceId !== oldRegistration.instanceId) throw new Error('Old service stop handoff is missing');
    const next = registry.readRegistry().filter(record => record.projectPath === oldRegistration.projectPath &&
        record.instanceId !== oldRegistration.instanceId && record.pid === oldRegistration.owner.pid &&
        record.processIdentity.startId === oldRegistration.owner.startId);
    if (next.length !== 1) throw new Error('New service generation cannot be uniquely verified');
    const fresh = next[0];
    const client = require('./cli/src/runtime/http-client').createClient(fresh);
    const response = await client.request('tools/call', { name: 'local_get_status', arguments: { _target: client.target } });
    if (!response.result || response.result.isError) throw new Error('New service identity query failed');
    const status = response.result.structuredContent || JSON.parse(response.result.content[0].text);
    const actual = status.extensionRuntime;
    if (status.instanceId !== fresh.instanceId || !actual || actual.loadedAt === handoff.oldLoadedAt ||
        actual.runtimeBuildId !== expected.runtimeBuildId || actual.sourceRealPath !== expected.sourceRealPath ||
        actual.sourceGitHead !== expected.sourceGitHead || actual.toolSchemaHash !== fresh.toolSchemaHash) {
        throw new Error('Reload runtime/schema identity has not been verified');
    }
    storage.publish(path.join(entry.directory, 'handoff-completed.json'), { oldInstanceId: oldRegistration.instanceId,
        newInstanceId: fresh.instanceId, runtime: actual, processIdentity: fresh.processIdentity });
    return { instanceId: fresh.instanceId, runtime: actual, completionEvidence: 'Old service stopped and new authenticated runtime verified' };
}

/**
 * 分发单条 refresh 命令。
 *
 * 协议：`restart-package [name]`（disable→enable 指定扩展让 JS 改动生效；缺省 name 重启本插件自身）。
 * 资源刷新 / 场景重载 / 预览刷新 / 截图等走 MCP tool（preview_refresh_and_reload /
 * asset_reimport 等）或面板按钮，不再通过文件协议触发。
 */
async function handleRefreshCommand(cmd) {
    if (!cmd) return;
    let request;
    try { request = JSON.parse(cmd); } catch (_) { throw new Error('MIGRATION_REQUIRED: refresh commands must be JSON with operationId, _target and name; legacy text commands cannot write'); }
    const definition = execution.wrapTools(require('./server/tools').defineTools(buildToolCtx()), _registration, operationStore)
        .find(tool => tool.name === 'local_reload_package');
    const invalid = require('./mcp-sdk/protocol/dispatcher').validateArguments(definition.inputSchema, request);
    if (invalid) throw new Error('INVALID_ARGUMENTS: ' + invalid);
    const response = await definition.handler(request);
    if (response.isError) console.error('[refresh]', JSON.stringify(response.structuredContent));
    else pushCommandLog('refresh', 'operation ' + request.operationId);
}

/** 启动 .dev/refresh 文件 watcher（写入命令 → 读取 → 执行 → 清空） */
function startRefreshWatcher() {
    if (_refreshWatcher) return;
    var filePath = path.join(Editor.Project.path, REFRESH_FILE);
    // 确保文件存在，供 fs.watch 注册
    if (!fs.existsSync(filePath)) {
        try { fs.writeFileSync(filePath, '', 'utf-8'); } catch (e) { /* ignore */ }
    }
    try {
        _refreshWatcher = fs.watch(filePath, function (event) {
            if (event !== 'change' && event !== 'rename') return;
            // debounce：macOS 下单次 write 可能触发多次事件
            clearTimeout(_refreshDebounceTimer);
            _refreshDebounceTimer = setTimeout(function () {
                var content = '';
                try { content = fs.readFileSync(filePath, 'utf-8').trim(); } catch (e) { return; }
                if (!content) return;
                // 清空信号文件，防止重复执行
                try { fs.writeFileSync(filePath, '', 'utf-8'); } catch (e) { /* ignore */ }
                var lines = content.split('\n');
                // 逐条串行执行（前一条完成再执行下一条）
                lines.reduce(function (chain, line) {
                    return chain.then(function () { return handleRefreshCommand(line.trim()); });
                }, Promise.resolve()).catch(function (error) { console.error('[refresh] ' + error.message); });
            }, 80);
        });
        log('refresh watcher started → ' + REFRESH_FILE);
    } catch (e) {
        console.error('[dev-reload] startRefreshWatcher failed:', e && (e.stack || e.message) || e);
    }
}

/** 停止 .dev/refresh 文件 watcher */
function stopRefreshWatcher() {
    clearTimeout(_refreshDebounceTimer);
    _refreshDebounceTimer = null;
    if (_refreshWatcher) { try { _refreshWatcher.close(); } catch (e) { /* ignore */ } _refreshWatcher = null; }
}

// Panel and Editor.Message entry points use the same executor; nested tool calls keep their execution context.
['refreshAssets', 'triggerRefresh', 'triggerReimport', 'softReloadScene', 'cleanDevDir', 'restartServer', 'openDevDir'].forEach(function (name) {
    const handler = exports.methods[name];
    exports.methods[name] = function () {
        if (!_registration) throw new Error('MCP service identity is unavailable; write operation rejected');
        const args = Array.from(arguments);
        return execution.runLocal('panel_' + name, _registration, operationStore, () => handler.apply(this, args), { args });
    };
});

// ── 插件生命周期 ──

exports.load = async function () {
    // 确保 .dev 目录存在
    var devDir = path.join(Editor.Project.path, DEV_DIR);
    if (!fs.existsSync(devDir)) {
        fs.mkdirSync(devDir, { recursive: true });
    }
    log('loaded');
    // 启动 .dev/refresh 文件 watcher
    startRefreshWatcher();
    // 异步拿预览地址，写 dev-reload-info.json，启动定时刷新
    getPreviewUrl().then(function(url) {
        if (url) writeDevReloadInfo(url);
        startInfoInterval();
    }).catch(function(e) {
        console.error('[dev-reload] load: getPreviewUrl failed —', e && (e.stack || e.message) || e);
        startInfoInterval();
    });
    // 启动 MCP server（失败打完整栈，不阻断扩展 load）
    await startMcpServer().catch(function(e) {
        console.error('[cc-mcp] MCP server failed to start:', e && (e.stack || e.message) || e);
    });
};

exports.unload = async function () {
    stopRefreshWatcher();
    stopInfoInterval();
    await stopMcpServer();
    if (_reloadEntry) storage.publish(path.join(_reloadEntry.directory, 'service-stopped.json'), {
        instanceId: _registration.instanceId, owner: _registration.owner, stoppedAt: new Date().toISOString() });
    log('unloaded');
};
