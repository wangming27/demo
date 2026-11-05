# self-demo

使用 pnpm workspace、Turborepo 和 Changesets 的 TypeScript monorepo。

前端组件使用 **Semi Design**，样式使用 **Tailwind CSS v4**。
表单、按钮、表格、分页、弹窗和导航优先使用 Semi 组件；
布局、间距和响应式调整使用 Tailwind utility class。
`apps/web/vite.config.ts` 通过 `@tailwindcss/vite` 集成 Tailwind，
`apps/web/src/styles/global.css` 将背景、文字和边框颜色映射到 Semi 主题变量。
Tailwind utilities 使用 `important` 保证显式样式可覆盖 Semi 默认组件样式，
全局基础样式保留在 `base` layer，避免覆盖组件内部样式。

## 目录

```text
apps/
  web/                       Vite + React 前端
  api/                       NestJS 服务端
packages/
  contracts/                 Zod schema + ts-rest 接口契约，前后端共同依赖
  eslint-config/             ESLint flat config：基础工具、React、NestJS
  prettier-config/           统一格式化配置
  typescript-config/         严格基础配置及 React / NestJS 预设
.changeset/                  包版本管理
```

前端 `apps/web/src` 按职责组织：

```text
App.tsx                      路由配置与登录访问控制
main.tsx                     React / BrowserRouter 入口
pages/                       页面：login、users、not-found
components/                  公共组件、会话反馈组件、用户管理组件
hooks/                       会话恢复与账号操作
services/                    基于共享契约的 API 客户端
utils/                       日期格式化等纯工具函数
styles/                      全局样式与 Tailwind 主题映射
```

页面路由使用 React Router 7：`/login` 为登录与注册，`/users` 为用户管理，
`/` 按登录状态跳转，其他地址展示 404。会话恢复完成后才执行路由登录校验；
未登录访问 `/users` 时跳转 `/login`，已登录访问 `/login` 时跳转 `/users`。
普通用户在 `/users` 看到权限提示，管理员可操作用户列表。
生产环境的静态服务器需将页面地址回退到 `index.html`，以支持直接访问和刷新页面；
`/api` 请求应继续转发到 NestJS。

## 环境与启动

需要 Node.js 22.12+（建议使用 `.nvmrc` 指定版本）及 pnpm 10.20.0。
项目通过 `packageManager` 固定 pnpm 版本，使用 Corepack 避免本机旧 pnpm 的影响：

```bash
corepack pnpm install
cp .env.example .env
corepack pnpm db:up
corepack pnpm db:deploy
corepack pnpm dev
```

- 前端：<http://127.0.0.1:5173>
- API：<http://127.0.0.1:3000/api/health>
- 未登录时展示登录页，登录后进入管理工作台，通过 Vite 的 `/api` 代理调用 NestJS。

单独启动：

```bash
corepack pnpm --filter @repo/contracts build
corepack pnpm --filter @repo/web dev
corepack pnpm --filter @repo/api dev
```

根目录 `pnpm dev` 会先构建共享契约，并同时监听契约源码的变化。
单独启动应用时，另开终端运行 `corepack pnpm --filter @repo/contracts dev` 可监听契约变化。

服务端端口可用 `PORT` 覆盖；同时用 `API_PROXY_TARGET` 配置前端代理目标：

```bash
PORT=3001 API_PROXY_TARGET=http://127.0.0.1:3001 corepack pnpm dev
```

服务默认仅监听本机。修改监听地址后才能供其他设备访问。
后端优先读取 shell 环境变量，再读取 `apps/api/.env`；
非生产环境还会读取根目录 `.env`。已有 `.env` 时不要覆盖它。

## 本地 PostgreSQL

使用 Docker Compose 运行 PostgreSQL 18。先安装并启动 Docker Desktop，
然后在仓库根目录执行：

```bash
cp .env.example .env
corepack pnpm db:up
corepack pnpm db:status
```

`.env` 已被 Git 忽略。示例账号和密码仅用于本地开发，可在首次启动前修改。
`db:up` 会拉取镜像、后台启动容器，并等待数据库健康检查通过。
镜像固定在 PostgreSQL 18 大版本，重新拉取时可获得该系列更新；
需要完全可重复的部署时，应进一步固定镜像标签或摘要。

数据库仅开放在本机 `127.0.0.1:5432`，数据库名和用户名默认为 `demo`，
密码来自 `.env`。端口冲突时修改 `.env` 中的 `POSTGRES_PORT` 后重新启动。
可用数据库客户端连接，也可以进入容器内的 psql：

```bash
corepack pnpm db:shell
```

在 psql 中执行 `SELECT current_database(), current_user, version();` 验证连接，
使用 `\q` 退出。其他管理命令：

```bash
corepack pnpm db:logs
corepack pnpm db:down
```

`db:down` 移除容器和网络，但保留数据卷；再次启动会复用数据库数据。
PostgreSQL 18 的持久化卷挂载在 `/var/lib/postgresql`。
不要随意执行 `docker compose down -v`，它会删除本项目的数据卷。
数据卷不是备份，也不要直接替换 PostgreSQL 大版本镜像来升级已有数据库。

