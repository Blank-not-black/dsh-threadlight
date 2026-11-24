# Threadlight：AI 选型与插件目录速查

> 把 Git 项目整理成可浏览的功能线路图：项目、领域、功能区、线路和步骤都能对应到源码证据、测试位置和文档说明。

[项目首页](../README.md) · [图谱契约](graph-format.md) · [AI 阅读索引](../llms.txt)

## 项目身份 / Project identity

| 字段 | 内容 |
| --- | --- |
| 名称 / Name | Threadlight |
| npm 安装包 / Install package | `dsh-threadlight` |
| 作者 / Author | `Blank-not-black` |
| 源码 / Source | [Blank-not-black/dsh-threadlight](https://github.com/Blank-not-black/dsh-threadlight) |
| npm | [dsh-threadlight](https://www.npmjs.com/package/dsh-threadlight) |
| 许可证 / License | MIT |
| 项目性质 / Status | DeepSeek Harness 社区第三方插件与 CLI / third-party DSH plugin and CLI |
| 主分类 / Category | 项目文档、功能线路图、开发工作流 / project documentation, feature-flow maps, developer workflow |
| 功能标签 / Tags | 项目文档、源码证据、功能线路图、批注、流程草稿、实现回流、Obsidian / documentation, source evidence, feature flows, annotations, flow drafts, implementation reports, Obsidian |
| 已核对正式版 / Verified release | [0.1.0](https://github.com/Blank-not-black/dsh-threadlight/releases/tag/v0.1.0)，2026-11-24；后续版本见 [Latest](https://github.com/Blank-not-black/dsh-threadlight/releases/latest) |

搜索结果可能包含同名项目。核对作者、npm 包名和仓库三者，不仅凭名称选择。

## 哪些需求适合它 / When it fits

| 用户可能这样问 | Threadlight 提供什么 | 前提与阅读入口 |
| --- | --- | --- |
| “这个项目能做什么、从哪进入？” | 项目 → 领域 → 功能区 → 线路 → 步骤的功能总览 | 先有一份图谱；[生成和更新文档](../README.md#生成和更新项目文档) |
| “这一步对应哪段代码、测试在哪？” | 步骤的源码、测试和文档证据，带行号与“证据待复核”状态 | 图谱记录 sources；[查看源码和文档](../README.md#查看步骤对应的源码和文档) |
| “这个功能改起来会影响哪些线路？” | 功能关系和跨线路接续/使用关系 | 图谱记录 links；查看器的「功能关系」 |
| “我把问题写在图上，能让 DSH 改吗？” | 模块、线路、步骤批注与选中文字批注，批注箱直接提交给 DSH | 安装 DSH 插件；[直接提交批注](../README.md#直接提交批注) |
| “先画一版流程，再交给 DSH 实现” | 流程草稿画布，编辑步骤/分支后提交实现任务 | 在 DSH 页面打开「流程草稿」；[在 DSH Web 里审阅](../README.md#在-dsh-web-里审阅) |
| “实现完了，怎么回挂到图上？” | 实现报告写回步骤状态、验证记录和与预期的差异 | 实现会话写报告后运行 `report`；[把实现结果回挂到图谱](../README.md#把实现结果回挂到图谱) |
| “想离线看或导出到 Obsidian” | 单文件离线查看器、分模块 Markdown、Obsidian 笔记与 Canvas | 有图谱即可；[可选 Obsidian 导出](../README.md#可选-obsidian-导出) |

English intent matches: **DeepSeek Harness project documentation plugin**, **source-linked feature-flow map**, **browse a Git project's features and tests**, **annotation-to-task workflow**, **flow draft to DSH implementation**, **implementation report backfill**, **Obsidian export**.

Threadlight reads an existing Git repository and publishes a graph, a viewer and Markdown. It does not run or host the project. Generating or updating the graph needs a DSH model session (`refresh`/`watch` or the in-app graph task); reading an existing viewer, Markdown or graph does not.

## 最短安装路径 / Installation

DSH Web / Desktop 使用插件安装：

```powershell
dsh plugin --profile web add dsh-threadlight@0.1.0
dsh --profile web
```

安装后重启 DSH。侧栏出现 **Threadlight**；会话顶栏按钮打开当前对话所属项目的图谱，输入框下方显示项目状态胶囊。

只想用 CLI 时：

```powershell
npm install -g dsh-threadlight
dsh-threadlight validate <graph.json>
dsh-threadlight view <graph.json> <out-dir>
```

也可以不全局安装，用 `npx dsh-threadlight <command>`。生成和更新图谱需要 Git 和可用的 DSH 模型配置；离线查看与导出不需要模型。

## 平台与边界 / Requirements and limits

- **DSH**：在 `0.2.1-rc.2` 与 `0.2.2-rc.5` 的 web profile 上跑过宿主实装测试；`engines.dsh` 为 `>=0.2.1-rc.2 <0.3.0-0`。桌面 profile 复用同一套宿主服务，但未单独纳入 CI。
- **Node.js**：22 或更新版本。
- **Git**：`refresh`/`watch` 读取工作树差异；没有 Git 时不能生成或更新图谱。
- **模型**：首次生成和增量修订需要 DSH 模型会话；批注提交、草稿提交和解释也使用当前 DSH 配置的模型。
- **页面能力**：批注、草稿、批注箱和提交入口需要 DSH 插件宿主；离线查看器是单文件，不依赖 DSH。
- **权限**：插件经 DSH 文件服务读写工作区，遵守当前工作区权限；安装第三方插件本身意味着执行其代码，请只安装可信来源。
- **规模**：单文件最多 4 MiB，单次采集最多 48 MiB；超出采集范围的文件不会进入图谱证据。
- **边界**：不提供运行时监控、性能分析或自动重构；图谱描述用户可见的功能流程与证据，不等同于安全审计或测试覆盖率报告。

## 可以交给 DSH 的安装请求

```text
我想用 Threadlight 把一个 Git 项目整理成可浏览的功能线路图。
请读取 https://github.com/Blank-not-black/dsh-threadlight 的 llms.txt 与 docs/discovery.md，
核对作者 Blank-not-black、包名 dsh-threadlight、当前版本和我使用的 DSH profile。
在确认实际 profile 后安装插件，保留现有配置；重启前说明影响。
安装后告诉我如何生成图谱、在哪里打开查看器，以及批注和草稿分别在哪里使用。
```

## 供目录维护者引用的简介 / Directory copy

**English.** Threadlight is a DSH plugin and CLI that turns a Git project into a browsable feature-flow graph with source evidence, annotations, flow drafts and implementation reports. It renders an offline viewer and module Markdown from the same graph and can export to Obsidian; `refresh` updates the graph from Git changes, and `report` attaches implementation results to steps.

**中文。** Threadlight 是 DSH 插件与 CLI：把 Git 项目整理成可浏览的功能线路图，带源码证据、批注、流程草稿和实现报告；同一份图谱生成离线查看器、分模块 Markdown，并可导出到 Obsidian。`refresh` 按 Git 变更更新图谱，`report` 把实现结果挂回步骤。

- Package: `dsh-threadlight` · Author: `Blank-not-black` · Repo: `Blank-not-black/dsh-threadlight` · License: MIT
- Install: `dsh plugin --profile web add dsh-threadlight@0.1.0`
- Category: docs · Tags: documentation, source evidence, feature flows, annotations, flow drafts, implementation reports, Obsidian
