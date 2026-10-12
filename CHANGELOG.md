# 更新日志

本文件格式参考 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，
版本号遵循[语义化版本](https://semver.org/lang/zh-CN/)。

## [Unreleased]

## [0.1.0] - 2026-10-12

首个公开版本。

### 新增

- 宿主端跟踪「等待用户交互」的挂起状态：`approval/asked`（授权请求）与
  `ask_user_question`（提问请求），经 `GET /dsh-idle-alert/pending.json` 暴露给页面
- 客户端空闲检测：出现挂起请求后，若 20 秒内没有鼠标移动就播放提醒音
- 播放期间移动鼠标 → 立刻停止（先 30 ms 淡出，避免咔哒爆音）
- 计时期间请求被处理掉 → 取消提醒；每个请求只提醒一轮
- 音频走 Web Audio（`GainNode` + `AudioBufferSourceNode`），支持 `gain > 1` 与平滑打断
- `assets/sound.json` 热配置：提醒音来源（`path` 绝对路径 / `windowsMediaDir` + `file`
  / 插件自带 `assets/file`）、`gain`、`idleMs`，改完刷新页面即生效，无需重启
- 内置提醒音 `assets/alert.m4a`，既是默认音也是配置失效时的兜底音
- 零依赖的单元测试：`test/alert.test.mjs`（客户端逻辑）、`test/host.test.mjs`（宿主端）
- 安装/卸载脚本 `scripts/install.ps1`、`scripts/uninstall.ps1`（自动探测 DSH profile）

[Unreleased]: https://github.com/Wyxmz/dsh-prompt/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/Wyxmz/dsh-prompt/releases/tag/v0.1.0