`POSTGRES_DB`、`POSTGRES_USER` 和 `POSTGRES_PASSWORD` 只在空数据卷首次初始化时生效；
修改 `.env` 不会自动修改已有数据库的名称、账号或密码。
容器初始化账号拥有较高权限，仅用于本地开发；生产应用应使用权限受限的账号。

后端已通过 Prisma 接入数据库。开发环境未设置 `DATABASE_URL` 时，会根据
根目录 `.env` 的 `POSTGRES_*` 构造本机连接地址；改端口或密码后应重启后端。
生产环境必须显式提供 `DATABASE_URL`，不会回退到本地数据库配置。
数据库连接信息只提供给后端，前端通过 `/api` 调用。

## 用户注册与登录

访问 <http://127.0.0.1:5173>，选择「注册」，填写昵称、邮箱和 12–128 个字符的密码。
注册成功后自动登录；刷新页面会恢复登录状态，退出登录会撤销当前会话。
每个浏览器会话固定有效 7 天，不自动续期；其他设备上的会话不受本次退出影响。

| 接口                      | 行为                                             |
| ------------------------- | ------------------------------------------------ |
| `POST /api/auth/register` | 接收 `{ name, email, password }`，创建用户并登录 |
| `POST /api/auth/login`    | 接收 `{ email, password }`，创建新会话           |
| `GET /api/auth/me`        | 返回 `{ user }`，未登录或会话失效返回 401        |
| `POST /api/auth/logout`   | 撤销当前会话、清除 Cookie，返回 204              |

邮箱去除首尾空格并转为小写，数据库唯一约束防止并发重复注册。
密码使用 Argon2id 哈希，会话使用 32 字节随机令牌，数据库只保存令牌的 SHA-256 哈希。
认证响应只包含 `id`、`email`、`name`、`role` 和 `createdAt`，不会返回密码哈希或会话令牌。
禁用账号不能登录，也不能继续使用已有会话。

会话通过 HttpOnly、SameSite=Lax Cookie 传递，前端不会将令牌保存到 localStorage。
所有认证 POST 请求必须带有可信 `Origin`，默认允许
`http://127.0.0.1:5173` 和 `http://localhost:5173`；
可通过 `AUTH_ALLOWED_ORIGINS` 设置逗号分隔的完整来源，不要附加路径或末尾斜杠。
使用 curl 等客户端时，也需要提供 `Origin` 请求头并保存/发送 Cookie。

`apps/api/src/auth` 管理认证逻辑，`apps/api/src/database` 提供 Prisma 连接，
`apps/api/prisma/schema.prisma` 定义用户和会话表，`prisma/migrations` 保存 SQL 迁移。
后续受保护接口可以导入 `AuthModule` 并使用 `@UseGuards(SessionGuard)`，
从 `AuthenticatedRequest.authUser` 获取当前用户。

修改模型后的开发流程：

```bash
corepack pnpm db:migrate --name describe_your_change
corepack pnpm db:generate
```

提交 schema 和 migration 文件；生成的客户端已被 Git、ESLint 和 Prettier 忽略。
`pnpm dev` 会生成客户端，根目录的构建、lint 和类型检查由 Turbo 统一先运行生成任务，
避免多个检查同时写入生成目录。单独运行 API 的构建或检查前，请先执行 `db:generate`。

已有迁移部署到新环境、查看数据和清理过期会话：

```bash
corepack pnpm db:deploy
corepack pnpm db:studio
corepack pnpm db:sessions:cleanup
```

Studio 的访问地址以终端输出为准，Ctrl+C 停止。`db:deploy` 应用于部署已有迁移，
不要在生产环境运行 `db:migrate`。清理命令只删除已过期的会话；
运行环境需要定期执行它来控制表大小，过期会话即使未清理也不能用于登录。

认证集成测试：

```bash
corepack pnpm test:integration
```

测试会将 API 构建到独立的 `.test-dist`，在本地数据库创建随机命名的独立 schema，应用迁移、
启动独立端口的 API，检查注册、密码校验、Cookie、会话撤销、过期、禁用和限流，
完成后删除测试 schema。需要数据库账号拥有创建 schema 权限；
禁止在 `NODE_ENV=production` 下执行，生产数据库凭据不要提供给测试。

### 生产部署配置

- 设置 `NODE_ENV=production`、`DATABASE_URL` 和 HTTPS `AUTH_ALLOWED_ORIGINS`。
  生产 Cookie 使用 `__Host-demo_session` 名称并启用 Secure，必须通过 HTTPS 访问。
- 当前前端通过同源 `/api` 访问后端，生产反向代理也应保持这个结构。
  后端默认监听 `127.0.0.1`，适用于本机反向代理；容器部署时需要另行配置监听地址。
- 默认不信任代理头。若在受控反向代理后运行，根据实际拓扑设置 `TRUST_PROXY_HOPS`，
  以便限流使用真实客户端地址；不可仅凭客户端传入的头部信任来源。
