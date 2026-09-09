# PicGo Plugin - p-sda1-uploader

[![npm version](https://badge.fury.io/js/picgo-plugin-p-sda1-uploader.svg)](https://badge.fury.io/js/picgo-plugin-p-sda1-uploader)
[![license](https://img.shields.io/npm/l/picgo-plugin-p-sda1-uploader.svg)](https://github.com/chwl66/picgo-plugin-p-sda1-uploader/blob/main/LICENSE)

PicGo 插件，用于将图片上传到流浪图床 (p.sda1.dev) 服务。

## ✨ 特性

- 🚀 **并发上传** - 支持多张图片同时上传，默认并发上限 3
- 🔄 **智能重试** - 自动重试可恢复错误（网络异常/超时/5xx/429），最多重试 3 次
- 📊 **详细统计** - 提供完整的上传成功/失败统计信息
- 🛡️ **安全验证** - 文件大小、类型（魔数/MIME）与返回 URL 校验
- 📝 **完整日志** - 详细的上传过程日志，便于问题排查
- 🔒 **凭证脱敏** - 删除链接 `delete_url` 不会出现在日志与通知里
- ⚡ **高性能** - 有限并发与失败隔离，避免批量上传互相拖垮

## 📦 安装

### 通过 PicGo GUI 安装

1. 打开 PicGo 应用
2. 进入「插件设置」
3. 搜索 `p-sda1-uploader`
4. 点击安装

### 通过命令行安装

```bash
# 全局安装 PicGo
npm install picgo -g

# 安装插件
picgo install p-sda1-uploader
```

### 兼容性

已在下列 PicGo 核心版本上跑通集成测试（`npm test`）：

- `picgo@2.0.3`（基于 `request` 的请求实现）
- `picgo@3.0.2`（基于 axios 的请求实现）

## 🔧 使用方法

1. 安装插件后，在 PicGo 的「图床设置」中选择「流浪图床」
2. 无需额外配置，直接使用
3. 上传图片时会自动使用 p.sda1.dev 服务

## 📋 支持的文件格式

- JPEG (.jpg, .jpeg)
- PNG (.png)
- GIF (.gif)
- WebP (.webp)

## 📏 文件限制

- 最大文件大小：5MB
- 超时时间：30秒
- 最大重试次数：3次（仅可恢复错误）
- 并发上限：3

## 🔧 配置选项

当前版本无需额外配置，插件会使用默认设置：

- **API 地址**: `https://p.sda1.dev/api/v1/upload_external_noform`
- **超时时间**: 30秒
- **并发上限**: 3
- **重试次数**: 3次（仅可恢复错误）
- **文件大小限制**: 5MB

## ⚠️ 已知限制

下面几条来自对 p.sda1.dev 与 PicGo 核心的实测，不是插件可以自己绕开的实现选择：

- **文件名会折叠为 ASCII**：只保留 `A-Za-z0-9._-`，其余字符连同中文一起替换为 `_`。
  实测向图床提交中文文件名会返回 `500 {"code":"error","message":"Backend error."}`
  （探测样本只有一次，站点首页同时刻正常），至少可以确定非 ASCII 文件名不可靠，
  因此折叠是必需步骤，不能去掉。
- **同名图片不会互相覆盖**：返回地址形如 `https://p.sda1.dev/<uid>/<随机目录>/<文件名>`，
  中间目录既不随文件名也不随内容变化，折叠成同名（如两个中文原名都变成 `__.png`）
  的图片仍落在不同目录。
- **退避不读 `Retry-After`**：PicGo 的 `ctx.request` 失败时只给出
  `{ statusCode, response: { status, statusCode, body } }`，响应头已被核心丢弃
  （`picgo@2.0.3` 与 `picgo@3.0.2` 实测一致），插件取不到该字段，只能按固定步长退避。
- **重试不是幂等操作**：请求体已送达图床、但响应在回程超时或连接中断时，重试会多存一份，
  而这份副本没有对应的删除链接，无法自动清理。图床未提供幂等键，插件只能在日志和通知里
  提示核对，不能根治。

## 📝 更新日志

### v2.0.3

- 🐛 修复超时 / DNS 失败 / 连接被拒不触发重试：PicGo 把这类错误归一成 `statusCode: 0`，此前被当成合法 HTTP 状态跳过了传输层判定
- 🔄 重试产生的重复文件不再静默：命中"响应丢失"型失败时输出警告并提示核对副本
- 🔒 日志与通知不再写入 `delete_url`
- 💬 全部失败时给出真实原因，类型不支持 / 体积超限不再被提示为网络问题
- 🧪 新增零第三方依赖的集成测试（44 项）并接入 `npm test`，发布工作流增加测试门禁
- 📄 PicGo 版本下界明确为 `>=2.0.3`，补充 `picgo@2.0.3` / `picgo@3.0.2` 兼容性说明与已知限制

### v2.0.2

- 📐 按 PicGo SHOULD 规范对齐 uploader 契约
- 🏷️ keywords 增加 `picgo-plugin` / `picgo-gui-plugin`，导出声明 `uploader` id
- 📋 成功时同步写入 `img.url`，并清理 `buffer` / `base64Image`
- 🧹 部分失败时从 `ctx.output` 移除失败项，避免空链接
- 🔔 全失败/部分失败通过 GUI notification 提示

### v2.0.1

- 🔧 修复 CI：移除 main 推送自动升版发布，避免发版环路
- 🛡️ 增强校验：魔数类型识别、空文件拒绝、返回 URL https/主机校验
- 🔄 智能重试：仅对 429/5xx/超时/网络错误重试
- 🚀 有限并发：默认并发上限 3
- 🧹 净化 filename，正确处理 data URL / URL-safe base64
- 📚 统一版本号、User-Agent、文档与实现

### v2.0.0 (2025-01-10)

- 🚀 **重大更新**: 完全重构代码架构
- ✨ 新增并发上传支持
- ✨ 新增智能重试机制
- ✨ 新增文件验证功能
- ✨ 新增详细的上传统计
- 🐛 修复部分上传失败导致全部中断的问题
- 🔧 优化错误处理和日志输出
- 📚 完善文档和注释

### v1.0.10

- 基础上传功能
- 简单错误处理

## 🤝 贡献

欢迎提交 Issue 和 Pull Request！

1. Fork 本仓库
2. 创建特性分支 (`git checkout -b feature/AmazingFeature`)
3. 提交更改 (`git commit -m 'Add some AmazingFeature'`)
4. 推送到分支 (`git push origin feature/AmazingFeature`)
5. 开启 Pull Request

## 📄 许可证

本项目采用 MIT 许可证 - 查看 [LICENSE](LICENSE) 文件了解详情。

## 🔗 相关链接

- [PicGo 官网](https://molunerfinn.com/PicGo/)
- [流浪图床](https://p.sda1.dev/)
- [插件仓库](https://github.com/chwl66/picgo-plugin-p-sda1-uploader)

## ❓ 常见问题

### Q: 上传失败怎么办？

A: 插件会自动重试可恢复错误（最多 3 次）。如果仍然失败，请检查：
- 网络连接是否正常
- 图片文件是否符合格式和大小要求（JPEG/PNG/GIF/WebP，最大 5MB）
- p.sda1.dev 服务是否正常

### Q: 支持哪些图片格式？

A: 支持 JPEG、PNG、GIF、WebP 格式，最大 5MB。会通过文件头魔数识别类型。

### Q: 可以批量上传吗？

A: 是的，插件支持并发批量上传，默认同时处理最多 3 张图片。

## 🐛 问题反馈

如果遇到问题，请在 [GitHub Issues](https://github.com/chwl66/picgo-plugin-p-sda1-uploader/issues) 中反馈，并提供：

- PicGo 版本
- 插件版本
- 错误日志
- 复现步骤
