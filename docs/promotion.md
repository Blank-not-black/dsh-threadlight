# 宣传与收录

## 已投递 / 已上线

| 渠道 | 状态 | 入口 |
| --- | --- | --- |
| Awesome DSH Plugin（DSH 插件市场索引） | PR 待审：[#18451](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin/pull/18451) | 条目 `data/plugins/Blank-not-black__dsh-threadlight.yml`；合并后会自动进入 [Awesome DSH Plugin](https://awesome-dsh-plugin.com) 和 dsh-market 索引 |
| npm | 已发布 `0.1.0`；开发版 `dev` 标签为 `0.1.0-dev.16` | [dsh-threadlight](https://www.npmjs.com/package/dsh-threadlight) |
| GitHub topics | 已设置 `dsh-plugin`、`deepseek-harness`、`dsh`、`documentation`、`visualization`、`obsidian` 等 | 仓库 About |
| README / 发现素材 | 已加入徽章、2 张界面截图、`screenshots.json`、`docs/assets/icon-512.png`、[AI 选型与目录速查](discovery.md)、[社区介绍文案](community-introduction.md) | 仓库根目录与 `docs/` |
| GitHub Release | `v0.1.0` Latest；`v0.1.0-dev.16` Pre-release | [releases](https://github.com/Blank-not-black/dsh-threadlight/releases) |

## 待跟进

| 渠道 | 门槛 / 备注 |
| --- | --- |
| [bruc3van/awesome-dsh-plugin-pro](https://github.com/bruc3van/awesome-dsh-plugin-pro) | 作者自荐区要求仓库 **超过 10 stars**；当前 1 star，等社区积累后再提交。主目录合并后可以从 `SHOWCASE.md` 入口补投 |
| [kejixiaoliang/awesome-dsh-plugins](https://github.com/kejixiaoliang/awesome-dsh-plugins) | 14 类索引，没有独立的文档/可视化分类；暂不强行归类，等目录增加对应分类或维护者建议 |
| [Alex-Yanggg/awesome-DSH-plugin](https://github.com/Alex-Yanggg/awesome-DSH-plugin) | 手工维护的英文目录，最近更新停在 2026-08；确认仍在接收 PR 后再投 |
| Gitee | `dsh-remote` 有 Gitee 镜像与 `GITEE_TOKEN` 同步流程；Threadlight 需要单独的 Gitee 仓库和 token，暂未配置 |
| 社区帖子 | 可直接使用 [社区介绍文案](community-introduction.md) 和 README 截图；发布到 DeepSeek / DSH 社区时保留安装命令和已知边界 |

## 可复用素材

- 市场卡片：`docs/assets/icon-512.png`（512×512 PNG）
- 截图：`docs/screenshots/overview.png`、`docs/screenshots/flow.png`，由 `node bin/dsh-threadlight.mjs view examples/architecture.graph.json <out>` 生成
- 一句话英文简介、安装命令和边界：见 [discovery.md](discovery.md) 的「供目录维护者引用的简介」
- 面向 agent 的完整安装与使用说明：[llms.txt](../llms.txt)

提交新的目录时，先核对对方最新的贡献指南；描述只写功能，不用“最好/唯一/首创”这类无法核实的说法。
