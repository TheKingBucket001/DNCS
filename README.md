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

## 使用

- 点击刷新按钮扫描当前用户应用、系统应用和共享 UID。
- 调整应用开关后，点击底部“保存并应用设置”写入规则。
- 共享 UID 开关会同时影响该 UID 下的全部应用，无法按包名单独放行。
- 安装、卸载应用或共享 UID 成员变化后，点击刷新按钮更新应用清单。
- 菜单中的“恢复网络”会清除 DNCS 防火墙链并放行全部应用。
- WebUI 无法打开时，可以在 Root 管理器中禁用 DNCS 后重启，系统重启会清除当前内存中的规则。

## 兼容性

DNCS 没有写死 Android 16 或 ColorOS 16，也没有调用 ColorOS 私有接口。完整真机验证目前仅覆盖：

- Android 16 / ColorOS 16
- KernelSU Manager v3.2.5
- Chromium WebView 149
- legacy iptables 1.8.11

KernelSU 是当前完整验证目标。代码包含 APatch 的模块与 WebUI Bridge 兼容路径，但尚未完成 APatch 真机验证。Magisk 可使用模块脚本，但官方 Manager 不提供 KernelSU 式模块 WebUI，因此不属于完整 WebUI 支持目标。

目标设备必须提供 IPv4/IPv6 的 `iptables`、`ip6tables`、`iptables-restore`、`ip6tables-restore` 以及 `owner` 匹配能力。其他 Android 版本和 ROM 需要实际测试后才能列为已验证兼容。

## 构建

需要 Node.js 20 或更高版本：

```sh
npm ci
npm test
npm run package
npm run verify:package
```

生成的模块包和 SHA256 校验文件位于 `dist/`。发布 ZIP 只允许包含 11 个明确列出的模块文件，运行时配置、缓存和日志不会进入安装包。

## 许可证

本项目采用 [GNU General Public License v3.0](LICENSE)，SPDX 标识为 `GPL-3.0-only`。
