# 执行、迁移与恢复契约（v3.0.0）

本文描述 v3.0.0 的接口与保证，不是发布或跨平台验收证明。正式身份以准确 release commit、manifest、制品哈希和实际运行 identity 为准。旧发布证据不证明本版本已通过实机验收。

## 目标绑定与认证

1. 使用同一来源的 Router、Editor 扩展与 CLI。普通项目使用已校验的稳定制品；Lab 候选必须使用明确的同一源码工作树，不能混用全局 stable。
2. `router_list_editors` 列出真实绝对 `projectPath`、进程启动身份、`instanceId` 和实际加载的 source/runtime/schema identity，不输出凭据。旧格式、损坏或失效注册另附迁移／诊断信息，不删除来历不明的记录。
3. 通过 `tools/list` 的完整工具名调用；`_meta.cocosMcp` 提供该工具的底层工具名与当前目标。前缀只是展示名，不能推断身份。所有 Editor 工具均带 `_target: { projectPath, instanceId }`。
4. `instanceId` 在每次 HTTP 服务启动或扩展重载时改变，即使 PID、项目和端口没变。历史操作始终归属原始目标，不能换成新实例重放。
5. 生命周期按项目与实例选择；未注册的启动进程必须同时提供项目、PID 和进程启动身份。冲突、歧义、PID 复用或 stale 都拒绝。`editor_restart` 不会退化为 spawn。

私有注册文件名为 `<进程启动身份摘要>-<instanceId>.json`，不再复用 `<pid>.json`。每代服务只维护自己的文件。凭据每代重新生成，只存在于私有注册和认证客户端内存，不进入公开列表、操作记录、日志、URL 或命令行。

启动就绪等待中的 `PROCESS_IDENTITY_UNAVAILABLE` 只触发现有期限内的只读重新采样；不会重新启动进程、换操作 ID、释放锁或把采样失败当成退出。每轮重新核对身份、认证服务和 AssetDB，旧轮次的 ready 标记不能沿用。持续无法核验时，已派发的启动保持 unknown；查询原操作，按停止证据规则处置。危险操作准入仍立即拒绝无法核验的进程身份，不从就绪等待借用重试或 PID-only 权限。进程采样错误仅保留错误码、退出码和信号等诊断，不保存子进程原始输出。

## HTTP 协议

Product 只支持本机 HTTP。自建客户端复用 `cli/src/runtime/http-client.js` 的认证与初始化流程；不能从公开列表中取一个旧 `url` 就直接 POST。

| 条件 | 结果 |
|---|---|
| 非 loopback Host／endpoint，任意 Origin（含 `null`） | handler 前拒绝 |
| bearer 缺失或错误 | handler 前拒绝，无免认证回退 |
| 已认证 `GET /mcp`、`OPTIONS /mcp` | `405`；无伪 SSE、无 CORS 豁免 |
| 健康检查 | 独立、需认证的 `GET /health` |
| POST | JSON Content-Type；Accept 包含 JSON 与 event-stream；声明及实际 body 上限 8 MiB |
| 初始化 | `initialize` 协商版本并取得会话 ID，然后发送 `notifications/initialized`；后续请求携带会话与协商协议头 |
| `2025-03-26` | 按该版本处理 batch |
| `2025-06-18` | 拒绝 batch，一次 POST 一条 MCP 消息 |
| tools 变化 | Editor HTTP 不虚报推送能力；Router 原子更新发现快照后可通过 stdio 通知 |

`initialize` 在两个版本中都不能放入 batch；03-26 支持批量消息不取消这一生命周期约束。SDK 与 Router 的 stdio 同样执行初始化规则。

03-26 batch 只含一层独立消息；嵌套数组项返回 `-32600` 且不派发其中的工具，合法兄弟请求仍独立处理。合法通知不生成响应，包括未知通知或通知 handler 失败；纯通知的 HTTP POST 为 202 空 body。初始化能力字段必须为对象，数组不能建立会话。上述限制不拒绝工具 arguments 内正常的业务数组或合法 `_meta`。

