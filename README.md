# cocos-mcp

Cocos Creator 3.8.x 的 MCP 桥接扩展 + 离线 prefab / AnimationClip 工具。

把编辑器的 scene/asset/preview/local 能力以 MCP 协议暴露给 Claude Code；同时提供无需编辑器运行的 offline prefab 编辑，以及 AnimationClip 查询和数值曲线创建能力。

## 版本状态

- 本源码版本为 `v3.0.0`，包含身份、认证、操作追踪与事务的破坏性契约变更；升级前先读 [执行与迁移契约](./doc/execution-contract.md)。
- 正式发布状态以对应 tag、GitHub Release 与已验证制品为准；工作树版本号不能替代发布或运行身份校验，旧版本的历史证据不覆盖本版本。
- 历史 `test/*` 分支和 `*-test.*` tag 只保留实验记录，不作为稳定发布使用。

---

## 文档导航

| 文档 | 内容 | 阅读时机 |
|---|---|---|
| [`CHANGELOG.md`](./CHANGELOG.md) | 已发布和未发布的用户可见变化 | 判断升级影响时 |
| [`RELEASING.md`](./RELEASING.md) | SemVer、制品、验证、tag 与发布规范 | 准备正式版本时 |
| [`AGENTS.md`](./AGENTS.md) | **Agent 使用规则**：精确实例绑定、认证、未知结果和 CLI/MCP 分工 | agent 使用本插件前 |
| [`doc/execution-contract.md`](./doc/execution-contract.md) | 操作 ID、互斥、离线事务、恢复与客户端迁移 | 修改资源或迁移客户端前 |
| [`QUICK-REF.md`](./QUICK-REF.md) | **一页速查表**：节点定位三式、场景 → op 对照、ops.json 速记、踩坑表 | agent 起手第一份，挑不到再翻 cli.md |
| [`doc/cli.md`](./doc/cli.md) | **CLI 完整手册**：命令、35 个 op 全表、配方、已知坑、源码导航 | 改 `.prefab` / `.anim` 文件前必读 |
| [`doc/prefab-schema.md`](./doc/prefab-schema.md) | CC3 prefab JSON 结构速查（节点 / 组件 / 引用字段格式） | 看不懂 prefab 字段时查 |
| [`doc/nested-prefab-protocol.md`](./doc/nested-prefab-protocol.md) | `cc.TargetOverrideInfo` 协议（跨 nested @property 挂载） | 调试 set-component-ref 跨 stub 失败时 |
| [`doc/prefab-direct-edit.md`](./doc/prefab-direct-edit.md) | offline CLI vs 编辑器路径决策表 | 不确定该用 CLI 还是 scene_set_property 时 |
| [`doc/anim-schema.md`](./doc/anim-schema.md) | `.anim` 文件结构 + Track 字段规范 | 改动画文件结构时 |

---

## 架构

```
Claude Code (MCP client)
        │  stdio (JSON-RPC)
        ▼
┌─────────────────────────────┐
│  router/bin.js              │  ← 统一入口，聚合多个编辑器
│  - 扫 ~/.cocos-mcp/editors/ │
│  - offline resource tools   │
└───────────┬─────────────────┘
            │  HTTP MCP (JSON-RPC)
    ┌───────┴────────┐
    │                │
    ▼                ▼
编辑器实例 A      编辑器实例 B       ← 每个项目一个编辑器进程
main.js + server/tools.js         ← HTTP MCP 生命周期 + tool/resource 定义
```

offline resource tools 在 router 进程内调用 `cli/src/index.js`：查询和预演允许在线，正式写入要求目标 Creator 关闭：

- prefab：`prefab_query` / `prefab_edit` / `prefab_batch`
- AnimationClip：`animation_query` / `animation_create`

---

## 三个组件

### 1. 编辑器扩展（`main.js` + panel + server）

在 Cocos Creator 进程内运行。`main.js` 使用 `mcp-sdk` 启动仅本机、需认证的 HTTP Server；实例身份和私有凭据写入按进程启动身份摘要与 `instanceId` 隔离的注册文件。每次服务重启或扩展重载都产生新实例。

**暴露的 tool 域**：

