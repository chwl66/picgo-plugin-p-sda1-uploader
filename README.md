# PicGo Plugin - p-sda1-uploader

[![npm version](https://badge.fury.io/js/picgo-plugin-p-sda1-uploader.svg)](https://badge.fury.io/js/picgo-plugin-p-sda1-uploader)
[![license](https://img.shields.io/npm/l/picgo-plugin-p-sda1-uploader.svg)](https://github.com/chwl66/picgo-plugin-p-sda1-uploader/blob/main/LICENSE)

PicGo 插件，用于将图片上传到流浪图床 (p.sda1.dev) 服务。

## ✨ 特性

- 🚀 **并发上传** - 支持多张图片同时上传，提升效率
- 🔄 **智能重试** - 自动重试失败的上传，最多重试 3 次
- 📊 **详细统计** - 提供完整的上传成功/失败统计信息
- 🛡️ **安全验证** - 文件大小和类型验证，防止无效上传
- 📝 **完整日志** - 详细的上传过程日志，便于问题排查
- ⚡ **高性能** - 优化的代码结构，更快的响应速度

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
- 最大重试次数：3次

## 🔧 配置选项

当前版本无需额外配置，插件会使用默认设置：

- **API 地址**: `https://p.sda1.dev/api/v1/upload_external_noform`
- **超时时间**: 30秒
- **重试次数**: 3次
- **文件大小限制**: 5MB

## 📝 更新日志

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

A: 插件会自动重试 3 次。如果仍然失败，请检查：
- 网络连接是否正常
- 图片文件是否符合格式和大小要求
- p.sda1.dev 服务是否正常

### Q: 支持哪些图片格式？

A: 支持 JPEG、PNG、GIF、WebP 格式，最大 10MB。

### Q: 可以批量上传吗？

A: 是的，插件支持并发批量上传，会同时处理多张图片。

## 🐛 问题反馈

如果遇到问题，请在 [GitHub Issues](https://github.com/chwl66/picgo-plugin-p-sda1-uploader/issues) 中反馈，并提供：

- PicGo 版本
- 插件版本
- 错误日志
- 复现步骤