JSON-RPC／MCP envelope 按协议校验；工具 arguments 的未知业务字段才按工具 schema 拒绝。合法 envelope `_meta` 不因此被拒绝。输入校验支持本产品声明所用的 schema 规则，不宣称通用完整 JSON Schema 引擎。

协议依据：[生命周期](https://modelcontextprotocol.io/specification/2025-06-18/basic/lifecycle)、[03-26 传输](https://modelcontextprotocol.io/specification/2025-03-26/basic/transports)、[06-18 传输](https://modelcontextprotocol.io/specification/2025-06-18/basic/transports)。

## 操作身份与结果

资源、场景和生命周期副作用调用必须带 `operationId`。纯查询与预演不强制；离线预演显式给 ID 时会记录该次预演，正式执行必须使用另一个 ID。

同项目同 ID 的原始请求以底层工具名、原始目标、规范化业务输入及文件输入摘要确定指纹。展示别名、地址、凭据、JSON-RPC ID 和内部交付字段不参与指纹；可变的目标资源当前状态也不参与。不同目标、参数或 dryRun 模式复用 ID 会得到 `OPERATION_ID_CONFLICT`。

认证／格式检查 → 原子登记或读取原请求 → 同指纹返回原状态 → 仅首次交付核验目标／门禁／执行锁 → 再核验 → 原子认领 → 执行。重复请求先于 stale／busy 拦截处理，不会重放原操作。

Router 只记录提交与传输观测，执行方写开始和后果，核验入口追加处置结论。迟到超时不能覆盖已确认的执行终态。HTTP 断连、Router 退出不取消 Editor 工作，也不释放 Editor 持有的锁。

| 结果 | 调用方处理 |
|---|---|
| `submitted`／`running` | 尚未完成；查询同一 ID，不换 ID 重试修改 |
| `succeeded` | 使用原成功业务 payload，操作上下文在 `_meta.cocosMcp` |
| `failed` | 执行已确认结束且后果明确；检查失败事实与已知资源后果 |
| `unknown` | 结果未知，不等于失败；停止普通修改，查询／核验原操作 |
| stale／busy／冻结／ID 冲突 | 工具错误，按明确原因处置，不隐式换目标或绕过门禁 |

控制分支统一放在 `structuredContent.cocosMcpControl`，人可读 `content` 同步说明状态、操作 ID 与下一步。running/submitted 的 `isError:false` 不表示完成；unknown 和控制错误为 `isError:true`。声明的输出 schema 同时覆盖成功和控制分支，不丢弃原业务 payload。[MCP tools 结果规范](https://modelcontextprotocol.io/specification/2025-06-18/server/tools)

SDK handler 同时返回 `structuredContent` 和额外业务字段时，额外字段保留为独立文本 `content` 项，未提供 `content` 时也不丢弃；不将它们合并进已声明的结构化结果。原 `structuredContent`、`_meta`、`isError` 和输出 schema 保持不变，业务字段中的 false、0、null 不被当作缺失。

`operation_status(projectPath, operationId?)` 查询指定历史操作；省略 ID 只列未解决项。Editor 对应入口为 `<前缀>__local_operation_status`（以实际 tools/list 为准），需绑定当前实例；查询内容仍保留旧操作的原始目标。

## 执行权与冻结

共享实现位于可分发的 `cli/src/runtime/`。没有新增数据库或守护进程。项目真实路径是互斥键；锁归属由操作、随机 owner token 和进程启动身份组成，同 PID 不允许重入。

| 写入路径 | 锁持有者 |
|---|---|
| 场景、组件、AssetDB | Editor 统一执行包装器 |
| 离线资源提交／恢复 | CLI／离线核心 |
| spawn／restart／kill、CLI open／build | 生命周期执行模块 |
| Router 普通转发 | 不重复获取执行锁 |

打开场景、刷新、重导和重载都是副作用。未知工具不获只读豁免。面板、文件命令与 CLI 使用相同门禁；内部注册心跳和诊断记录不占资源写锁。冲突立即返回 busy，不排队。

普通写入要求四项全部满足：没有正在执行的冲突操作、没有未解决 unknown、没有未完成离线事务、没有锁归属异常。门禁从持久化事实计算，不存在可随手清掉的暂停布尔值。

恢复／核验使用独立互斥的受限维护权，只处理指定记录及其关联锁，不开放普通业务写入。仅明确关联且确认持有者进程已退出的残留锁可以由维护方处置；执行终态或停止收据不等于持有进程死亡。活持有者尚未释放时返回 PROJECT_BUSY，等待其自行释放；无法完成释放时，显式关闭准确归属的进程后重新核验。孤立、损坏或归属不明的锁保留现场并报告诊断，不提供删整个状态目录的解锁方法。

同步执行发生不确定后果但已返回时，原执行方先持久化停止收据，再释放自己的锁；unknown 与未完成事务仍独立冻结普通写入，只有分别核验／恢复后才重新计算许可。错误派发异步工作的同步入口不会写停止收据或提前释放锁。锁释放失败保留诊断与保护，维护方不能凭收据抢删活持有者的锁。

## 离线写入与恢复

正式离线写入及实际恢复要求目标 Creator 已关闭，包括未注册但可识别的启动进程。无法可靠确认时拒绝。离线写入 API 只检查，不隐式关闭 Creator；查询、预演允许在线。

调用方负责复用用户已有的任务授权：准确绑定目标、安全保留并核验未保存编辑、排除冲突后，可以连续执行必要的保存、关闭与重开，不逐次另设审批。优先在线完成已有 Editor 工具能正确完成的小修改；确需离线的同轮操作合并生命周期窗口，每项保留独立事务和 ID，遇到 unknown 停止。Git clean 不能证明编辑器没有未保存内容。

生命周期的 `PREVIEW_IN_USE` 返回准确目标、端口、连接数和 `ownership: unknown`；`PREVIEW_STATE_UNAVAILABLE` 的连接数为 null，不等于零连接。先关闭本任务创建且归属可核验的预览，再重查。已有授权明确覆盖同一现场的中断时无需重复确认；其余现场须取得相应授权。`force:true` 只覆盖预览检查，不保存编辑，不绕过身份、锁、unknown 或事务。诊断快照不授予执行权，执行仍在锁内重新检查。

`prefab_edit`／`prefab_batch` 的 `dryRun` 默认 `false`；`projectRoot` 可显式指定，否则从目标文件向上解析真实项目。写入目标不得逃出该项目，指定 projectRoot 不会允许写 `/tmp` 等项目外资源。所有直接写 API、创建／提取／压缩、批处理、meta 修复和 AnimationClip 创建复用事务核心。

预演在内存中规划资源与 `.meta`；同批 `ensure-meta → add-component` 解析虚拟元数据，不需要预先落盘。正式执行取得锁后重新读取基线、输入与依赖并重新规划。预演不是提交凭证，不绑定 UUID，也不保证正式差异相同。

事务顺序：持久化计划、基线和完整备份 → 逐文件发布 → 核验 → 持久化 `COMMITTED` → 操作结果。只有有效 `COMMITTED` 是提交成立的依据。

| 崩溃位置／现场 | 默认恢复行为 |
|---|---|
| 尚未发布资源 | 核对没有资源副作用后结案 |
| 部分或全部资源已写，未提交 | 冻结，预览回滚；实际恢复另行显式执行 |
| 已提交，操作结果缺失 | 从事务事实补齐结果，不错误回滚；另报当前资源是否有后续变化 |
| 日志、备份或当前资源冲突 | 停止自动处理，保留现场 |

已有文件通过同文件系统暂存＋替换发布，新文件以原子不覆盖发布。回滚只恢复属于该事务的内容；发现外部变更立即停止。成功回滚先持久化恢复终态再结案。备份目前保留，不自动删除。

glob 每个文件独立事务，子操作 ID 由父 ID 与规范化文件路径稳定派生。第一项失败后停止后续提交、报告逐项结果并以非零状态退出；不是整个 glob 的全有或全无。

`changed / written / wouldChange` 仅统计目标资源，包含 `.meta`，不包含日志与锁。预演 `changed:false, written:false`；无操作不写资源；无法确认时为 `null`。回滚不会抹去曾经写入的事实。

## 可核验处置路径

以下示例中的 ID 必须替换为实际记录，不要为重试生成新 ID：

```bash
node /absolute/path/cocos-mcp/cli/bin/cocos-mcp-cli.js operation-status \
  --project-root /absolute/project --operation-id original-id

# 默认仅预览恢复，可以在线运行
node /absolute/path/cocos-mcp/cli/bin/cocos-mcp-cli.js offline-recover \
  --project-root /absolute/project --transaction-id actual-transaction-id

# 用户已授权该事务恢复、并已关闭准确 Creator 后执行
node /absolute/path/cocos-mcp/cli/bin/cocos-mcp-cli.js offline-recover \
  --project-root /absolute/project --transaction-id actual-transaction-id \
  --apply --operation-id recovery-id

# 只追加核验／接受当前状态，不改资源，不代替事务恢复
node /absolute/path/cocos-mcp/cli/bin/cocos-mcp-cli.js operation-reconcile \
  --project-root /absolute/project --operation-id original-id \
  --outcome accept_current_state --evidence "说明已检查的资源与所接受的状态"
```

停止证据由工具采集。HTTP 不通、心跳消失、Router 退出或上述调用方文字本身均不足以证明 Creator 停止。没有机器停止证据时，需显式关闭准确归属的 Creator，再核验；不能先解除 unknown。原 unknown 不会被改写为“执行成功”，调用方报告单独保存。每次处置后重新计算所有阻塞项。

重载初次返回 scheduled／running 也遵守这一规则：旧服务交接与停止、新 `instanceId`、`loadedAt`、认证和实际 runtime/schema 全部核对后才结案；交接不完整保持 unknown。

## 轻量发现

`local_get_status({mode:"identity", _target})` 只返回真实项目路径、instanceId、进程启动身份、extensionRuntime 和 `catalogVersions: {tools, resources}`；不查预览、Git 或命令日志，不更新状态文件。省略 mode 仍返回完整诊断。描述版本分别覆盖工具 schema／元数据与资源描述，不代表资源正文版本。

Router 首次读取工具定义后才使用支持的 identity 模式；尚未支持该参数的服务保留完整探测与目录刷新。每轮都认证并核对实例／进程身份，同一代且 endpoint、凭据未变时复用 HTTP 会话。工具或资源描述版本变化时只更新对应清单；完整名称映射、工具列表与签名按发现变化重建。失联、身份不符或描述版本与清单不一致时撤下该目标并报告 discoveryDiagnostics，不以缓存授权。初始化失败允许后续重新连接，连接恢复不重放修改请求。

## 迁移与不保证的事项

- 迁移旧 `<pid>.json`、最新心跳选择器、裸 URL／免认证客户端、未初始化客户端和遗漏 dryRun／operationId 的调用方；不提供兼容写入回退。
- Editor `meta_fix` 只预览；实际修复改用已关闭 Creator 的 CLI `fix-meta --apply --operation-id ...`。
- 旧 `.dev/refresh` 文本命令已拒绝；JSON 命令须带准确 `_target`、`operationId` 和已声明工具参数，并查询持久化结果。
- 面板 HTTP 地址只供诊断，不是免认证接入命令。新旧主版本不能作为同一项目的并行受控 writer；未结案状态不能通过降级绕过。
- 不承诺任意 Creator 操作跨崩溃“恰好执行一次”，不承诺多文件同时可见。只对遵守协议的写入者提供排他保护；无法消除外部程序恰好在 hash 检查与替换之间写入的竞态。[Node 文件系统保证](https://nodejs.org/docs/latest-v22.x/api/fs.html)
- macOS／Linux 使用并校验私有目录与文件权限；Windows 使用 ACL 检查，不能将 `0600` 当作等价保护。macOS 使用微秒级进程启动身份。其他平台、实际 Creator 场景及文件系统能力须分别验收；无法满足身份、权限或持久化要求时危险操作拒绝，不退化成 PID-only 或普通覆盖。

提交、SDK gitlink、版本字段、正式制品、push、tag、Release、安装、激活及客户端配置仍分别授权。此修复工作树不是稳定安装源。
