# dsh-threadlight

Threadlight 通过独立的 DeepSeek Harness 文档会话，把项目功能梳理为可浏览的线路。从功能总览进入一条线路，可以看操作顺序、分支和源码证据，也可以切到功能关系查看它与其他线路的接续和使用关系。图谱和 Markdown 由同一份结构化数据生成。

## 跑一遍

需要 Node.js 22 或更新版本。已有图谱时，可以直接生成离线查看器。

~~~powershell
node bin/dsh-threadlight.mjs view examples/basic.graph.json dist/reader
npm ci
npm run check
~~~

在浏览器打开 CLI 返回的 `viewer`。功能地图的连线表示功能区归属于项目。点选功能区，再从旁边的面板进入线路。在「操作流程」中，可以从选中的步骤开始导览，逐步选择已记录的下一步，查看已走路线，或返回上一个选中的步骤。开启顶部「新手模式」可在阅读时查看术语解释。项目 Markdown 入口在右上角。

想看跨线路关系时，用同一条 `view` 命令打开 [Threadlight 自身的架构示例](examples/architecture.graph.json)，选择「刷新项目文档」，再切到「功能关系」。实线表示操作接续，虚线表示一条线路使用另一条线路。

## 在 DSH Web 里审阅

在本目录打包，然后安装到 DSH 的 Web profile。

~~~powershell
npm ci
New-Item -ItemType Directory -Force dist
$archive = (npm pack --pack-destination dist --json | ConvertFrom-Json).filename
$packagePath = (Resolve-Path (Join-Path dist $archive)).Path -replace '\\', '/'
dsh plugin --profile web add "file:$packagePath"
dsh --profile web
~~~

在 DSH 侧栏下方点 **Threadlight**，也可以通过同一 DSH Web 地址下的 `/threadlight/` 进入。

- 左侧 **See** 打开创建页。DSH 提供系统目录选择器时，点「选择目录」，可以在选择器里新建文件夹或选用已有目录。DSH 提供网页目录能力时，可以填写父目录和新目录名称直接创建，也可以登记已有目录。工作区名称默认取项目目录名。
- 右侧 **Shape** 打开工作区列表，可按名称或路径搜索，也可按状态筛选。已发布图谱的项目打开图谱，其余可用项目打开草稿编辑器。图谱或空工作区的草稿页可通过「切换工作区」回到列表。

- 右键功能区标题，选「模块批注」。可以回看批注并追加新批注。批注按模块 ID 保存在工作区的 `.threadlight/annotations/`，图谱更新会保留同一模块的批注。
- 在线路介绍、步骤卡片或步骤详情中选中文字，再右键选「询问含义」或「进一步讲解」。解释会显示在当前页面，使用 DSH 当前配置的默认模型。模型请求带有选文、图谱上下文和相关源码引用位置，无工具调用。解释和文档生成各自运行。
- 在「流程草稿」新建线路，或从已有线路点击「从此线路建草稿」。可以编辑步骤和条件分支，并在任意步骤、连线或整条线路上写批注。草稿每次变更保存为独立版本。
- 草稿画布占满桌面工作区。可独立收起左侧「线路设置」和右侧「编辑详情」，给画布腾出空间。
- 拖动步骤可调整位置，点击「自动布局」可恢复自动排列。将步骤上的连接点拖到目标步骤即可连线，点选已有线条后可拖动端点或调整折线。也可以用步骤下拉框与右侧的步骤、连线表单编辑连接。画布由随插件打包的 maxGraph 渲染。
- 填写目标与验收条件后点「提交给 DSH」。Threadlight 将草稿和选中的批注整理成实现提示词，在当前工作区创建普通 DSH 会话。重复提交同一版本会返回原会话；进入该工作区的会话列表即可查看模型进度。

## 生成和更新项目文档

