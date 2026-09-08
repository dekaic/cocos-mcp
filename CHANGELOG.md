# Changelog

本文记录 `cocos-mcp` 的用户可见变化。版本采用 SemVer；版本准备前的变更进入 `[Unreleased]`。正式版本标题只固定变更范围，是否已发布以对应 tag、Release 与制品验证为准。

## [Unreleased]

## [3.0.0] - 2026-09-08

### Breaking changes

- Editor 调用要求真实项目路径与服务代次 `instanceId`；副作用调用要求 `operationId`，生命周期不再接受短名／PID-only／restart 隐式 spawn。旧注册只报告迁移，不兼容写入回退。
- 本机 HTTP 强制每代 bearer、拒绝任何 Origin，完成版本协商与 initialized 生命周期；认证 GET /mcp 为 405，不虚报 HTTP 推送。参数和控制结果采用统一契约。
- Router、Editor 与 CLI 共享持久化请求／执行事实、项目互斥和维护门禁。超时不是失败或取消，同 ID 不盲目重放，unknown 阻止新修改；核验结论与执行事实分开保存。
- 离线正式写入与恢复要求 Creator 关闭；全部资源写入口通过内存规划和可恢复事务，包含 `.meta`。`prefab_edit/prefab_batch` 支持 dryRun（默认 false）；Editor meta_fix 仅预览，实际修复用离线 `--apply`。
- 新增 operation_status、operation_reconcile、offline_recover 与 Editor 本地状态查询；恢复默认预演。COMMITTED 是唯一提交点，崩溃后补齐已提交结果或核验后恢复未提交事务，外部冲突保留现场。
- CLI 所有副作用命令新增必需 operation ID，目标须位于项目内；glob 逐项事务、稳定子 ID、首次失败停止。build 不再用既有产物覆盖非成功退出状态。
- 成功业务 payload 保留，控制错误与非终态通过 cocosMcpControl 明确返回；scheduled 重载不再当作完成，需交接与新运行身份验证。
- 修复 SDK 归一化在同时返回 structuredContent 和额外业务字段、但省略 content 时丢失业务字段的问题；额外字段进入独立文本项，原结构化结果及输出 schema 不变。

保证边界：不承诺任意 Editor 操作跨崩溃恰好一次，不承诺多文件同时可见，也不宣称消除外部写入者检查与替换间的竞态。平台不能证明进程身份、私有权限或持久化能力时拒绝危险操作。迁移与处置路径见 [执行契约](doc/execution-contract.md)；真实 Creator／平台及 release 验收独立记录，不能从本节推导已经通过。

### Fixed

- 修复离线恢复在操作 ID 查重前读取当前资源的问题：相同正式恢复请求先核对原始指纹并返回持久化结果，后续资源修改不掩盖既有成功或 unknown；新恢复与预演仍检查当前冲突，不重放或解除冻结。
- 补齐 `fix-meta --help` 的默认预演、项目根目录、`--apply`、`--operation-id` 及 Creator 关闭要求。
- 修复未发布共享执行锁的释放／维护竞争：维护方只处置准确归属且进程已退出的残留锁，不能因终态或停止收据删除活持有者的锁；同步执行停止后由原持有者释放，unknown 与未完成事务仍保持冻结，避免旧释放误删后继锁。
- 修复启动就绪等待因一次进程身份采样异常提前退出：仅在原等待期限内重新采集只读观测，保持原操作和执行锁；持续异常仍为 unknown。保留采样错误码诊断，不延长采样超时、不采用 PID-only，也不放宽离线写入准入。
- 修复协议组合边界：03-26 batch 的嵌套数组不再递归派发或产生嵌套响应；合法兄弟请求仍独立处理，合法通知不回包；SDK 拒绝以数组作为初始化 capabilities。06-18 仍拒绝 batch，不放宽认证、目标或操作门禁。

## [2.1.0] - 2026-08-27

### Added

- 增加 `scene_instantiate_prefab`，可通过 Prefab 资源 UUID 在当前 Scene 的指定父节点下创建并保留关联的实例。
- `animation_query` 现在始终返回只读 `events` 数组，并公开事件的 frame、函数名与参数。

### Fixed

- CLI `build --strict` 现在将 Creator 3.8.x 的官方成功退出码 `36` 与 `0` 一并归一为成功，同时继续把其他退出码和信号终止视为失败。
- Router 清理 stale registry 时不再误删同一项目仍在使用的 editor spawn lock。
- `scene_execute_component_method` 现在使用组件 UUID 执行方法，并对无效组件、方法或参数 fail-closed。
- `asset_delete` 在 Creator AssetDB 拒绝删除时返回 tool error，不再把失败响应报告为成功。

## [2.0.0] - 2026-08-13

### Added

- 发布 bound runtime、tool schema 与加载时间 identity，支持核对编辑器实际加载版本。
- 为 AssetDB 查询增加 opt-in 分页与字段投影。
- 完整公开 Prefab query selectors，并支持 nested prefab 内部节点 override 的写入与精确 reset。
- 增加 offline `animation_query` 与 `animation_create`，支持 AnimationClip 数值曲线查询和创建。
- 增加可复现的自包含 release 制品工作流，并在构建前校验四个产品版本面一致。

### Changed

- **Breaking:** `meta_fix` 省略 `dryRun` 时由直接写入改为只预览；实际写入必须显式传 `dryRun=false`。
- 既有 `editor_wait_ready` 现在分层报告 process、registry、MCP 与 AssetDB 状态，并回传实际加载的 runtime identity。
- `local_reload_package` 明确返回 scheduled 边界，并在 reload 时清理扩展自身模块缓存。

### Fixed

- HTTP server 使用实际绑定结果注册动态端口，避免端口探测与监听之间的竞争窗口。
- direct HTTP 与 router 会在调用 handler 前拒绝缺失的顶层必填参数。
- `anim query` 使用 AnimationClip 专用解析器，不再把有效 clip 当成缺少 Prefab 根节点。

## [1.0.0]

- 首个稳定版本；对应 tag `v1.0.0`。