| 域 | 职责 |
|---|---|
| scene | 查询/修改节点树，打开/保存/重载场景，调用组件方法 |
| asset-db | 资源查询、导入、创建、保存、删除、移动 |
| preview | 预览地址查询、浏览器控制、截图、JS 注入 |
| local / maintenance | 本地状态、worktree、.dev、扩展 reload 与 Git 对比型 meta 修复 |

### 2. stdio router（`router/`）

入口：`router/bin.js`

**职责**：

- 扫描私有注册目录并通过进程启动身份、认证和实际 runtime 核验活实例；心跳时间不授权执行，也不单独证明死亡
- 每隔 15s 自动发现新实例
- 给每个编辑器的 tool 加 `<shortName>__` 前缀，合并后暴露给 Claude Code
- 全局分配展示别名，按完整工具名精确映射；调用同时校验 `_target`，不按前缀猜实例
- 内置 offline prefab 与 AnimationClip tools，不带前缀，全局可用

**tool 路由示例**：

```
forest__scene_query_node_tree  →  forest 编辑器的 HTTP MCP server
another__asset_query_assets    →  another 编辑器的 HTTP MCP server
prefab_query                   →  router 本地执行（cli），无需编辑器
```

### 3. cocos-mcp-cli（`cli/`）

零新增依赖 Node CLI，通过共享事务核心读写资源；正式写入需要 operationId、项目内路径及已关闭的 Creator。详见 [`doc/cli.md`](./doc/cli.md)。

---

## 功能面板

通过菜单「扩展 → Cocos MCP → 功能面板」打开，或在编辑器扩展面板停靠。

| 区块 | 内容 |
|---|---|
| MCP Server | 运行状态指示灯 / 端点地址 / tool 数量 / 请求计数；复制端点、复制 CLI 命令、重启 |
| 编辑器状态 | 当前分支 / HEAD / 预览地址和端口 / 编辑器 PID / Watcher 状态 / 最后更新时间 |
| 快捷动作 | 一键刷新（资源+场景+预览）/ 软重载场景 / 打开预览浏览器 / 截图 / 打开 .dev 目录 / 清理临时文件 / 手动输入路径重新导入 |
| Debug 注入 | 在预览页面执行任意 JS（`eval_js`），结果直接展示；自定义快捷按钮（配置见下方） |
| 同机 Worktree | 列出同机其他 worktree 及其预览端口，方便多开切换 |
| 命令日志 | 最近 30 条操作记录（时间 / 来源 / 命令） |

**自定义 Debug 按钮**：在项目根目录新建 `.dev/cc-mcp-panel.json`：

```json
{ "buttons": [{ "label": "解锁签到", "code": "app.userMod.setUserValue(0,1)" }] }
```

---

## Tools 清单

### scene 域（需编辑器运行）

| Tool | 说明 |
|---|---|
| `scene_query_node_tree` | 查询当前场景节点树；传 uuid 查子树 |
| `scene_query_node` | 查询单节点完整 dump（含所有组件属性） |
| `scene_add_node` | 在指定父节点下创建场景节点 |
| `scene_instantiate_prefab` | 通过 Prefab 资源 UUID 在指定父节点下创建实例，并保留 Prefab 关联 |
| `scene_clone_node` | 复制场景节点树到指定父节点下 |
| `scene_reparent_node` | 调整场景节点父级 |
| `scene_remove_node` | 删除场景节点及其子树 |
| `scene_create_component` | 为场景节点添加组件 |
| `scene_remove_component` | 移除场景节点组件 |
| `scene_set_property` | 设置节点/组件属性（path 为 dump path，如 `position`、`__comps__.0.string`） |
| `scene_open_scene` | 打开场景（传场景资源 uuid） |
| `scene_save_scene` | 保存当前场景 |
| `scene_soft_reload` | 软重载场景，不清编辑器状态 |
| `scene_execute_component_method` | 通过组件 UUID 调用组件方法；无效组件、方法或 args 会返回错误 |

> 修改 prefab 资源文件属性建议用 `prefab_edit`（offline），`scene_set_property` 只适用于运行时节点或需要编辑器上下文的情况。
>
> `scene_execute_component_method.uuid` 必须使用 `scene_query_node` 返回的组件 dump 中的 UUID，不是节点 UUID。

