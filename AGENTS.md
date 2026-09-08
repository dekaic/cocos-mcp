# AGENTS.md

本文是插件级使用规则；项目自己的业务参数、测试账号和验证步骤仍由项目文档定义。本文对应 v3.0.0 的破坏性执行契约；工作树版本号不等于已经正式发布或安装。

## 允许入口

| 入口 | 用途 |
|---|---|
| 精确绑定的项目 MCP | scene / asset-db / preview / local |
| 私有认证的本机 HTTP 客户端 | 未注入 Router tool 时，使用配套 runtime/http-client，不能直接使用旧 URL |
| cocos-mcp-cli | 资源查询、Creator 关闭后的事务写入与受控恢复 |
| Playwright / Chrome | 在实际预览 URL 上验证游戏 |
| .dev/refresh JSON 命令 | 已绑定目标、操作 ID 的扩展重载，不是免门禁后门 |

## 项目与实例绑定

1. 解析真实绝对项目路径并读取当前完整 tools/list，先调用 `router_list_editors`。
2. 绑定唯一 `projectPath + instanceId`。展示短名不是执行身份；禁止按最新心跳、目录名、PID 或端口猜目标。每次 Editor tool 带 `_target: { projectPath, instanceId }`。
3. Router 按完整工具名精确映射；定义中的 `_meta.cocosMcp.target` 可供客户端绑定，但不能覆盖调用者显式提供的旧目标。
4. 核验 Router 与 Editor 各自的 source/runtime/schema identity。工作树 HEAD、dirty 和配置文本不能代替实际加载状态；修改 Router 或 CLI 后必须重启对应 stdio Router。
5. 服务每次启动、HTTP 重启、扩展重载都换 `instanceId`。重绑新实例只用于新操作；旧操作永远保留原目标，只能查询而不能向新实例重放。

注册文件位于 `~/.cocos-mcp/editors/<process-start-hash>-<instanceId>.json`。每代服务仅更新、删除自己的文件。共享 runtime 验证 OS 进程启动身份、规范化项目和私有权限；发现模块不删除 legacy 或损坏记录。旧 `<pid>.json`、未认证客户端只能报告迁移需要，不作为写入 fallback。

## HTTP 契约

只支持 loopback HTTP。bearer 每代更新，凭据只由私有注册读取，不得放入公共列表、日志、命令行、URL、操作记录或配置示例。

使用配套 `cli/src/runtime/http-client.js` 完成 initialize、版本协商、initialized 通知、会话头及后续协议头；不要用旧裸 curl tools/call 示例。支持的固定协议为 `2025-03-26` 和 `2025-06-18`，batch 按协商版本处理。所有 Origin（包括 null）拒绝；MCP POST 要求 JSON 与包含 JSON/SSE 的 Accept，body 上限 8 MiB。合法认证 GET /mcp 和 OPTIONS 为 405；健康检查走独立认证 GET /health，不提供 SSE。

工具 arguments 的未知业务字段拒绝；标准 MCP envelope 和合法 _meta 单独按协议验证。通用校验覆盖当前使用的类型、必填、边界与组合结构，不宣称实现全部 JSON Schema 关键字。

## 操作追踪与写入权

- 资源、场景、生命周期等副作用调用必须提供 `operationId`；打开场景、刷新、重导同样不是查询。纯查询与预演不强制 ID。一个新逻辑操作一个 ID，相同请求重试保持 ID、原始目标、业务参数和输入内容不变。
- 查重先于 busy 和目标存活检查。ID 与底层工具、原始目标、参数或输入摘要冲突时拒绝；不能用新的别名或 HTTP 地址改变逻辑请求。
- 必须检查 `isError` 和 `structuredContent.cocosMcpControl`。submitted/running 表示尚未完成；unknown 表示后果未知，不等于执行失败或从未写入。超时只查询原操作，不换 ID 重试。
- 实际执行者持项目锁，普通 Router 转发不重复持锁。HTTP 断连、Router 退出不取消 Editor 工作，也不释放它的保护。unknown、未结事务与锁异常全部解决前，普通写入继续冻结。
- `operation_status(projectPath, operationId?)` 查询单项或未解决项；Editor 对应 `local_operation_status`。状态查询保留历史原目标。

## 离线资源流程