安装 Git 和 DSH 后，在 Threadlight 目录运行。首次 `refresh` 生成全量图谱。之后可以手动刷新，或使用 `watch` 在前台每 15 秒检查一次。用 Ctrl+C 停止监听。

~~~powershell
node bin/dsh-threadlight.mjs refresh D:/your-project --patch D:/config/threadlight-model.json
node bin/dsh-threadlight.mjs watch D:/your-project --patch D:/config/threadlight-model.json --interval 15
~~~

`--patch` 接受为文档会话配置模型和供应商的 DSH patch。使用 DSH headless 默认模型时可省略。通过启动 CLI 的环境提供供应商凭据，patch 可以引用环境变量。自定义 DSH 安装路径可传 `--dsh-cli`，指定其 `lib/bin.js`。

- 在目标项目打开 `.threadlight/viewer.html`。每次生成成功后重新加载这个页面，即可看到最新图谱。文档和各次版本保存在 `.threadlight/revisions/`。可将 `.threadlight/` 加入目标项目的 Git 忽略规则。
- Threadlight 对工作树里的可分析文本建立快照。包含已跟踪文件的本地编辑与删除、未忽略的新文件以及分支切换造成的源码差异。采集范围见下方。发送到模型的源码范围取决于模型在这些文件中的读取。
- 每次变动使用新的 DSH headless 会话和临时源码副本。会话调用 `threadlight-document-project`，收到变更文件列表、原图谱和受影响线路，交回补丁。结果中的 `affectedFlows` 和 `flowChanges` 分别报告受影响线路数和实际新增、修改、删除数量。`updated` 表示文档内容或引用定位有改动，`reviewed` 表示已处理新源码快照且文档内容与定位相同，`unchanged` 表示无需启动文档会话。无法可靠重新定位的旧证据会显示「证据待复核」。
- 若生成失败，图谱查看器继续使用上一次成功发布的版本。监听会等下一个源码快照，也可以手动用 `refresh` 重试。

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

步骤详情可以展开源码、测试和原文文档片段，也可以打开由同一份图谱生成的项目文档段落。项目文档和离线快照中的 Markdown 都可以链接回对应步骤。使用仓库里的架构图，可直接查看「刷新项目文档 → 保留上一版」的实现、测试和文档对应关系。

~~~powershell
cargo build --manifest-path analyzer/Cargo.toml --release --locked
$indexer = (Resolve-Path analyzer/target/release/threadlight-code-index.exe).Path
node bin/dsh-threadlight.mjs view examples/architecture.graph.json dist/evidence-preview --source . --code-index $indexer
~~~

`--source` 采集对应 Git 工作树并生成证据片段。可选的 `--code-index` 指向编译好的 Rust 索引器，分析带行号的 `.js`、`.mjs`、`.cjs` 和 `.jsx` 证据。定位结果来自 Tree-sitter 语法树，包括命名声明、静态导入和调用处。`refresh` 和 `watch` 也接受该参数，索引器和文件内容未变时，刷新会复用相同证据位置的索引结果。

## 可选 Obsidian 导出

使用 `node bin/dsh-threadlight.mjs export <graph.json> <output-parent>` 可以生成 Obsidian 笔记和 Canvas。DSH 宿主内也保留了 `threadlight-map-project` 与 `threadlight_export` 两个既有入口。用 `npm pack` 可生成用于安装 DSH 插件的本地包。

宿主实测可设置 THREADLIGHT_DSH_CLI_ROOT 为 @deepseek-ai/dsh 的本机包目录后运行 npm run check。实测使用隔离 profile，不依赖 API 凭据。

## 开发入口

- [图谱契约](docs/graph-format.md)
- [开发表与验收场景](docs/roadmap.md)
- [开发约定和 skills 位置](AGENTS.md)

## 许可证

[MIT](LICENSE)。随插件打包的 maxGraph 使用 Apache-2.0，其声明见 [scripts/maxgraph-NOTICE.txt](scripts/maxgraph-NOTICE.txt)。
