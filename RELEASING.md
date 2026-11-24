# 发布清单

本文件是维护者发布 Threadlight 的步骤清单。发布由 tag 触发 [release.yml](.github/workflows/release.yml)：先校验版本与更新日志，再跑全量检查、打包、发布 npm、补 GitHub Release。

## 一次性准备

1. **npm 渠道**。首次发布在 GitHub 仓库的 Actions Secrets 中设置 `NPM_TOKEN`，使用允许发布且启用 Bypass 2FA 的 npm granular access token。包创建后，可在 npm 的包设置里配置 Trusted Publishing，授权本仓库的 `release.yml` 执行 `npm publish`，然后移除 Actions secret。

   workflow 优先使用 `NPM_TOKEN`，否则使用 Trusted Publishing。配置步骤见 [npm token 文档](https://docs.npmjs.com/creating-and-viewing-access-tokens/) 和 [Trusted Publishing 文档](https://docs.npmjs.com/trusted-publishers/)。
2. **宿主实测**。发布说明里写明实测过的 DSH 版本与 profile，当前记录在 README 的实装测试表格里。

## 每次发布

1. **更新版本号**。
   ```powershell
   npm version 0.1.0-dev.16 --no-git-tag-version   # 稳定版直接写 0.1.0
   npm install --package-lock-only --registry=https://registry.npmjs.org
   ```
   提交前检查 `package-lock.json`：版本号与 `package.json` 一致，`resolved` 不指向 npmmirror 等镜像源。
2. **写更新日志**。把 `CHANGELOG.md` 顶部的 `## 未发布` 改成 `## <version>`，并在标题后补日期，例如 `## 0.1.0-dev.16 · 2026-11-24`。`release-check` 要求存在这一版标题，并会把它写成发布说明。
3. **同步文档**。涉及安装、兼容范围、图谱契约或路线图时，同时更新 README、`docs/` 和 `llms.txt`。
4. **本地验证**。
   ```powershell
   npm ci
   npm run check
   $env:THREADLIGHT_DSH_CLI_ROOT = 'C:\path\to\node_modules\@deepseek-ai\dsh'
   node --test tests/dsh-host.test.mjs
   npm pack --pack-destination dist
   ```
   宿主实装测试需要一份 `@deepseek-ai/dsh` 的安装目录，并在临时 HOME 里启动真实 DSH；CI 只跑前一步，因为它不安装 DSH。仓库另有 `dsh-host-compat` 手动 workflow，可在 Ubuntu 上对指定 DSH 版本跑同一用例。
5. **检查发布包**。`npm pack` 后确认 `dist/maxgraph-LICENSE.txt`、`dist/floating-ui-LICENSE.txt`、`lib/`、`examples/`、`skills/` 都在包里，且没有 `dist/` 下的调试目录。
6. **提交并打 tag**。tag 必须与 `package.json` 的版本一致（前缀 `v`）。
   ```powershell
   git add -A
   git commit -m "chore: release <version>"
   git tag v<version>
   git push origin main
   git push origin tag v<version>
   ```
7. **跟踪 workflow**。`release` 从 tag 指向的提交构建，校验版本与日志，跑完检查后将同一份 tgz 发布到 npm 并附到 GitHub Release。开发版使用 npm `dev` dist-tag 并标为 GitHub 预发布。稳定版使用 `latest`。手动触发时运行 `gh workflow run release.yml --ref v<version>`。认证失败时，配置凭据后可重跑原 workflow。
8. **发布后确认**。
   ```powershell
   npm view dsh-threadlight@<version> version dist-tags
   dsh plugin --profile web add dsh-threadlight@<version>
   ```
   从 GitHub Release 下载 tgz 再安装一次，确认资产可用。发布说明中记录测试数量、宿主版本和 profile。

## 失败与回滚

- **npm 已发布但 workflow 后续失败**：修复 GitHub Release 即可；不要为同一版本重新发布 npm（版本号已占用），必要时发下一个补丁版本。
- **npm 发布内容有误**：`npm unpublish dsh-threadlight@<version>` 只在发布后 72 小时内且无依赖时可用；更稳妥的做法是发布新版本并在 README 标注受影响版本。
- **tag 打错**：本地删除 tag、远端删除 tag（`git push origin :v<version>`）后重新打；已发布的 npm 版本不能复用。

## 版本约定

- `-dev.N` 是开发版，接口与图谱字段仍可能调整；正式版从 `0.1.0` 起按语义化版本发布。
- 图谱输入的 `schemaVersion` 当前固定为 `1`；新增字段保持可选，删除或改义字段需要提升查看器格式版本并写迁移说明。
