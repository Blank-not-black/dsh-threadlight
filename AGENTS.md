# dsh-threadlight 开发指南

- 这是独立的 DSH 插件。由专用 DSH 会话生成或修订图谱，再从同一份图谱渲染 HTML 和 Markdown。保留 Obsidian 导出入口。
- Git 更新以当前工作树为输入。增量更新保留未提交修订的线路。使用临时工作区和独立 DSH 配置执行文档任务，校验通过后发布到 .threadlight。
- 通用操作可直接使用 Node 内置模块。拓扑绘制、自动布局、图编辑和 UI 组件可以引入成熟的第三方库。测试使用 `node:test`。
- DSH 适配层通过宿主服务处理文件与权限，CLI 使用本机文件系统。实装测试使用独立临时 profile 和工作区。
- 修改图谱字段、导出布局或快照行为时，更新契约与回归用例。需要产品边界时读 [开发方向](docs/roadmap.md)，需要字段时读 [图谱契约](docs/graph-format.md)。
- 项目 skills 在 .agents/skills/，DSH 用户可调用的分析 skill 在 skills/。修改注册或打包后检查 DSH 宿主加载与 npm pack 文件范围。
- 日常检查运行 npm run check。对 DSH 兼容性的结论写清实测版本与 profile。
