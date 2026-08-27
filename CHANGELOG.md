# Changelog

本文记录 `cocos-mcp` 的用户可见变化。版本采用 SemVer；未发布内容只进入 `[Unreleased]`，不能仅凭本文件称为正式发布。

## [Unreleased]

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