### asset-db 域（需编辑器运行）

| Tool | 说明 |
|---|---|
| `asset_query_assets` | 按 glob pattern 列资源；可用 `offset` / `limit` 分页，并用 `fields` 投影顶层字段 |
| `asset_query_info` | 查资源详情（传 uuid 或 url） |
| `asset_query_url` | 由 uuid 查资源 url |
| `asset_query_uuid` | 由 url 查资源 uuid |
| `asset_refresh` | 刷新资源（全量或指定路径） |
| `asset_reimport` | 重新导入指定资源 |
| `asset_create` | 创建新资源 |
| `asset_save` | 保存资源内容 |
| `asset_delete` | 通过 Creator AssetDB 删除资源；Creator 拒绝删除时返回 tool error |
| `asset_move` | 移动/重命名资源 |

`asset_query_assets` 的兼容策略是 opt-in 分页：省略 `offset` / `limit` 时，`assets` 仍包含全部匹配项；响应同时给出 `total`、`offset`、`limit`、`hasMore` 和 `nextOffset`。`fields` 只保留每项指定的顶层字段。大工程应主动分页，因为不传参数仍可能产生大响应。

### preview 域（需编辑器运行）

| Tool | 说明 |
|---|---|
| `preview_query_url` | 查询当前预览 URL |
| `preview_refresh_and_reload` | 重新导入资源后刷新预览（offline 改完必须调此工具才能看到效果） |

预览页面截图、点击、JS 执行等浏览器交互不由本扩展注册 preview tool，agent 应先用 `preview_query_url` 获取当前 URL，再交给 Playwright / Chrome 验证真实页面。

### local / maintenance 域（需编辑器运行）

| Tool | 说明 |
|---|---|
| `local_get_status` | 获取编辑器本地状态（git branch、预览端口、PID 等） |
| `local_list_worktrees` | 列出同机所有 worktree |
| `local_open_dev_dir` | 在 Finder 中打开 .dev 目录 |
| `local_clean_dev_dir` | 清理 .dev 临时文件 |
| `local_reload_package` | 调度后返回 running／scheduled；交接、旧服务停止和新实例实际 identity 核验后才结案 |
| `local_operation_status` | 查询指定历史操作；省略 ID 列出未解决项 |
| `meta_fix` | Editor 内只预览图片 `.meta` 修复；正式修复使用关闭 Creator 后的 CLI |

### offline 域（router 级，无需编辑器运行）

| Tool | 说明 |
|---|---|
| `prefab_query` | 查询 tree、node、find、field 或 overrides；tree/node 支持 `withComps` |
| `prefab_edit` | 纯规划后事务提交资源与 `.meta`；`dryRun` 默认 false，正式执行需要 operationId |
| `prefab_batch` | 从 JSON 文件读取 ops 后批量编辑 prefab |
| `animation_query` | 查询 AnimationClip 的标准化轨道、通道、关键帧与只读 `events` 结构；无事件时返回空数组 |
| `animation_create` | 创建 `UntypedTrack + RealCurve` 数值曲线 AnimationClip；拒绝覆盖已有文件 |
| `offline_recover` | 指定事务的恢复，默认预演；实际恢复需要新恢复操作 ID 和已关闭的 Creator |

完整 op 列表与配方见 [`doc/cli.md`](./doc/cli.md)。

> offline tools 的 `filePath` 和 `opsJsonPath` 必须为绝对路径；router 以 stdio 模式运行，cwd 不确定，相对路径有歧义。

### router / editor-control 域（无需编辑器内 server）

| Tool | 说明 |
|---|---|
| `router_list_editors` | 列出实例、真实项目、进程启动身份及 runtime identity，不输出凭据 |
| `operation_status` | 查询单项历史操作，省略 ID 时列出未解决项 |
| `operation_reconcile` | 机器核验停止后追加调用方处置；不改资源、不替代事务恢复 |
| `editor_wait_ready` | 分层等待 process、registry、MCP 与 AssetDB API；`runtimeHealth` 当前明确为 `not_checked` |
| `editor_spawn` | 在项目尚未运行时启动 Creator，与其他受控写入共享项目执行锁 |
| `editor_restart` | 关闭并重新启动指定 Creator，然后等待分层就绪 |
| `editor_kill` | 关闭准确归属的 Creator；每代服务只清理自己的注册文件，未知归属记录保留 |

