# self-demo

使用 pnpm workspace、Turborepo 和 Changesets 的 TypeScript monorepo。

## 目录

```text
apps/
  web/                       Vite + React 前端
  api/                       NestJS 服务端
packages/
  eslint-config/             ESLint flat config：基础工具、React、NestJS
  prettier-config/           统一格式化配置
  typescript-config/         严格基础配置及 React / NestJS 预设
.changeset/                  包版本管理
```

## 环境与启动

需要 Node.js 22.12+（建议使用 `.nvmrc` 指定版本）及 pnpm 10.20.0。
项目通过 `packageManager` 固定 pnpm 版本，使用 Corepack 避免本机旧 pnpm 的影响：

```bash
corepack pnpm install
corepack pnpm dev
```

- 前端：<http://127.0.0.1:5173>
- API：<http://127.0.0.1:3000/api/health>
- 前端点击「检查连接」，通过 Vite 的 `/api` 代理调用 NestJS。

单独启动：

```bash
corepack pnpm --filter @repo/web dev
corepack pnpm --filter @repo/api dev
```

服务端端口可用 `PORT` 覆盖；同时用 `API_PROXY_TARGET` 配置前端代理目标：

```bash
PORT=3001 API_PROXY_TARGET=http://127.0.0.1:3001 corepack pnpm dev
```

服务默认仅监听本机。修改监听地址后才能供其他设备访问。
NestJS 当前读取 shell 环境变量，不会自动加载 `.env` 文件。

## 常用命令

| 命令                         | 用途                                               |
| ---------------------------- | -------------------------------------------------- |
| `corepack pnpm dev`          | 同时启动两个应用，支持热更新                       |
| `corepack pnpm build`        | 构建两个应用，产物位于各自 `dist/`                 |
| `corepack pnpm lint`         | 检查根目录配置文件及两个应用，启用 TS 类型感知规则 |
| `corepack pnpm lint:fix`     | 自动修复 ESLint 问题                               |
| `corepack pnpm typecheck`    | 两个应用的 TypeScript 检查                         |
| `corepack pnpm format`       | Prettier 格式化整个仓库                            |
| `corepack pnpm format:check` | 检查格式                                           |
| `corepack pnpm check`        | 完成格式、lint、类型检查及构建                     |

构建后独立运行服务端：

```bash
corepack pnpm --filter @repo/api start
```

前端 `preview` 只用于预览静态构建产物。上线时需要自行配置 `/api` 反向代理；
Vite 的开发代理不是生产部署方案。

## 共享配置

- ESLint 负责代码质量，Prettier 负责格式化；`eslint-config-prettier` 关闭冲突规则。
- 两个应用的 ESLint 配置只调用对应的共享工厂，并传入自身目录。
- TypeScript 基础配置启用 `strict`、`noUncheckedIndexedAccess`、
  `exactOptionalPropertyTypes` 等检查。
- React 使用 Bundler 模块解析；NestJS 使用 CommonJS 和 decorator metadata。
- NestJS 不强制 type-only import，以保留构造函数注入需要的运行时类元数据。
- 新增应用通过 `workspace:*` 声明共享配置依赖，不直接引用其他包的源码。
- Turbo 将共享配置文件纳入全局缓存输入；修改规范会使已有任务缓存失效。
- `.vscode/` 提供格式化、ESLint 自动修复及推荐扩展配置。

## Changesets

```bash
corepack pnpm changeset
corepack pnpm version-packages
```

当前应用和配置包全部为私有包，因此没有需要发布的包。
新增库包后使用 Changesets 记录变更；配置 registry 和认证后才能发布。
具体流程见 [.changeset/README.md](.changeset/README.md)。

## IDE 启动

`.trae/environments/run.json` 保存了同时启动前后端的命令，可通过 Run 按钮启动。
如果两个服务已经在运行，请复用当前服务或先停止它们，以免端口冲突。
