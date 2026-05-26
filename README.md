# WX 透视工具

一个本地桌面应用，用来可视化检索本机微信聊天记录，并辅助统计学生请假记录。

## 功能

- 全局搜索本地微信文字消息
- 默认按最新时间排序，同一分钟内私聊优先、群聊靠后
- 支持只看私聊、只看群聊、按会话筛选
- 搜索结果自动隐藏文件传输助手、XML、合并聊天记录等噪声
- 点击结果查看前后文
- 按联系人 / 群成员统计请假命中
- 本地 SQLite 索引，聊天内容不上传

## 使用方式

### 直接打开

Windows 上可以直接运行：

```text
WX透视工具.exe
```

这个 exe 是本地启动器，会启动当前目录里的 Electron 应用。
第一次从 GitHub 下载源码压缩包后，请先在目录里运行 `npm install`，再双击 exe。

### 从源码运行

先安装依赖：

```bash
npm install
```

然后启动：

```bash
npm start
```

## 前置依赖

- 已安装并登录微信桌面版
- 已安装 `wx-cli`
- Node.js 18 或更高版本

如果还没有安装 `wx-cli`，可以先执行：

```bash
npx skills add jackwener/wx-cli
```

## 数据与隐私

本项目只在本机读取和索引聊天记录，默认数据库位于系统应用数据目录，例如：

```text
C:\Users\<用户名>\AppData\Roaming\wx-visual-search\wx-visual-search.sqlite
```

数据库、日志、`node_modules` 不会提交到 GitHub。

## 开发检查

```bash
node tests/search-behavior.test.js
node --check src/indexer.js
node --check src/renderer.js
```
