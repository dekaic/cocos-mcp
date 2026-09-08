# Prefab 直改流程指南

> 目标读者：使用 Claude Code / MCP agent 操作 CC3.8.x prefab 的开发者。
> 本文聚焦**决策和流程**：什么时候用哪条路径、改完要做什么、有哪些已知坑。
> prefab 文件结构细节见 [prefab-schema.md](./prefab-schema.md)，不在此重复。

---

## 为什么绕过 Cocos 编辑器直改 prefab 文件

Cocos Creator 编辑器将 prefab 序列化为 JSON 文件存储在磁盘上。传统工作流需要打开 GUI → 在场景树里手动操作 → 保存，这在以下场景无法工作：

- **无头环境**：CI / MCP agent / 自动化脚本，没有显示器或不方便启动编辑器。
- **批量修改**：几十个 prefab 同步改文字、布局参数，手动操作成本极高。
- **可重复性**：工具链幂等产物（A/B 变体、多语言注入），需要确定性结果而非 GUI 点击。

直改文件可以做到零 GUI 依赖、秒级完成、可 diff 审计。代价是需要精确理解 prefab 格式，错误写入可能让编辑器报解析错误或静默破坏数据。

---

## 整体架构

```
Claude Code / MCP agent
        │
        ▼
    router/bin.js（cocos-mcp）
        │
        ├── offline tools（via cli/src/index.js，纯文件 I/O）
        │       ├── prefab_query   →  cli/src/parse.js + query.js
        │       ├── prefab_edit    →  cli/src/editor/index.js
        │       └── prefab_batch   →  cli/src/editor/index.js
        │
        └── editor tools（via HTTP → Cocos 扩展进程）
                ├── asset_reimport / asset_refresh
                ├── scene_query / scene_set_property
                └── preview_query_url / preview_refresh_and_reload
```

**offline tools**：查询与预演可在线，正式写入必须关闭目标 Creator、带 operationId，并通过项目内事务提交。详见 [执行契约](./execution-contract.md)。

**editor tools**：通过需认证的本机 HTTP 与 Creator 通信，端口动态发现。调用带 `_target: { projectPath, instanceId }`，副作用另带 operationId；展示别名和旧 URL 不授权执行。

预览页面截图、点击和 JS 执行属于浏览器验证范畴：先用 `preview_query_url` 取得 URL，再交给 Playwright / Chrome 打开真实页面。

---

## 决策表：用 offline 还是 editor？

| 操作 | 推荐路径 | 原因 |
|---|---|---|
| 改普通节点 position / active | **offline**（prefab_edit） | 直接改文件字段，秒级完成 |
| 改普通节点 Label 文字 | **offline**（prefab_edit） | 同上 |
| 改普通节点 SpriteFrame | **offline**（prefab_batch，op: set-sprite-frame） | `set` 子命令不支持，必须走 batch |
| 改 stub 节点普通字段（position / active） | **offline**（prefab_edit） | 工具自动路由到 propertyOverrides |
| 改 stub 展开后的内部节点字段 | **offline**（prefab_edit） | 使用 `set-nested-node-field`，按嵌套节点 fileId 写 propertyOverrides；可用 `reset-overrides + subNode` 复位 |
| 改 stub 节点组件字段（Label._string / Sprite._spriteFrame） | **offline**（prefab_edit） | 使用 `set-label-text` / `set-sprite-frame` / `set-nested-component-field`，工具会解析嵌套 prefab 内组件 fileId 并写 propertyOverrides |
| 查节点树结构 | **offline**（prefab_query）更快 | 纯文件解析，无需编辑器在线；但看不到运行时动态状态 |
| 查运行时节点状态（动画、数据绑定后） | **editor**（scene_query） | 运行时才有真实数据 |
| 触发资源重新导入 | **editor**（asset_reimport） | 必须让编辑器重建 UUID 索引 |
| 预览截图 | **browser**（Playwright / Chrome） | 先用 `preview_query_url` 拿 URL，再在真实浏览器页面截图 |
| 在预览中执行 JS | **browser**（Playwright / Chrome） | 先用 `preview_query_url` 拿 URL，再在真实浏览器上下文执行 |
| 改运行时场景节点（非 prefab 文件） | **editor**（scene_set_property） | 场景节点不存在离线文件可直改 |

