# Changesets

本仓库使用 Changesets 管理未来可发布的公共包。
当前两个应用及共享配置包均为 `private: true`，不会被版本更新或发布。

新增需要发布的包后，移除其 `private` 标记，并配置发布目标 registry：

1. `corepack pnpm changeset`：选择受影响的包，填写变更说明。
2. `corepack pnpm version-packages`：更新版本及 changelog。
3. `corepack pnpm release`：执行检查并发布（需要 registry 认证）。

`baseBranch` 为 `main`，按实际仓库的默认分支调整。
公共 npm 包还需把 `access` 改成 `public`，或在包的 `publishConfig` 中配置。
`changeset status` 的分支差异检查需要仓库已有首次提交。
