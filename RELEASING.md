# cocos-mcp 发布规范

本文是 `cocos-mcp` 产品发布的唯一规范。Lab 的路线图、验证记录和 case 只能提供证据，不能代替产品版本、tag 或正式发布。

## 1. 发布定义

一次正式发布必须同时具备：

1. 四个产品版本面与目标 SemVer 一致；
2. 一个不可变的 `cocos-mcp` release commit；
3. 固定且已嵌入制品的 `mcp-sdk` commit；
4. 从该 release commit 构建的自包含 ZIP、manifest 与 SHA-256；
5. 对该 ZIP 完成无软链接安装验证；
6. Lab 中存在对应的版本验证记录，release commit、SDK 与制品身份已经固定；
7. annotated tag `v<version>` 指向同一个 release commit；
8. GitHub Release 发布该 ZIP、manifest、SHA-256 和用户可读变更说明。

缺少其中任一项时，只能称为开发提交或已验证候选版本，不能称为已发布版本。

历史 `v1.0.0` 是早于本规范的 stable tag，没有对应的自包含 GitHub Release。不得补造当时并未执行的制品或验证记录；本规范从下一次正式发布开始执行。

## 2. 版本规则

使用 SemVer：

| 变化 | 版本 |
|---|---|
| 兼容性修复，不增加公开能力 | patch |
| 新增向后兼容 tool、可选参数、返回字段或工作流能力 | minor |
| 删除或改名 tool、新增必填参数、改变既有语义、路由模型或持久化协议 | major |

预发布 tag 使用 `v<version>-rc.<n>`。产品版本与 tag 不使用 `+build` metadata；准确 build identity 由 release commit、manifest 和 runtime/schema hash 表达。实验分支和历史 `*-test.*` tag 不作为稳定版本线，也不得覆盖或改写。

`package_version` 是 Cocos Creator 扩展 manifest 格式版本，不是 `cocos-mcp` 产品版本。

产品版本同时出现在以下四处，发布时必须保持完全一致：

| 版本面 | 位置 |
|---|---|
| Creator 扩展 | `package.json.version` |
| offline CLI | `cli/package.json.version` |
| 项目 MCP server identity | `main.js` 的 server info |
| stdio router identity | `router/bin.js` 的 `ROUTER_INFO` |

`scripts/build-release.mjs` 从待构建的准确 commit 读取并校验四个版本面；任一缺失、不是允许的 SemVer 或彼此不一致时，构建直接失败。

## 3. 分支与不可变性

- `main` 表示下一个可发布版本，不自动等于最新稳定版。
- 最新稳定版由最高稳定 SemVer tag 定义。
- `stable/v<major>.<minor>` 只在确实需要维护旧 minor 时创建或保留。
- 已发布 tag 不得移动、删除或重打；发布缺陷通过新的 patch 版本修复。
- version bump、product commit、Lab 记录 commit、tag、branch push、tag push 和 GitHub Release 是独立动作，必须分别处于用户明确授权范围内。

## 4. 制品契约

正式制品命名为：

```text
cocos-mcp-v<version>.zip
cocos-mcp-v<version>.sha256
cocos-mcp-v<version>.manifest.json
```

ZIP 顶层目录固定为 `cocos-mcp/`，至少包含：

- `package.json`、`main.js`；
- `panel/`、`scene/`、`server/`、`router/`、`cli/`；
- 固定版本且具有真实文件内容的 `mcp-sdk/`；
- `README.md`、`LICENSE` 与 `NOTICE`。

不能把 GitHub 自动生成的 source archive 当成正式安装包，因为 Git submodule 内容不保证被嵌入。制品内不得包含任何 `.git` 元数据。

执行：

```bash
node scripts/build-release.mjs
```

构建环境必须提供 Node.js、Git、`tar`、`zip` 和 `unzip`；脚本不引入产品运行时依赖。

