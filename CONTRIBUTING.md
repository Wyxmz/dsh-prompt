# 贡献指南

感谢你愿意改进 dsh-idle-alert。改动请尽量小而聚焦，并带上验证。

## 开发环境

- Node.js ≥ 18（项目**零运行时依赖**，不需要 `npm install`）
- 一个能跑起来的 DSH（要真机验证客户端行为时才需要）
- 安装到本地 DSH 见 [README 的安装一节](./README.md#安装)

## 提交前必做

```bash
node test/alert.test.mjs   # 客户端逻辑
node test/host.test.mjs    # 宿主端
npm test                   # 两个都跑
```

测试不联网、不需要 DSH 在运行。改了行为就顺手改测试：

- `assets/alert.js`（空闲计时 / 播放 / 打断）→ `test/alert.test.mjs`
- `lib/index.js`（路由 / 挂起判定 / 注入）→ `test/host.test.mjs`

## 代码风格

- 纯 ESM（`"type": "module"`），不引入依赖
- `assets/alert.js` 是被内联注入的浏览器脚本，保持**无构建**的普通 JS（ES5 风格写法为主）
- 2 空格缩进、LF、单引号（见 `.editorconfig`）
- 注释写清「为什么这么做」，而不是复述代码

## 改动需要注意的坑

- **`assets/alert.js` 是内联注入的**，改完必须重启 DSH 才生效（不是刷新页面）
- `assets/sound.json` 是宿主每次请求热读的，改完刷新页面即可
- 新增 HTTP 路由时记得走已有的信任栅栏（`rejected()`），只服务回环 Host
- 别把个人绝对路径写进配置文件

## 音频素材

请**不要**向本仓库提交新的第三方版权音频（游戏音效、商业音乐等）。
`assets/alert.m4a` 是历史遗留的示例音效，详见 [NOTICE.md](./NOTICE.md)；
替换它时请使用你自己创作或有明确再分发许可的音频。

## 提交信息

用一句话说清「改了什么、为什么」，例如：

```
修复 pending.json 在 turn/start 后仍残留挂起的问题
```

## 许可证

提交贡献即表示你同意以 [MIT](./LICENSE) 许可证发布你的贡献。