1. 先查询源资源与实际实例、引用及未保存编辑；保留用户修改。
2. 预演可以在 Creator 运行时执行。它只是当时的建议差异，不保证 UUID 或正式计划相同。
3. 正式写入与恢复要求准确的目标 Creator 已关闭，不自动关闭或丢弃编辑。所有直接 API、CLI 与 Router 写入口使用同一事务核心；目标必须在项目内、父目录已存在。
4. `prefab_edit/prefab_batch` 的 dryRun 默认 false；实际执行须有具体写入授权与 ID。CLI 写命令带 `--operation-id`，预演用 `--dry-run`。Editor `meta_fix` 仅预览；真实修复走关闭后的 `fix-meta --apply --operation-id`。
5. 正式执行重新规划并验证基线，包含 .meta。多文件事务有持久化计划、备份、逐文件事实和最终 COMMITTED；不承诺同时可见。glob 每个文件独立事务，子 ID 稳定派生，首次失败停止后续并非零退出。
6. 提交后重新打开 Creator、绑定新实例，确认 AssetDB 导入，再按范围 reimport/refresh、重载资源、重新查询引用与真实预览。不能用旧编辑会话覆盖磁盘。

`changed/written/wouldChange` 只统计目标资源，包括 .meta；预演 changed/written 为 false，未知可为 null。回滚不能抹去曾经写入的事实。

## 恢复与核验

- `offline_recover(projectRoot, transactionId)` 默认预演。实际恢复指定 dryRun:false 和新的恢复 operationId；CLI 使用 `offline-recover --project-root ... --transaction-id ... --apply --operation-id ...`。
- 有有效 COMMITTED 但缺操作结果时补齐结果，不回滚；未提交事务预览回滚。回滚前核验当前文件属于该事务；外部修改、损坏备份／日志或路径变化均停止，保留现场。
- `operation_reconcile(projectPath, operationId, outcome, evidence)` 不改资源、不替代事务恢复。outcome 为 accept_current_state 或 confirm_no_effect；调用方报告单独保存，不改写原执行事实。工具必须先证明执行停止；HTTP 不通、无心跳或一句“已检查”都不够。
- 维护入口只处理指定操作及关联事务／锁。仅在归属明确、持有者进程已退出时处置残留锁；活持有者必须自行释放，终态或停止收据不能授权维护方抢删其锁。同步执行释放锁不解除 unknown 或事务冻结。孤立、损坏或归属不明的锁输出诊断，人工查明，不能删除整个状态目录或用 force 解锁。
- 解决一项后重新检查全部阻塞原因。需要关闭准确 Creator 时明确交给用户或已有授权的测试生命周期，不自动杀进程。不同主版本不得并行受控写同项目，也不能降级绕过冻结。

## 扩展重载

`local_reload_package` 最初以 running 控制分支返回 scheduled 信息。查询原 operationId，必须完成旧服务停止交接、新 instanceId、loadedAt 与实际运行身份核验后才能报告完成；交接不完整保持 unknown。

`.dev/refresh` 只接受带 `_target`、`operationId`、`name` 的单条 JSON；旧 restart-package 文本拒绝。面板、文件命令也使用项目门禁。心跳、诊断和就绪查询的内部维护写入不作为资源修改。

## 查询、预览与错误

- asset_query_assets 大工程主动传 limit 与 fields；省略分页仍返回全部匹配项。
- scene_execute_component_method 使用组件 dump UUID，不是节点 UUID；参数错误不能当作 (ok)。派发后的不确定失败保留冻结。
- 预览 URL 首选 preview_query_url，次选 local_get_status；仅可使用项目明确声明的只读兜底。不猜 localhost:7456，不读取未声明的旧预览文件。
- 浏览器验证在实际 URL 上追加唯一 tid，再观察游戏、Console 和受影响的交互。MCP 不提供浏览器自动化工具。
- 不手改 .scene/.prefab/.anim/.meta 或引用来绕过能力缺口；纯 TypeScript 和文档按项目规则编辑。
- 无法验证平台进程身份、私有权限或文件系统持久化能力时拒绝危险操作，不退化成 PID-only 或普通覆盖。

完整迁移、保证边界和诊断步骤见 [执行契约](doc/execution-contract.md)。发现插件缺陷时保留复现并报告，修复产品代码需要具体任务授权；提交、版本、发布、安装、激活各自独立。
