# Changelog

本文记录 `cocos-mcp` 的用户可见变化。版本采用 SemVer；未发布内容只进入 `[Unreleased]`，不能仅凭本文件称为正式发布。

## [Unreleased]

### Added

- 发布 bound runtime、tool schema 与加载时间 identity，支持核对编辑器实际加载版本。
- 为 AssetDB 查询增加 opt-in 分页与字段投影。
- 完整公开 Prefab query selectors，并支持 nested prefab 内部节点 override 的写入与精确 reset。
- 增加 offline `animation_query` 与 `animation_create`，支持 AnimationClip 数值曲线查询和创建。
- 增加分层 editor readiness 与多编辑器启动、等待、重启控制能力。

### Changed

- `meta_fix` 省略 `dryRun` 时默认只预览。
- `local_reload_package` 明确返回 scheduled 边界，并在 reload 时清理扩展自身模块缓存。

### Fixed

- direct HTTP 与 router 会在调用 handler 前拒绝缺失的顶层必填参数。

## [1.0.0]

- 首个稳定版本；对应 tag `v1.0.0`。
