# DNCS

DNCS 是一个 Android Root 模块，通过 UID 级 IPv4/IPv6 防火墙规则控制应用联网，并提供 WebUI 管理界面。

## 功能

- 管理用户应用、系统应用和共享 UID 应用的联网状态
- 使用 `iptables` 与 `ip6tables` 的 `owner --uid-owner` 规则阻断流量
- 双栈规则事务、失败回滚和开机自动恢复
- 配置备份、还原与运行日志

## 安装

1. 从 [Releases](https://github.com/TheKingBucket001/DNCS/releases) 下载模块 ZIP，不要解压。
2. 在 KernelSU 管理器的模块页面选择该 ZIP 安装。
3. 重启设备，在模块页面找到 DNCS 并点击“打开”。

更新安装会保留现有断网配置、调试状态和运行日志。

## 更新

从 `0.1.0` 开始，DNCS 可由 KernelSU 管理器直接检查新版本。更新信息由本仓库的 [`update.json`](update.json) 提供，不依赖 KernelSU 官方模块仓库。

## 使用

- 点击刷新按钮扫描当前用户应用、系统应用和共享 UID。
- 调整应用开关后，点击底部“保存并应用设置”写入规则。
- 共享 UID 开关会同时影响该 UID 下的全部应用，无法按包名单独放行。
- 安装、卸载应用或共享 UID 成员变化后，点击刷新按钮更新应用清单。
- 菜单中的“恢复网络”会清除 DNCS 防火墙链并放行全部应用。

## 兼容性

DNCS 主要面向 KernelSU，并保留其他 Root 环境的基础适配。实际兼容性会受系统、WebView 和防火墙实现影响，建议安装前运行发行版附带的兼容性自检脚本。

## 构建

需要 Node.js 20 或更高版本：

```sh
npm ci
npm test
npm run package
npm run verify:package
```

生成的模块包和 SHA256 校验文件位于 `dist/`。

## 许可证

本项目采用 [GNU General Public License v3.0](LICENSE)，SPDX 标识为 `GPL-3.0-only`。
