# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## 项目概览

- 这是一个 **PicGo uploader 插件**，包名 `picgo-plugin-p-sda1-uploader`。
- 代码是 **CommonJS + 单文件实现**，核心逻辑集中在 `index.js`。
- 插件通过 `module.exports = (ctx) => { ... }` 接收 PicGo 上下文并注册 uploader。
- 上传目标服务是 `https://p.sda1.dev/api/v1/upload_external_noform`（二进制 `POST`）。

## 常用命令

> 仓库没有 build/lint 脚本；测试为自带的零依赖集成测试。

- 安装依赖
  - 无 runtime / dev 依赖，日常无需 `npm install`

- 测试
  - `npm test` → `node test/upload.test.js`
  - 零第三方依赖：起本地 mock 图床 + 模拟 PicGo 的 `ctx`，全部请求锁定在 127.0.0.1，不会访问真实图床。

- 本地/使用侧安装（README）
  - `npm install picgo -g`
  - `picgo install p-sda1-uploader`

- 发布相关（CI 使用）
  - `npm version patch`（本地手动升版）
  - `npm publish`

## 代码架构（高层）

### 1) 入口与注册

- 入口文件：`index.js`（见 `package.json` 的 `main`）。
- `register()` 中调用 `ctx.helper.uploader.register('p-sda1-uploader', { ... })` 挂载插件。
- `config()` 返回空数组，表示当前版本无用户可配置项。

### 2) 上传主流程

`handle(ctx)` 的流程：

1. 从 `ctx.output` 读取待上传图片列表。
2. 调用 `uploadImages(imgList)` 有限并发（默认 3）处理全部图片。
3. 每张图先 `validateImage(img)`，再 `uploadSingleImage(img)`。
4. 上传成功后回写 `img.imgUrl`（PicGo 必填）、`img.url`（剪贴板优先）、`img.deleteUrl`，并删除 `img.buffer` / `img.base64Image` 释放内存。
5. 部分失败：把这些项从 `ctx.output` 移除（避免 GUI/剪贴板出现空链接）并发 notification，整体不抛错。
6. 全部失败：发 notification 后抛错。异常 message 固定以 `所有图片上传失败` 开头，后面跟上逐条真实原因——外层 `catch` 靠这个子串判断是否已经 notify 过，测试也断言它；改后半句可以，改这个前缀不行。

### 3) 核心函数职责

- `UPLOAD_CONFIG`：集中维护 API 地址、超时、大小限制、重试参数。
- `validateImage(img)`：数据来源（`buffer`/`base64Image`）、大小限制，并以**文件魔数**判定类型（不信任扩展名）。返回失败原因字符串，校验通过返回 `null`；同一个原因既写 `ctx.log.error`，也进 `results.failed[].error` 和全失败的异常 message，不要再退化成 `boolean` + "图片验证失败"。
- `parseResponse(response)`：兼容 `data.url` 与 `url` 两种结构，并强制校验返回地址为 `https` + `p.sda1.dev`。
- `redactSecrets(text)`：把 `delete_url` 的值换成 `***`。凡是要写进日志或 notification 的响应预览都必须先过它——PicGo 日志明文落盘，`delete_url` 等同删除凭证。只作用于日志文本，回写给 `img.deleteUrl` 的原值不受影响。
- `getErrorStatusCode` / `isNetworkLevelError` / `isRetryableError`：重试判定。**关键约束**：PicGo 核心（2.0.3 与 3.0.2 实测一致）把超时、DNS、连接失败统一成 `statusCode: 0` 且不带 `error.code`，因此 `0` 必须按"没拿到响应"处理，落进传输层重试判断；只有拿到真实 HTTP 状态时才按 429/5xx 判定。改动这里务必跑 `npm test`。
- `mayBeStoredOnHost(error)`：区分"请求可能已落盘、只是响应丢失"（超时、连接中途断开）与"建连阶段就失败"（DNS、拒绝、不可达）以及"拿到 HTTP 响应"。只有第一类会标记重复文件风险，重试时逐级携带。
- `uploadSingleImage(img, retryCount, duplicateRisk)`：单图上传 + 线性退避重试（1s/2s/3s，最多 3 次），并把重复风险带到最终结果。
- `uploadImages(imgList)`：有限并发批量上传并汇总结果。

