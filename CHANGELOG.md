# 更新日志

`-dev.N` 为开发版，接口仍可能调整。

## 0.1.0-dev.5

### 新增

- **领域层**。图谱可在 `project.areas` 声明最多 32 个领域，功能区用 `group.area` 归属，层级扩展为 项目 → 领域 → 功能区 → 线路 → 步骤。未声明领域的旧图谱保持四级。文档会话可在 `update.json` 顶层按 ID 合并领域定义并调整归属。
- **可展开的拓扑总览**。功能总览恢复为节点加连线的拓扑图，从左到右分层，点击分支逐级展开到步骤；搜索自动展开命中路径，步骤节点带状态标记。
- **图谱重置**。`dsh-threadlight reset [repository]` 把当前发布归档到 `.threadlight/archive/<时间戳>/`，保留草稿、批注与实现报告，下次 `refresh` 强制全量重建。DSH 工作区页提供「重置图谱」入口。
- **版本变动日志**。每次发布会记录到 `.threadlight/history.json`；`dsh-threadlight changelog` 比对连续版本，输出领域、功能区、线路、步骤、证据、步骤状态与验证记录的变化，并写入 `.threadlight/changes.md`。

### 变更

- 项目 Markdown 按领域分节，功能区文档带领域面包屑；Obsidian 导出格式版本升到 5（总览加领域分区与领域卡片）。
- 查看器格式版本升到 7（拓扑总览）。

## 0.1.0-dev.4

### 新增

- **实现回流**。草稿提交给 DSH 实现后，实现会话把源码位置、实际验证结果和与预期的差异写入 `.threadlight/implementation/<草稿 ID>/<版本>.json`；新命令 `dsh-threadlight report` 校验草稿、提交回执与报告后，把结果挂回图谱对应步骤，并按当前工作树重新定位证据。
- **步骤状态**。图谱节点新增可选 `state`（计划 / 有实现依据 / 已实际验证）、`verification`（验证记录）和 `divergence`（与预期的差异），图谱仍为 `schemaVersion: 1`，旧图谱照常读取。查看器、项目 Markdown 与 Obsidian 导出都会显示。
- 文档会话重写节点时，按 group / flow / node ID 保留上述宿主管理字段。

### 修复

- `captureWorkspace` 在根路径为 Windows 8.3 短名、junction 或符号链接时会静默返回空快照；现在入口先解析规范化路径，并补了回归用例。

### 其他

- 增加 MIT 许可证、`package.json` 的 `license` / `author` / `repository` 元数据。
- 增加 GitHub Actions 校验工作流，覆盖 Node 22 / 24 与 Ubuntu / Windows。
- 查看器格式版本 4 → 5，Obsidian 导出格式版本 3 → 4。

## 0.1.0-dev.3 及更早

早期开发版，未保留逐版记录。
