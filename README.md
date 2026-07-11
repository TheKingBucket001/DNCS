# DNCS

DNCS 是一个 Android Root 模块，通过 UID 级 IPv4/IPv6 防火墙规则控制应用联网，并提供 WebUI 管理界面。

## 功能

- 管理用户应用、系统应用和共享 UID 应用的联网状态
- 使用 `iptables` 与 `ip6tables` 的 `owner --uid-owner` 规则阻断流量
- 双栈规则事务、失败回滚和开机自动恢复
- 配置备份、还原与运行日志

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

生成的模块包位于 `dist/`，可在支持的 Root 管理器中安装。

## 许可证

本项目采用 [GNU General Public License v3.0](LICENSE)，SPDX 标识为 `GPL-3.0-only`。