脚本始终从当前 `HEAD` 和该提交固定的 SDK gitlink 构建。若产品或 SDK 工作区不 clean、SDK checkout 与 gitlink 不一致，或本地 `refs/tags/v<version>` 已指向其他 commit，仍只生成 `candidate.<short-head>` 制品，manifest 中 `releaseEligible=false`，不得发布。脚本不会自动 fetch；正式发布前必须单独确认本地 tag 已与目标远端同步。

## 5. 发布闸门

按顺序执行，后一步不能补偿前一步失败：

1. 冻结范围，确认 `CHANGELOG.md` 的 `[Unreleased]` 只包含目标版本内容。
2. 同步修改第 2 节列出的四个产品版本面，将变更移动到正式版本标题；取得 product commit 授权后形成待验证 release commit。
3. 确认 `cocos-mcp` 与 `mcp-sdk` clean、SDK checkout 与父仓库 gitlink 一致，并确认本地目标版本 tag 不存在或已指向同一 release commit。
4. 运行插件和 SDK 自动测试。
5. 从两个 Creator 都未运行且相关工程 clean 的状态运行 Lab 双编辑器回归。
6. 使用本文件第 4 节命令构建正式制品；必须得到 `releaseEligible=true`。
7. 关闭机器上的全部 Creator 主进程，再在 Lab 中执行无软链接制品验证。验证器会在创建临时工程前检查进程；发现任何 Creator 时只报告并失败，不会替用户关闭：

   ```bash
   node ../scripts/validate-release-artifact.mjs dist/cocos-mcp-v<version>.zip
   ```

8. 针对同一准确 ZIP 逐项执行目标版本的 game case 矩阵。`validate-release-artifact.mjs` 只负责安装、identity、AssetDB 与 offline tool smoke，不能替代全部结构、runtime 和 visual case。
9. 从 `docs/releases/TEMPLATE.md` 生成 `docs/releases/v<version>.md`，记录 release commit、SDK commit、runtime/schema identity、case 矩阵、制品 SHA-256 和实际环境。上述身份与制品字段写入后不得改变；取得 Lab commit 授权后独立提交，未提交时不得称为证据已固化。
10. 再次审计 product、SDK、official、game 与 Lab 五个工作区。
11. 取得 tag 授权后，在准确的 release commit 创建 annotated tag：

    ```bash
    git tag -a v<version> -m "cocos-mcp v<version>"
    ```

12. push branch、push tag 和创建 GitHub Release 分别取得授权；Release 上传 ZIP、manifest、SHA-256，并使用 `CHANGELOG.md` 对应版本内容作为说明基础。之后只把实际动作、时间和 URL 追加到 Lab 记录并另行提交；release identity、制品与 case 结果永久冻结，后续 deprecated 等生命周期事实仍可追加。

任何代码或版本内容在第 6–9 步后发生变化，都必须产生新的 release commit，并重新执行受影响的闸门；不得把旧验证记录套到新 commit。

## 6. 验证环境与兼容声明

- `package.json.editor` 表示声明的 Creator 兼容范围。
- 发布记录只声明实际验证过的 Creator、macOS/Windows/Linux 和 Node 版本，不能由 manifest 范围推导为全部已验证。
- 开发用软链接双工程验证源码一致性；正式发布额外要求 ZIP 解压后的真实目录验证。
- 发布制品没有 `.git` 时，runtime 以制品 manifest、`runtimeBuildId`、`toolSchemaHash` 和 `loadedAt` 作为身份链，不要求 `sourceGitHead` 非空。

## 7. 回滚与修复

- 未发布候选失败：修复后创建新 commit，重新验证，不创建稳定 tag。
- 已打 tag 但尚未公开：不得移动 tag；删除或重建 tag 需要单独的历史改写授权。
- 已公开发布：标记已知问题并发布 patch；不得用替换附件或移动 tag 静默改变同一版本内容。
- 严重问题需要停止分发时，在 GitHub Release 明确标记，不删除验证记录和历史制品事实。
