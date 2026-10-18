# dsh-bsk-daemon

[![test](https://github.com/XFY9326/dsh-bsk-daemon/actions/workflows/test.yml/badge.svg)](https://github.com/XFY9326/dsh-bsk-daemon/actions/workflows/test.yml)
[![package](https://img.shields.io/badge/package-GitHub%20Packages-2ea44f?logo=github)](https://github.com/XFY9326/dsh-bsk-daemon/pkgs/npm/dsh-bsk-daemon)

一个 DeepSeek Harness（DSH）bundle，让 **BrowserSkill 的 `bsk` 桥接守护进程**拥有与 DSH 相同的生命周期：随 DSH 启动、随 DSH 退出、崩溃后有限次自动重启，并且绝不会误碰别人启动的 daemon。

支持 **Windows / macOS / Linux**，见[平台支持](#平台支持)。

[English](README.md) · [中文 Agent 说明](AGENTS.zh.md) · [Agent instructions](AGENTS.md)

---

## 它解决什么问题

BrowserSkill 通过本地 `bsk` daemon 向 DSH 提供 `bsk_*` 浏览器自动化工具。部分 agent 宿主的命令沙箱会**回收或禁止**这个 daemon。Windows 上的具体表现：

- 沙箱子进程无法从 Windows 作业对象（job object）中 breakaway；
- 沙箱内无法写入 `~/.bsk`；
- 沙箱内无法打开 daemon 的 IPC 端点。

Linux 上对应的是 `bubblewrap` 一类沙箱会结束命令的子进程。官方给出的做法是：把 daemon 放在持久化的宿主执行环境里，沙箱内通过本地 IPC 连接——这正是“在 DSH 宿主进程内做 supervisor”所提供的能力。

本 bundle 把这份职责移进 DSH 本身：daemon 成为 DSH 的子进程，生命周期与 DSH 一致。

## 平台支持

| 平台 | 状态 | 说明 |
| --- | --- | --- |
| Windows 10/11 x64 | **已端到端实测** | 在真实使用中验证了启动、停止、重启；DSH 异常退出时 job object 也会兜底结束它。 |
| macOS（Apple Silicon / Intel） | 支持，尚未在真机运行 | 同一套代码路径；IPC 是 Unix domain socket，`bsk daemon stop` 与信号处理跨平台。 |
| Linux x64 / ARM64 | 支持，尚未在真机运行 | 同 macOS；bubblewrap 沙箱场景与 Windows 最接近。 |
| Node.js 22+ | CI 矩阵 | 测试在 `ubuntu-latest`、`macos-latest`、`windows-latest` 上以 Node 22、24 运行。 |

测试矩阵已确认：三个操作系统上模块加载、配置校验、effect 注册顺序、可 await 的清理均正常。真实 `bsk` daemon 目前只在 Windows 上跑过；Unix 实机运行需要装有 CLI 与浏览器扩展的机器。

## 兼容性

| 组件 | 支持范围 | 已验证版本 |
| --- | --- | --- |
| DeepSeek Harness | 支持 profile bundle 的 `0.2.x` | `0.2.1-rc.2` |
| Cordis 插件 API | 4.x（`ctx.effect`、标准 schema `Config`） | `4.0.5` |
| BrowserSkill `bsk` | 0.3.x | `0.3.3` |
| Node.js | `>=22` | 22、24（CI）、26（本地） |

不支持 profile bundle 的旧版 DSH 无法加载本包；只有当你的 DSH 支持 `plugin_manager install_bundle` 时才建议使用[本地路径安装](#本地路径安装)。

## 安装

### 从 GitHub Packages 安装

包已发布到 GitHub Packages：`@xfy9326/dsh-bsk-daemon`。GitHub 即使对公开包也要求认证，因此先让 npm 拿到一个有 `read:packages` 权限的 token：

```powershell
npm config set @xfy9326:registry https://npm.pkg.github.com
npm config set //npm.pkg.github.com/:_authToken $env:GITHUB_TOKEN
```

或交互式登录：

```powershell
npm login --scope=@XFY9326 --registry=https://npm.pkg.github.com
```

然后让 DSH Agent 安装该 bundle：

> 用 `plugin_manager` 的 `install_bundle`，从 `https://npm.pkg.github.com` 安装 `@xfy9326/dsh-bsk-daemon@1.0.0`。

工具会把依赖写入当前 profile、应用 bundle patch，并应返回 `application: applied`。也可以直接调用：

```json
{
  "action": "install_bundle",
  "target": "@xfy9326/dsh-bsk-daemon@1.0.0",
  "registry": "https://npm.pkg.github.com"
}
```

不要只用 `pnpm add` / `dsh plugin add` 安装：那样只加了依赖，不会启用 bundle 层。

### 本地路径安装

```powershell
git clone https://github.com/XFY9326/dsh-bsk-daemon.git C:\Tools\dsh-bsk-daemon
```

然后让 DSH Agent 用 `plugin_manager` 的 `install_bundle` 以该绝对路径安装。profile 会记录 `link:` 依赖，安装后不要移动该目录。

### 安装后

```powershell
bsk status --json
```

应能看到 daemon 是 DSH 宿主进程的子进程。插件行在 DSH 设置 → 插件中显示为 **bsk 守护进程托管** / **bsk Daemon Supervisor**。

通常不需要重启 DSH（bundle 通过 HMR 即时生效）；若插件行未出现，重启 DSH。

## 配置

bundle 插入一行且默认不带 `config`：

| 字段 | 默认值 | 含义 |
| --- | --- | --- |
| `bskPath` | `bsk` | `PATH` 中的可执行文件名，或绝对路径 |
| `bskHome` | `$BSK_HOME` 或 `~/.bsk` | `daemon.json`、IPC 端点与日志所在目录 |
| `args` | `daemon start --foreground --daemon-idle 30d` | 传给 `bskPath` 的参数 |

需要自定义时，在**安装前**编辑本 bundle 的 [`cordis.patch.yml`](cordis.patch.yml)：

```yaml
- insert:
    - id: bsk-daemon
      name: '@xfy9326/dsh-bsk-daemon'
      config:
        bskPath: 'C:\Tools\bsk\bsk.exe'
        bskHome: 'C:\Users\me\.bsk'
        args: [daemon, start, --foreground, --daemon-idle, 30d]
```

行配置是**整体替换**。若你希望 DSH 完全不启动 daemon（例如自己维护共享 daemon），请禁用该行。

## 跨平台行为

插件只使用 Node.js 内建模块（`child_process`、`net`、`fs`、`os`、`path`），代码里不需要平台分支：

- **探测**：读取 `daemon.json` 并连接 `sock_path`。Windows 上是命名管道（`\\.\pipe\bsk-daemon-*`），macOS/Linux 上是 Unix domain socket（`~/.bsk/run/daemon.sock`）；`net.connect()` 两者都支持。
- **停止**：三个平台都用同一条 CLI（`bsk daemon stop`），且仅当 `daemon.json` 的 `pid` 等于本插件的子进程时才走该路径，之后才回退到信号。
- **生命周期差异**：Windows 的 job object 在 DSH 被强杀时也会结束 daemon；macOS/Linux 没有该机制，强杀 DSH 会留下孤儿 daemon，下次 DSH 启动会探测到并复用，而不是再起一个。正常退出时两者都由插件停止。
- `windowsHide` 是 Windows 专用 spawn 选项，在其它平台被忽略。

## 验证

```powershell
# daemon 是否在服务？
bsk status --json

# 它是不是 DSH 宿主进程的子进程？（Windows）
Get-CimInstance Win32_Process -Filter "Name='bsk.exe'" | Select-Object ProcessId, ParentProcessId, CommandLine

# macOS/Linux 等价命令
pgrep -fl 'bsk daemon start --foreground'

# daemon 自身日志
Get-Content "$env:USERPROFILE\.bsk\daemon.log.*" -Tail 20   # Windows
tail -n 20 ~/.bsk/daemon.log.*                            # macOS/Linux
```

预期：只有一个 daemon 进程，父进程为 DSH；回环端口（默认 `52800`）处于监听；`daemon.json` 中含 `sock_path` 与 `host_managed: true`。

端到端验证生命周期：

```powershell
# 绕开插件停掉 daemon，插件应在几秒内把它拉回来
bsk daemon stop --json
Start-Sleep 5
bsk status --json
```

## 工作原理

```
DSH 宿主进程
└── 插件行：bsk-daemon（@xfy9326/dsh-bsk-daemon）
    └── bsk daemon start --foreground --daemon-idle 30d
        ├── ~/.bsk/daemon.json      （pid、sock_path、ws_port）
        ├── IPC 端点                （命名管道 / Unix socket）
        └── ws://127.0.0.1:52800    （浏览器扩展）
```

启动时先读 `daemon.json` 并尝试连接 `sock_path`，确认没有可用 daemon 才启动，因此不会与其他宿主或手动启动的 daemon 重复。关闭时只有在 `daemon.json` 记录的 pid 等于自己的子进程时才调用 CLI 停止，避免误杀外来 daemon。

## 常见问题

| 现象 | 排查 |
| --- | --- |
| `bsk_*` 工具仍提示 daemon 不可用 | `bsk-daemon` 行是否启用？执行 `bsk status --json`；在 DSH 日志里搜 `[bsk-daemon]` |
| daemon 立刻退出 | 手动执行配置的命令（`bsk daemon start --foreground`）看报错；检查 `bskPath` |
| 安装 `npm.pkg.github.com` 返回 401/403 | npm token 缺失或没有 `read:packages`，重新做认证步骤 |
| 出现两个 daemon | 插件只管理自己的子进程，外来 daemon 会被刻意保留；确认是陈旧的再自行停止 |
| `bsk status` 正常但 `bsk_*` 工具失败 | 重启 DSH，让 browser-skill 插件重新连接托管 daemon |
| 反复重启后彻底静默 | 连续失败 5 次后放弃；修好根因后重启 DSH（或重启用该 bundle） |

## 卸载

让 DSH Agent 执行 `plugin_manager` 的 `remove_bundle`（target `@xfy9326/dsh-bsk-daemon`）；只想停用可改为禁用 bundle。

## 安全说明

- 只启动你配置的 `bsk` 可执行文件，不下载、不执行安装脚本。
- 不新增任何网络监听；回环端口与 IPC 端点属于 BrowserSkill 自身。
- 不读取、不保存任何凭据；配置 schema 仅三个普通字段。

## 开发

```powershell
node --test     # 零依赖测试（node:test）
npm pack --dry-run    # 查看实际发布文件
```

CI：[`.github/workflows/test.yml`](.github/workflows/test.yml) 在 Ubuntu、macOS、Windows 上以 Node 22 与 24 运行测试。推送 `v*` 标签会触发 [`.github/workflows/publish.yml`](.github/workflows/publish.yml)：先测试，再发布到 GitHub Packages，并用打包的 tarball 创建 GitHub Release。

## 关键词

`dsh`、`deepseek-harness`、`cordis`、`bundle`、`browserskill`、`bsk`、`daemon`、`browser-automation`、`windows`、`macos`、`linux`、`cross-platform`

## 许可证

[MIT](LICENSE)
