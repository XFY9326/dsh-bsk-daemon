# dsh-bsk-daemon

一个 DeepSeek Harness（DSH）bundle，让 **BrowserSkill 的 `bsk` 桥接守护进程**在 Windows 上拥有与 DSH 相同的生命周期：随 DSH 启动、随 DSH 退出、崩溃后有限次自动重启，并且绝不会误碰别人启动的 daemon。

[English](README.md) · [中文 Agent 说明](AGENTS.zh.md) · [Agent instructions](AGENTS.md)

---

## 它解决什么问题

BrowserSkill 通过本地 `bsk` daemon 向 DSH 提供 `bsk_*` 浏览器自动化工具。在 Windows 上，这个 daemon **无法从 DSH 的工具沙箱内启动**：

- 沙箱子进程无法从 Windows 作业对象（job object）中 breakaway；
- 沙箱内无法写入 `~/.bsk`；
- 沙箱内无法打开 daemon 的 IPC 命名管道。

因此 daemon 必须由非沙箱进程拉起。没有本 bundle 时，常见做法是让用户自己开一个控制台执行 `bsk daemon start --foreground` 并一直保持，或用计划任务维持一个比 DSH 活得更久的进程。

本 bundle 把这份职责移进 DSH 宿主进程：daemon 成为 DSH 的子进程，生命周期与 DSH 一致。

## 功能

| 行为 | 说明 |
| --- | --- |
| 启动 | 插件加载时以宿主子进程方式运行 `bsk daemon start --foreground --daemon-idle 30d`（可配置） |
| 停止 | 插件卸载 / DSH 退出时，执行 `bsk daemon stop` 优雅停止，等待超时后再强制结束 |
| 归属判定 | 只对自己拉起的子进程发信号：仅当 `daemon.json` 记录的 pid 等于自己的子进程时才走 CLI 停止 |
| 已有 daemon | 若同一 `BSK_HOME` 下已有可连接的 daemon，则完全不接管、不重复启动 |
| 崩溃处理 | 2 秒后重启，连续最多 5 次；daemon 稳定运行 60 秒后重启预算归零 |
| 配置校验 | 内置零依赖标准 schema：未知字段或非法值会让插件加载失败并给出明确原因 |
| 宿主启动安全 | daemon 出问题不会阻止 DSH 启动——只记录日志，插件保持静默 |

## 环境要求