---

## offline 改完后的操作流程

先预演，明确关闭目标 Creator，再以新的逻辑操作 ID 正式执行。预演不绑定正式差异或 UUID。成功提交后重开 Creator、重新发现并绑定新实例，然后验证导入；必要时使用以下刷新入口。

### 方式 A：仅重新导入资产

```
editor tool: asset_reimport
  参数: { "url": "db://assets/packages/game/home/ui/HomeUI.prefab", "_target": { "projectPath": "/absolute/project", "instanceId": "实际新实例" }, "operationId": "reimport-001" }
```

让编辑器重建该 prefab 的内部索引（UUID 映射、子资产列表）。适合只改了 prefab 内容、不涉及其他资产变动的情况。

### 方式 B：整链路刷新（改动较大时）

```
editor tool: preview_refresh_and_reload
```

触发编辑器重新加载所有修改过的资产并刷新预览。改动多个文件时用此方式，避免缓存不一致。

**重要**：不允许 Creator 持有旧内存时进行离线正式写入。unknown 时停止普通修改，查询原操作或预演恢复，不能换 ID 重试或手工删状态。

---

## 踩坑清单

### 坑 1：stub 节点直改字段永远无效

嵌套 prefab 的 stub 节点在父 prefab 中通常只有五个字段（`__type__`、`_objFlags`、`_parent`、`_prefab`、`__editorExtras__`），其余属性全在 `cc.PrefabInstance.propertyOverrides` 里。直接改 stub 节点的 `_lpos` 或 `_active` 字段，编辑器加载时会用 propertyOverrides 覆盖回去，修改静默丢失。

→ offline 工具已自动处理：检测到 stub 节点时自动路由到 propertyOverrides 写入。
→ ops.json 也必须交给受控高层 API 执行，不直接写序列化资源。
→ 详见 [prefab-schema.md § 4](./prefab-schema.md)。

### 坑 2：nestedPrefabInstanceRoots 不同步导致静默数据损坏

根节点 `cc.PrefabInfo.nestedPrefabInstanceRoots` 是 CC3 编辑器识别所有嵌套 prefab stub 的总索引。新增嵌套实例时如果忘记把 stub 节点引用加进这个数组，编辑器不会报错，但在下次保存 prefab 时会把嵌套引用关系覆盖掉，造成子组件引用丢失。

→ offline 工具的 `editPrefab` 路径已自动维护该列表。
→ 不绕过高层 API 手工维护该数组；工具覆盖不足时保留复现并报告缺口。
→ 详见 [prefab-schema.md § 4 坑二](./prefab-schema.md) 和 cli/README.md 地雷二。

### 坑 3：stub 内部节点或组件字段必须走 nested override

覆写 stub 内部节点字段（如子节点 `_lpos`）或组件字段（如 `cc.Label._string`、`cc.Sprite._spriteFrame`）不能直接写 stub。内部节点字段使用 `set-nested-node-field`；组件字段使用 `set-label-text`、`set-sprite-frame` 或 `set-nested-component-field`。工具会跨 prefab 解析目标 fileId，再写入 `cc.PrefabInstance.propertyOverrides`。

如果绕过这些 op 手写 JSON，编辑器加载后可能静默丢失修改；如果用 `set-component-field` 操作 stub，工具会提示改用 nested 字段路径。

→ 详见 [nested-prefab-protocol.md](./nested-prefab-protocol.md) 和 [prefab-schema.md § 4](./prefab-schema.md)。
