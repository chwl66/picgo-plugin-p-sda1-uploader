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
6. 全部失败：发 notification 后抛错。

### 3) 核心函数职责

- `UPLOAD_CONFIG`：集中维护 API 地址、超时、大小限制、重试参数。
- `validateImage(img)`：数据来源（`buffer`/`base64Image`）、大小限制，并以**文件魔数**判定类型（不信任扩展名）。
- `parseResponse(response)`：兼容 `data.url` 与 `url` 两种结构，并强制校验返回地址为 `https` + `p.sda1.dev`。
- `getErrorStatusCode` / `isNetworkLevelError` / `isRetryableError`：重试判定。**关键约束**：PicGo 核心（2.0.3 与 3.0.2 实测一致）把超时、DNS、连接失败统一成 `statusCode: 0` 且不带 `error.code`，因此 `0` 必须按"没拿到响应"处理，落进传输层重试判断；只有拿到真实 HTTP 状态时才按 429/5xx 判定。改动这里务必跑 `npm test`。
- `uploadSingleImage(img, retryCount)`：单图上传 + 线性退避重试（1s/2s/3s，最多 3 次）。
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
  4. `npm publish`（`NODE_AUTH_TOKEN` = `secrets.NPM_TOKEN`）
- 工作流 `permissions: contents: read`，不改版本号、不回推提交；版本号由本地 `npm version patch` 决定。
- 已知缺口：CI 未跑 `npm test`，发布前也没有版本号一致性校验。

## 仓库规则文件现状

- 未发现 `.cursorrules`、`.cursor/rules/`、`.github/copilot-instructions.md`。

## 维护时待办（2026-09 代码审计结论，均已确认但尚未修）

- **重试非幂等**：请求已到达服务端但响应丢失时，重试会产生重复文件，且失败分支不保留 `delete_url`，用户无法清理。修重试相关逻辑时一并考虑。
- **429 未读 `Retry-After`**：目前固定线性退避 1s/2s/3s。
- **文件名净化把所有非 ASCII 归一为 `_`**：`../../secret 照片#1.png` → `secret_1.png`。安全性没问题，但中文原名会丢失、极端情况下同名互相覆盖；`sanitizeFileName` 的 `fallbackExt` 恒为 `.png`。
- **`ctx.log.debug` 会打印响应体前 200 字符**，其中含 `delete_url`（等同删除凭据）。
- **全部失败时抛出的 message 固定为"请检查网络连接和服务状态"**，会把类型不支持/超限说成网络问题（真实原因只在 notification 与日志里）。
- 大小限制统一为 **5MB**（代码、README 正文与 FAQ 现已一致，勿再写 10MB）。