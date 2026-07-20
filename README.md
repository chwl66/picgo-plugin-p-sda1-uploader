# picgo-plugin-p-sda1-uploader

使用Copilot编写的PicGo 插件，支持上传图片到 [p.sda1.dev](https://p.sda1.dev/) 图床。

[![npm](https://img.shields.io/npm/v/picgo-plugin-p-sda1-uploader?style=flat-square)](https://www.npmjs.com/package/picgo-plugin-p-sda1-uploader)
[![GitHub package.json version](https://img.shields.io/github/package-json/v/chwl66/picgo-plugin-p-sda1-uploader?style=flat-square&label=github%20version)](https://github.com/chwl66/picgo-plugin-p-sda1-uploader)
[![GitHub stars](https://img.shields.io/github/stars/chwl66/picgo-plugin-p-sda1-uploader?style=social)](https://github.com/chwl66/picgo-plugin-p-sda1-uploader)

## 安装

### PicGo CLI 安装

```bash
picgo install p-sda1-uploader
```

### PicGo UI 安装

在 PicGo 设置界面，搜索 `p-sda1-uploader` 并安装，或手动导入本地插件。

### npm 安装

```bash
npm install picgo-plugin-p-sda1-uploader --save
```

## 使用方法

1. 安装插件后，不需要配置，直接在 PicGo 的“图床设置”中选择 `流浪图床`。
2. 上传图片即可自动使用 p.sda1.dev 图床。

## 返回结果

- 上传成功后，返回图片的直链。
- 图片直链格式如：  
  ```
  https://p.sda1.dev/26/xxxxxx/your_image.png
  ```


## 相关链接

- [p.sda1.dev 官网](https://p.sda1.dev/)
- [PicGo 官方文档](https://picgo.github.io/PicGo-Core-Doc/)

---

如有问题欢迎提 issue