---

## 多开支持

每代服务发布私有、带格式版本的注册记录。Router 公开结果示意如下；认证信息不包含在内：

```json
{
  "pid": 12345,
  "instanceId": "<service-generation-uuid>",
  "processIdentity": { "pid": 12345, "startId": "<os-process-start-identity>" },
  "shortName": "forest",
  "projectPath": "/path/to/project",
  "sourceRealPath": "/path/to/cocos-mcp",
  "sourceGitHead": "<full-git-head>",
  "sourceDirty": false,
  "runtimeBuildId": "<runtime-source-hash>",
  "toolSchemaHash": "<tool-schema-hash>",
  "loadedAt": "<iso-timestamp>"
}
```

HTTP Server 在 loopback 成功 bind 后才发布实际 endpoint；端口竞争会重试。Router 单次扫描、核验后原子发布完整快照，按完整对外定义计算 schema hash。心跳只作诊断，不能授权路由、证明死亡或解除锁。资源 URI 使用 instanceId，不依赖展示别名。

调用前检查 `_target`、副作用 operationId 以及声明的参数规则；格式／协议错误与业务工具错误分开。所有成功、控制和非终态结果都遵守 [执行契约](./doc/execution-contract.md)，不能把 HTTP 200 或 `isError:false` 单独当作操作完成。

---

## 接入 Claude Code

> ⚠️ 本仓库通过 git submodule 依赖 [universal-mcp-sdk](https://github.com/dekaic/universal-mcp-sdk)，clone 后**必须先拉 submodule**，否则 MCP server 起不来：
>
> ```bash
> git submodule update --init --recursive
> ```

正式 GitHub Release 应提供已嵌入 SDK 的自包含 ZIP、manifest 与 SHA-256；从源码分支或 GitHub source archive 安装时仍必须按上面步骤初始化 submodule。制品与校验规则见 [`RELEASING.md`](./RELEASING.md)。

```bash
claude mcp add cocos -- node /path/to/cocos-mcp/router/bin.js
```

接入后 Claude Code 即可调用所有活跃编辑器的 tool，以及全局 offline prefab 与 AnimationClip tools。

---

## `.dev/refresh` 信号协议

旧的无身份文本信号已拒绝。文件入口只接受带准确 `_target`、operationId 和工具 arguments 的 JSON 请求，进入与 MCP 相同的执行包装器；不能借文件或面板绕开冻结。优先使用 MCP，并查询持久化操作结果。

面板「重启 MCP Server」产生新 instanceId，但不清 Node 模块缓存，不能证明源码重载。`local_reload_package` 的 scheduled 只代表调度；交接与新运行身份核验完成前操作保持非终态。修改 Router 或其加载的 CLI 后，还必须单独重启 stdio Router。

---

## 已知限制

1. **多层嵌套组件引用**：CLI 已通过 `refSubNode` 字符串数组路径支持。极端深嵌套场景仍建议走 tools pipeline（`tools/step-3-script/bind-prefab-components.ts`）
2. **离线提交工作流**：关闭 Creator → 正式事务写入 → 重开 → 重新绑定实例 → 验证导入与预览；不允许保留旧编辑器内存同时进行离线正式写入
3. **分页为兼容性 opt-in**：`asset_query_assets` 省略 `limit` 时仍返回全部匹配项；分页减少 MCP wire payload，但 Cocos AssetDB 仍先产生完整匹配数组
4. **恢复边界**：不保证任意 Creator 工作跨崩溃恰好执行一次；unknown 冻结普通写入，资源恢复默认预演且不得覆盖检测到的外部修改
5. **平台边界**：身份、权限和持久化能力需分别验证；缺少可靠机制时危险操作拒绝，不提供 PID-only、免认证或普通覆盖回退

---

## 反馈

使用本扩展（MCP tool / offline CLI）时遇到 bug、行为异常或文档与实际不符，agent 必须把问题反馈给用户，由用户决定是否修复扩展本身，不要在调用方加 workaround 绕过。
