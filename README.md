# dsh-threadlight

[![check](https://github.com/Blank-not-black/dsh-threadlight/actions/workflows/check.yml/badge.svg)](https://github.com/Blank-not-black/dsh-threadlight/actions/workflows/check.yml)

Threadlight 通过独立的 DeepSeek Harness 文档会话，把项目功能梳理为可浏览的线路。从功能总览进入一条线路，可以看操作顺序、分支和源码证据，也可以切到功能关系查看它与其他线路的接续和使用关系。图谱和 Markdown 由同一份结构化数据生成。

## 跑一遍

需要 Node.js 22 或更新版本。已有图谱时，可以直接生成离线查看器。

~~~powershell
node bin/dsh-threadlight.mjs view examples/basic.graph.json dist/reader
npm ci
npm run check
~~~

在浏览器打开 CLI 返回的 `viewer`。功能总览以从左到右的拓扑图默认显示项目和领域，点击分支可逐级展开功能区、线路和步骤。未声明领域的图谱从项目直接展开到功能区。筛选时自动展开命中路径。点击线路标题进入「操作流程」，点击步骤直接定位到该步骤。在「操作流程」中，可以从选中的步骤开始导览，逐步选择已记录的下一步，查看已走路线，或返回上一个选中的步骤。开启顶部「新手模式」可在阅读时查看术语解释。项目 Markdown 入口在右上角。

想看跨线路关系时，用同一条 `view` 命令打开 [Threadlight 自身的架构示例](examples/architecture.graph.json)，选择「刷新项目文档」，再切到「功能关系」。实线表示操作接续，虚线表示一条线路使用另一条线路。

### 查看器快捷键与导出

- 按 `/` 或 `Ctrl/Cmd+K` 聚焦功能总览或操作流程的搜索框。按 `?` 或点顶栏「快捷键」打开说明，按 `Esc` 关闭浮层。按 `f` 将总览滚动到左上角，或将流程图适应窗口。在输入框中键入时，查看器快捷键不会打断编辑。
- 点步骤详情里的 `SRC n` 打开源码卡片，查看引用位置、符号、行指纹状态和已记录的带行号片段。需要复核的证据会在列表和卡片中标明。
- 在功能总览中选「导出 → 导出 PNG」，保存当前展开和筛选后的拓扑。浏览器无法生成 PNG 时会下载 SVG。任意视图都可选「导出 → 打印 / 另存为 PDF」，通过浏览器打印当前视图。

## 在 DSH Web 里审阅

已发布的预发布版可以用 `dsh plugin --profile web add dsh-threadlight@dev` 安装。稳定版发布后使用以下命令。

~~~powershell
dsh plugin --profile web add dsh-threadlight
dsh --profile web
~~~

开发中的版本在本目录打包，然后安装到 DSH 的 Web profile。

~~~powershell
npm ci
New-Item -ItemType Directory -Force dist
$archive = (npm pack --pack-destination dist --json | ConvertFrom-Json).filename
$packagePath = (Resolve-Path (Join-Path dist $archive)).Path -replace '\\', '/'
dsh plugin --profile web add "file:$packagePath"
dsh --profile web
~~~

在 DSH 侧栏下方点 **Threadlight**，也可以通过同一 DSH Web 地址下的 `/threadlight/` 进入。会话顶栏的 Threadlight 按钮会把面板指向当前对话所属的项目并打开功能总览；面板会记住最近一次进入的项目。

会话输入框下方会显示 Threadlight 状态胶囊：当前项目的模块数和待处理批注数；批注目标失效时同时给出数量。点一下打开对应视图；没有图谱的项目不显示。对话里 agent 调用 `threadlight_graph`、`threadlight_annotate` 或 `threadlight_export` 时，会话中会出现 Threadlight 工具卡片，展开可以看完整输出，并直接打开图谱或批注箱。

- 左侧 **See** 打开创建页。DSH 提供系统目录选择器时，点「选择目录」，可以在选择器里新建文件夹或选用已有目录。DSH 提供网页目录能力时，可以填写父目录和新目录名称直接创建，也可以登记已有目录。工作区名称默认取项目目录名。勾选「创建后生成图谱」时，Threadlight 会在新工作区里自动开一个对话，让会话用 `threadlight-map-project` 技能把项目梳理成图谱；完成后从工作区列表进入即可阅读。
- 右侧 **Shape** 打开工作区列表，可按名称或路径搜索，也可按状态筛选。已发布图谱的项目打开图谱，其余可用项目打开草稿编辑器。每个工作区都提供「更新图谱」和「重新生成」：前者让会话在现有图谱上做增量修订，后者先归档当前发布、再让会话从头重建。两者都会在当前工作区创建普通 DSH 会话；已发布图谱的工作区还提供「重置图谱」，只归档发布版本、不创建会话。图谱或草稿页可通过「切换工作区」回到列表。

- 右键功能区标题、线路标题或步骤卡片，可打开相应的批注。步骤详情标题也支持右键批注。可以新增、修改或删除批注。批注按模块 ID 保存在工作区的 `.threadlight/annotations/`，图谱更新会保留批注文件。
- 在线路介绍、步骤卡片或步骤详情中选中文字，右键选「批注所选文字」即可把原文随批注一起保存。也可以选「询问含义」或「进一步讲解」。解释会显示在当前页面，使用 DSH 当前配置的默认模型。模型请求带有选文、图谱上下文和相关源码引用位置，无工具调用。解释和文档生成各自运行。
- 在「流程草稿」新建线路，或从已有线路点击「从此线路建草稿」。可以编辑步骤和条件分支，并在任意步骤、连线或整条线路上写批注。草稿每次变更保存为独立版本。
- 草稿画布占满桌面工作区。可独立收起左侧「线路设置」和右侧「编辑详情」，给画布腾出空间。窗口较窄时（例如在 Threadlight 侧栏里打开）两侧面板改为覆盖式抽屉，画布始终占满宽度，点选节点会自动展开「编辑详情」；节点标题与说明自动换行，超出才省略。
- 拖动步骤可调整位置，点击「自动布局」可恢复自动排列。将步骤上的连接点拖到目标步骤即可连线，点选已有线条后可拖动端点或调整折线。也可以用步骤下拉框与右侧的步骤、连线表单编辑连接。画布由随插件打包的 maxGraph 渲染。
- 填写线路名称后即可提交包含至少一个步骤的草稿。目标、验收条件、步骤名称与说明、分支条件都可后补。还没绘制步骤时，写一条随任务提交的线路批注也能提交。点击「提交给 DSH」后，Threadlight 将草稿和选中的批注整理成提示词，在当前工作区创建普通 DSH 会话。重复提交同一版本会返回原会话，可在工作区的会话列表查看进度。

### 直接提交批注

只想请 DSH 按批注改代码时，可以直接提交，无需创建流程草稿。图谱顶栏的「批注箱」可跨模块勾选当前图谱的批注，每次最多 100 条；每条批注也能在批注箱内直接修改正文或删除。模块、线路或步骤的批注对话框中，也可以一次提交当前目标的全部已保存批注。

跨多个模块提交时，Threadlight 只创建一个**主会话**：提示词按模块整理批注，并要求主会话用 `subagent` 工具为每个模块派出子代理，限制同时并行的数量和修改边界，等子代理返回后逐模块复核、汇总改动位置与实际验证结果。提交栏可以选择本次主会话使用的 DSH agent preset；子代理继承主会话的 preset。

提示词带上项目和工作区名称、图谱摘要，以及逐条编号的批注目标、正文、引用和相关源码位置。同一组批注重复提交会返回原会话；回执保存在 `.threadlight/submissions/<摘要>.json`，记录涉及模块与主会话 session。

提交后批注仍留在批注箱，标记为「已提交 · 会话 xxxx」。确认 DSH 的改动符合预期后，可以逐条点「验收」归档，或用页脚的「验收已提交的 N 条」批量验收；归档后的批注默认隐藏，标题旁的「显示已归档」开关可以查看并「恢复」。标题同时显示待处理、目标失效与已归档数量，已归档批注再次提交会被拒绝。

图谱更新后，批注按模块、线路和步骤的稳定 ID 自动挂到当前图谱，不需要删除重写。目标已被删除的批注会标记「目标已失效」：仍可在批注箱里查看和删除，但不能提交；需要在新位置重新批注。

## 生成和更新项目文档

安装 Git 和 DSH 后，在 Threadlight 目录运行。首次 `refresh` 生成全量图谱。之后可以手动刷新，或使用 `watch` 在前台每 15 秒检查一次。用 Ctrl+C 停止监听。

图谱分两层：`.threadlight/graph.json` 是工作图谱，DSH 图谱会话或手写都会更新它；`refresh` 和 `report` 发布到 `revisions/`，发布后把结果镜像回 `graph.json` 并记录 `absorbedGraphDigest`。两者摘要不一致时，查看器、`threadlight_graph`、`threadlight_export` 都以工作图谱为准；下一次 `refresh` 会吸收它，不会丢掉 DSH 里刚更新的内容。从旧版本升级后，已有工作区里的 `graph.json` 会先按工作图谱显示，运行一次 `refresh` 即可建立吸收摘要。

~~~powershell
node bin/dsh-threadlight.mjs refresh D:/your-project --patch D:/config/threadlight-model.json
node bin/dsh-threadlight.mjs watch D:/your-project --patch D:/config/threadlight-model.json --interval 15
~~~

`--patch` 接受为文档会话配置模型和供应商的 DSH patch。使用 DSH headless 默认模型时可省略。通过启动 CLI 的环境提供供应商凭据，patch 可以引用环境变量。自定义 DSH 安装路径可传 `--dsh-cli`，指定其 `lib/bin.js`。

- 在目标项目打开 `.threadlight/viewer.html`。每次生成成功后重新加载这个页面，即可看到最新图谱。文档和各次版本保存在 `.threadlight/revisions/`。可将 `.threadlight/` 加入目标项目的 Git 忽略规则。
- Threadlight 对工作树里的可分析文本建立快照。包含已跟踪文件的本地编辑与删除、未忽略的新文件以及分支切换造成的源码差异。采集范围见下方。发送到模型的源码范围取决于模型在这些文件中的读取。
- 每次变动使用新的 DSH headless 会话和临时源码副本。会话调用 `threadlight-document-project`，收到变更文件列表、原图谱和受影响线路，交回补丁。结果中的 `affectedFlows` 和 `flowChanges` 分别报告受影响线路数和实际新增、修改、删除数量。`updated` 表示文档内容或引用定位有改动，`reviewed` 表示已处理新源码快照且文档内容与定位相同，`unchanged` 表示无需启动文档会话。无法可靠重新定位的旧证据会显示「证据待复核」。
- 若生成失败，图谱查看器继续使用上一次成功发布的版本。监听会等下一个源码快照，也可以手动用 `refresh` 重试。

### 重置图谱与查看版本差异

~~~powershell
node bin/dsh-threadlight.mjs reset D:/your-project
node bin/dsh-threadlight.mjs refresh D:/your-project --patch D:/config/threadlight-model.json
node bin/dsh-threadlight.mjs changelog D:/your-project --limit 5
node bin/dsh-threadlight.mjs changelog D:/your-project --from <revision> --to <revision> --format json
~~~

`reset` 将已发布的状态、查看器、版本、历史和变动日志移到 `.threadlight/archive/<UTC 时间戳>/`。草稿、批注、实现报告、Obsidian 导出和手写的 `.threadlight/graph.json` 保留；与发布一致的 `graph.json` 镜像会随发布一起归档，让下一次 `refresh` 真正从源码重建。命令输出仓库相对归档路径、实际移动项和下一步 `refresh`。没有可归档项时路径为 `null`。刷新或报告正持有发布锁时，稍后再重置。重置之后运行 `refresh` 即可启动全量生成。Web 工作区列表的「重新生成」使用相同的归档规则，并在归档后直接创建重新生成图谱的会话；「重置图谱」只归档发布，不创建会话。

校验失败时可以用 `validate <graph.json> --json` 拿到结构化回执：稳定错误码、出错位置、说明和修复提示。错误码表见图谱契约。

`changelog` 默认比较最近 5 对连续发布，输出中文 Markdown，同时写入 `.threadlight/changes.md`。`--from` 和 `--to` 可比较当前 `revisions/` 中任意两个版本。`--format json` 仅输出差异数组。历史缺失或无效时，默认比较按修订目录的修改时间排序。

### 把实现结果回挂到图谱

从已发布线路建立草稿并提交后，DSH 实现会话会按步骤将源码位置、实际验证结果和与预期的差异写入 `.threadlight/implementation/<草稿 ID>/<版本>.json`。实现会话完成后，先运行 `report`，再运行 `refresh`。

~~~powershell
node bin/dsh-threadlight.mjs report D:/your-project
node bin/dsh-threadlight.mjs refresh D:/your-project --patch D:/config/threadlight-model.json
~~~

`report` 用当前工作树定位报告里的证据，在查看器和项目 Markdown 中发布步骤状态与验证记录，并输出已应用、跳过和拒绝的报告。已有报告内容未变时会跳过。同一报告中当前线路缺失的步骤会在 `skippedSteps` 中列出。随后 `refresh` 会继续审阅实现产生的源码改动，并保留对应步骤的回流字段。也可为 `report` 传入 `--code-index` 补充源码符号。

### 采集范围

支持 UTF-8 文本文件，单文件最多 4 MiB，采集总量最多 48 MiB。扩展名支持 `.md`、`.js`、`.mjs`、`.cjs`、`.jsx`、`.ts`、`.tsx`、`.json`、`.json5`、`.yaml`、`.yml`、`.html`、`.css`、`.py`、`.java`、`.kt`、`.kts`、`.ets`、`.rs`、`.go`、`.sh`、`.ps1`、`.toml`、`.xml`、`.gradle`、`.sql`、`.cs`、`.c`、`.cc`、`.cpp`、`.cxx`、`.h`、`.hh`、`.hpp`、`.hxx`、`.rb`、`.php`、`.swift`、`.dart`、`.vue`、`.svelte`，另支持 `Dockerfile` 和 `Makefile`。

跳过隐藏路径（顶层 `.github/` 下的非隐藏路径除外）、常见构建或依赖目录、凭据目录、压缩后的 JavaScript、部分锁文件和常见凭据配置文件名，例如 `auth.json`、`credentials.json`。文件筛选依据路径与格式，支持范围内的源码仍可能含有凭据。工作树没有任何可采集文件时，refresh 会报告错误。

### 查看步骤对应的源码和文档

步骤详情可通过源码卡片查看源码、测试和原文文档片段，也可以打开由同一份图谱生成的项目文档段落。项目文档和离线快照中的 Markdown 都可以链接回对应步骤。使用仓库里的架构图，可直接查看「刷新项目文档 → 保留上一版」的实现、测试和文档对应关系。

~~~powershell
cargo build --manifest-path analyzer/Cargo.toml --release --locked
$indexer = (Resolve-Path analyzer/target/release/threadlight-code-index.exe).Path
node bin/dsh-threadlight.mjs view examples/architecture.graph.json dist/evidence-preview --source . --code-index $indexer
~~~

`--source` 采集对应 Git 工作树并生成证据片段。可选的 `--code-index` 指向编译好的 Rust 索引器，分析带行号的 `.js`、`.mjs`、`.cjs` 和 `.jsx` 证据。定位结果来自 Tree-sitter 语法树，包括命名声明、静态导入和调用处。`refresh` 和 `watch` 也接受该参数，索引器和文件内容未变时，刷新会复用相同证据位置的索引结果。

## 可选 Obsidian 导出

使用 `node bin/dsh-threadlight.mjs export <graph.json> <output-parent>` 可以生成 Obsidian 笔记和 Canvas。DSH 宿主内也保留了 `threadlight-map-project` 与 `threadlight_export` 两个既有入口。用 `npm pack` 可生成用于安装 DSH 插件的本地包。

宿主实装测试需要把 `THREADLIGHT_DSH_CLI_ROOT` 指向 `@deepseek-ai/dsh` 的本机包目录，再运行 `node --test tests/dsh-host.test.mjs`；它会在隔离的临时 HOME 和 web profile 中启动真实 DSH，不需要 API 凭据。当前实测：

| DSH 版本 | profile | 结果 |
| --- | --- | --- |
| 0.2.1-rc.2 | web | 通过 |
| 0.2.2-rc.5 | web | 通过 |

`package.json` 的 `engines.dsh` 允许 `>=0.2.1-rc.2 <0.3.0-0`。桌面端复用同一套宿主服务，但未单独纳入 CI；升级 DSH 后请先在对应 profile 上重跑这项测试。CI 只跑不需要宿主安装的用例；仓库提供 `dsh-host-compat` 手动 workflow，输入 DSH 版本即可在 Ubuntu 上跑同一用例。

## 开发入口

- [图谱契约](docs/graph-format.md)
- [开发方向与后续计划](docs/roadmap.md)
- [发布清单](RELEASING.md)
- [开发约定和 skills 位置](AGENTS.md)
- [llms.txt](llms.txt)：给 agent 的安装与使用说明

## 许可证

[MIT](LICENSE)。随插件打包的第三方声明：

- maxGraph 使用 Apache-2.0，许可证与 NOTICE 见发布包内的 `dist/maxgraph-LICENSE.txt`（仓库内为 [scripts/maxgraph-NOTICE.txt](scripts/maxgraph-NOTICE.txt)）。
- `@floating-ui/dom`、`@floating-ui/core`、`@floating-ui/utils` 使用 MIT，声明见发布包内的 `dist/floating-ui-LICENSE.txt`。