### 4) 外部交互与依赖边界

- 无额外 runtime dependencies；主要依赖 PicGo 提供的 `ctx.request`、`ctx.log`、`ctx.helper`、`ctx.emit`。
- 请求格式：`Content-Type: application/octet-stream`，通过 query `filename` 传文件名，body 传二进制。
  这套"旧式请求选项"（`body`/`params`）在 PicGo 2.x（`request`）与 3.x（axios + 兼容层）上都成立，已实测。
- Node 版本约束：`>=14.0.0`（源码使用可选链）；PicGo peerDependency：`>=2.0.3`。
  注意：npm 上 `picgo` 只有 2.0.0–2.0.3 与 3.x，**不存在 2.3.x**，不要把下界写成 `>=2.3.0`。

## CI / 发布流程

`.github/workflows/npm-publish.yml`：

- 触发条件：`release.created`、手动 `workflow_dispatch`（**没有** push 到 `main` 自动发布）。
- 流程关键步骤：
  1. `actions/checkout@v4`
  2. setup Node 20 + `registry-url`
  3. `npm install`
  4. `npm test` —— 测试失败即中断，包不会发出去
  5. `npm publish`（`NODE_AUTH_TOKEN` = `secrets.NPM_TOKEN`）
- 工作流 `permissions: contents: read`，不改版本号、不回推提交；版本号由本地 `npm version patch` 决定。
- 不要给这个工作流加 `push` / `pull_request` 触发器：它带着 `NPM_TOKEN`，任何能跑到 `npm publish` 的触发方式都可能误发包。
- 剩余缺口：发布前没有 `version` 与 `picgo.version` 的一致性校验——两个字段必须同时手改，`npm version` 只会动前者。

## 仓库规则文件现状

- 未发现 `.cursorrules`、`.cursor/rules/`、`.github/copilot-instructions.md`。

## 维护时待办（2026-09 代码审计结论）

已修：重试判定（`statusCode: 0` 那条）、CI 测试门禁、`delete_url` 脱敏、全失败原因、PicGo 版本下界、`.gitignore`。剩下的是"改不动"而不是"没改"：

- **重试仍可能产生重复文件（已缓解，无法根治）**：图床没有幂等键接口，"响应丢失"型错误无法判断服务端是否已存文件。现在的做法是标记 `duplicateRisk` 并通过 notification + 日志提示用户核对，而不是静默丢弃线索。要根治需要服务端提供幂等/去重能力，或改为对这类错误不重试（会牺牲可用性）。
- **429 退避不读 `Retry-After`（不可修）**：实测 `picgo@2.0.3` 与 `picgo@3.0.2`，`ctx.request` 失败时给出的错误对象只有 `{ statusCode, response: { status, statusCode, body } }`，响应头被核心丢弃，插件根本取不到这个字段。要读到它只能绕开 `ctx.request` 自己发请求，会丢掉 PicGo 的代理设置，不值得。维持固定线性退避 1s/2s/3s。
- **文件名折叠为 ASCII（不要改成保留 Unicode）**：向图床提交中文 `filename` 实测返回 `500 {"code":"error","message":"Backend error."}`（同时刻站点首页正常，探测样本 1 次），所以折叠是必需步骤。返回地址形如 `<uid>/<随机目录>/<文件名>`，随机目录既不是 `md5(文件名)` 也不是 `md5(内容)`（两者都已实测排除），因此折叠成同名（例如两个中文原名都变成 `__.png`）不会互相覆盖。`sanitizeFileName` 的 `fallbackExt` 恒为 `.png`，只在完全没有文件名时用到。
- 大小限制统一为 **5MB**（代码、README 正文与 FAQ 现已一致，勿再写 10MB）。