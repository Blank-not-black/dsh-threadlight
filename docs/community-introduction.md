# Threadlight：把项目整理成可浏览的功能线路图

一个项目通常有很多“用户能做什么”的入口，但代码、测试和文档散在不同目录。Threadlight 用一个独立的 DSH 文档会话读取 Git 工作树，把项目整理成 **项目 → 领域 → 功能区 → 线路 → 步骤** 的图谱；每一步可以记录源码、测试和文档证据，读者可以沿着线路看操作顺序、分支和失败结果。

它不是运行时监控，也不是代码覆盖率报告。它解决的是“这个项目怎么用、这一步依据哪段代码、这次改动会影响哪些线路”，并把这张图作为后续批注、流程草稿和实现任务的上下文。

## 安装

```powershell
dsh plugin --profile web add dsh-threadlight@0.1.0
dsh --profile web
```

重启 DSH 后从侧栏 **Threadlight** 进入，或在会话顶栏打开当前项目的图谱。只想离线看已有图谱时，也可以用 CLI：

```powershell
npm install -g dsh-threadlight
dsh-threadlight view <graph.json> <out-dir>
```

## 可以做什么

- 从功能总览逐级展开领域、功能区、线路和步骤；
- 在步骤里查看源码、测试和文档证据，带行号和“证据待复核”状态；
- 在图上写批注，选中文字批注，批注箱一次提交给 DSH 主会话；
- 在画布上新建或复制线路草稿，编辑步骤和分支后提交实现任务；
- 实现完成后用 `report` 把源码位置、验证结果和与预期的差异挂回步骤；
- 生成离线 HTML 查看器、分模块 Markdown，或导出到 Obsidian。

## 边界

- 需要 Git 工作树；生成和更新图谱需要可用的 DSH 模型。
- 批注、草稿和提交需要 DSH 插件宿主；离线查看器不需要。
- 描述的是用户可见功能与证据，不是安全审计或测试覆盖率。
- DSH `0.2.1-rc.2` / `0.2.2-rc.5` 的 web profile 实测通过；桌面 profile 未单独纳入 CI。

[项目首页](https://github.com/Blank-not-black/dsh-threadlight) · [安装与使用](https://github.com/Blank-not-black/dsh-threadlight#readme) · [AI 选型与目录速查](discovery.md)