- 注册和登录各限制每个 IP 每分钟 10 次，其他认证接口每分钟 60 次。
  当前限流存储在单个进程内；多实例部署需接入共享限流存储或在网关统一限流。
  会话本身存储在 PostgreSQL，可供多个实例共享。
- 已完成基础认证与管理员/普通用户权限，邮件验证、密码重置和审计日志尚未实现。
  上线前还需配置数据库最小权限、备份恢复、监控及发布流程。

## 全量用户管理

管理员可以搜索昵称/邮箱、按启用状态筛选、分页查看全量账号，查看详情、
新增用户、编辑昵称/邮箱/角色，以及启用或停用账号。统计卡片展示全库用户总数、
启用数和停用数；表格的总数对应当前筛选条件。默认每页 10 条，可切换 20 或 50 条。

所有自助注册账号及迁移前的已有账号默认都是 `USER`（普通用户），
不能访问其他账号的信息。`ADMIN`（管理员）权限在服务端逐次校验，
不会因为隐藏前端按钮就视为已完成权限控制。

首次初始化管理员时，在受信任的终端指定一个**已有且启用**的账号：

```bash
corepack pnpm users:admin your-email@example.com
```

这条运维命令生成客户端并编译到独立 `.test-dist`，将指定账号设为管理员。
它不创建用户、不生成密码，也不默认提升“第一个注册者”的权限。
设置成功后，刷新账号权限或重新登录即可进入全量管理页面。
在生产环境，应由拥有数据库管理权限的运维人员执行；
新增其他管理员可在已有管理员的后台中操作。

| 接口                                                            | 行为                                                                                  |
| --------------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| `GET /api/users?page=1&pageSize=10&search=关键词&status=ACTIVE` | 搜索、状态筛选、分页列表，返回 `{ items, total, page, pageSize, stats }`              |
| `GET /api/users/:id`                                            | 查看用户详情                                                                          |
| `POST /api/users`                                               | 接收 `{ name, email, password, role }` 创建账号，`role` 默认 `USER`，不替换管理员会话 |
| `PATCH /api/users/:id`                                          | 接收 `{ name, email, role, status, updatedAt }` 保存账号                              |

管理接口均要求有效管理员会话；POST/PATCH 额外校验可信 Origin。
管理响应包含公开资料、`role`、`status` 和 `updatedAt`，不返回密码或会话数据，
并使用 `Cache-Control: no-store`。单页最多 100 条，ID、邮箱、角色、状态和查询参数均有校验。

停用账号、变更角色或邮箱会在同一数据库事务中撤销该账号的所有登录会话；
再次启用不会恢复旧会话。当前管理员不能停用自己或移除自己的管理员权限，
也不能移除最后一位启用的管理员。管理写操作使用可序列化事务与冲突重试，
防止并发修改导致全部管理员被移除。前端提交 `updatedAt` 作为版本，
资料已被别人修改时返回 409，需刷新后重新编辑。

账号删除暂不提供，使用停用保留账号资料。密码重置、邮件通知、审计日志和
更细粒度的权限尚未接入。认证与用户管理集成测试统一运行 `corepack pnpm test:integration`，
覆盖越权、分页、字段泄漏、编辑冲突、会话撤销和并发管理员保护。
同一命令还会运行前端请求封装测试，检查契约路径、响应校验、错误提示和请求取消；
单独运行前端测试可使用 `corepack pnpm --filter @repo/web test:api`（先构建契约包）。

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

### 接口契约

`packages/contracts/src/schemas.ts` 定义请求/响应的数据结构与校验规则；
`src/index.ts` 定义 HTTP 方法、完整路径、参数和响应状态码。类型从 Zod schema 推导，
前后端通过 `@repo/contracts` 导入，不直接依赖对方应用或 Prisma 的生成类型。

新增接口时先添加 schema 和契约，再由 API 的 `@TsRestHandler` 实现，
前端通过 ts-rest 客户端调用。两端均开启响应校验，请求的未知字段会被拒绝，
默认值、邮箱归一化、分页转换等规则由共享 schema 统一维护。
服务端内部保留 `Date`，在控制器边界显式序列化为契约规定的 ISO 字符串。
权限判断、Cookie、数据库事务仍由服务端管理；页面筛选状态及错误提示由前端管理。

契约自带 `/api` 前缀，控制器与 Nest 全局配置不再重复添加前缀。
根目录检查和构建由 Turbo 先构建契约；单独检查或构建应用前需先构建契约。

- ESLint 负责代码质量，Prettier 负责格式化；`eslint-config-prettier` 关闭冲突规则。
- 两个应用的 ESLint 配置只调用对应的共享工厂，并传入自身目录。
- TypeScript 基础配置启用 `strict`、`noUncheckedIndexedAccess`、
  `exactOptionalPropertyTypes` 等检查。
- React 使用 Bundler 模块解析；NestJS 使用 Node16 解析、
  CommonJS 和 decorator metadata，兼容 Prisma 的包导出配置。
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