- Windows 10/11
- 支持 profile bundle 的 DeepSeek Harness（已验证 `@deepseek-ai/dsh` **0.2.1-rc.2**）
- [BrowserSkill](https://github.com/Tencent/BrowserSkill) 扩展与 `bsk` CLI（已验证 **0.3.3**）
- `bsk` 可执行文件在 `PATH` 中，或在行配置里写绝对路径
- 一个有效的 DSH profile（bundle 会向该 profile 写入 `link:` 依赖）

## 安装

1. 把仓库克隆到一个**不会被移动或删除**的目录（DSH profile 链接的是这个目录）：

   ```powershell
   git clone https://github.com/XFY9326/dsh-bsk-daemon.git C:\Tools\dsh-bsk-daemon
   ```

2. 让 DSH Agent 用内置 `plugin_manager` 工具，以绝对路径安装该 bundle：

   > 用 `plugin_manager` 的 `install_bundle` 安装 `C:\Tools\dsh-bsk-daemon` 这个 bundle。

   该工具会向当前 profile 写入 `link:` 依赖、应用 bundle 自带的 patch，并应返回 `application: applied`。因为是正规 bundle 依赖，后续 pnpm 安装其他插件**不会**把它 prune 掉。

3. 验证：

   ```powershell
   bsk status --json
   Get-Process bsk
   ```

   `bsk status --json` 应显示 daemon 的 pid、`ws_port` 和已连接的浏览器。插件行在 DSH 设置 → 插件 中显示为 **bsk 守护进程托管** / **bsk Daemon Supervisor**。

通常不需要重启 DSH（新 bundle 通过 HMR 即时生效）；若插件行未出现，重启 DSH。

### 不通过 Agent 工具手动安装

推荐用 `plugin_manager`，因为它会同时维护 profile 的依赖与 lockfile。手动安装的等价状态是：在 profile `package.json` 中写入 `link:` 依赖，并让本 bundle 的 `cordis.patch.yml` 生效。手改 profile 文件容易出错，请优先使用工具。

## 配置

bundle 只插入一行：

```yaml
- id: bsk-daemon
  name: 'dsh-bsk-daemon'
```

不写 `config` 时的默认值：

| 字段 | 默认值 | 含义 |
| --- | --- | --- |
| `bskPath` | `bsk` | `PATH` 中的可执行文件名，或绝对路径 |
| `bskHome` | `$BSK_HOME` 或 `~/.bsk` | `daemon.json`、IPC 管道与日志所在目录 |
| `args` | `daemon start --foreground --daemon-idle 30d` | 传给 `bskPath` 的参数 |

需要自定义时，请在**安装前**编辑本 bundle 的 [`cordis.patch.yml`](cordis.patch.yml)：

```yaml
- insert:
    - id: bsk-daemon
      name: 'dsh-bsk-daemon'
      config:
        bskPath: 'C:\Tools\bsk\bsk.exe'
        bskHome: 'C:\Users\me\.bsk'
        args: [daemon, start, --foreground, --daemon-idle, 30d]
```

行配置是**整体替换**，用到的字段要全部写全。若你希望 DSH 完全不启动 daemon（例如你自己维护一个共享 daemon），请禁用该行，而不是改指向别处。

## 验证

```powershell
# 1. daemon 是否在服务？
bsk status --json

# 2. 它的父进程是不是 DSH 宿主？
Get-CimInstance Win32_Process -Filter "Name='bsk.exe'" | Select-Object ProcessId, ParentProcessId, CommandLine

# 3. daemon 自身日志
Get-Content "$env:USERPROFILE\.bsk\daemon.log.*" -Tail 20
```

预期：只有一个 `bsk.exe`，父进程为 DSH 进程；回环端口（默认 `52800`）处于监听；`daemon.json` 中含 `sock_path` 与 `host_managed: true`。

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
└── 插件行：bsk-daemon（dsh-bsk-daemon）
    └── bsk.exe daemon start --foreground --daemon-idle 30d
        ├── ~/.bsk/daemon.json      （pid、sock_path、ws_port）
        ├── \\.\pipe\bsk-daemon-*   （IPC）
        └── ws://127.0.0.1:52800    （浏览器扩展）
```

启动时先读 `daemon.json` 并尝试连接 `sock_path`，确认没有可用 daemon 才启动，因此不会与其他宿主或手动启动的 daemon 重复。关闭时只有在 `daemon.json` 记录的 pid 等于自己的子进程时才调用 CLI 停止，避免误杀外来 daemon。

## 常见问题

| 现象 | 排查 |
| --- | --- |
| `bsk_*` 工具仍提示 daemon 不可用 | `bsk-daemon` 行是否启用？执行 `bsk status --json`；在 DSH 日志里搜 `[bsk-daemon]` |
| daemon 立刻退出 | 手动执行配置的命令（`bsk daemon start --foreground`）看报错；检查 `bskPath` |
| 出现两个 daemon | 插件只管理自己的子进程，外来 daemon 会被刻意保留；确认是陈旧的再自行停止 |
| 装了别的插件后本插件消失 | 正规 bundle 依赖不应如此；若是仓库目录被移动/删除，重新安装 |
| 反复重启后彻底静默 | 连续失败 5 次后放弃；修好根因后重启 DSH（或重启用该 bundle） |
| `bsk status` 正常但 `bsk_*` 工具失败 | 重启 DSH，让 browser-skill 插件重新连接托管 daemon |

## 卸载

让 DSH Agent 执行 `plugin_manager` 的 `remove_bundle`（target `dsh-bsk-daemon`）；只想停用可改为禁用 bundle。手动删除 profile 依赖会残留插件行。

## 安全说明

- 只启动你配置的 `bsk` 可执行文件，不下载、不执行安装脚本。
- 不新增任何网络监听；回环端口与 IPC 管道属于 BrowserSkill 自身。
- 不读取、不保存任何凭据；配置 schema 仅三个普通字段。

## 开发

```powershell
node --test test/     # 零依赖测试（node:test）
```

无构建步骤，`index.js` 即发布内容。

## 关键词

`dsh`、`deepseek-harness`、`cordis`、`bundle`、`browserskill`、`bsk`、`daemon`、`browser-automation`、`windows`

## 许可证

[MIT](LICENSE)
