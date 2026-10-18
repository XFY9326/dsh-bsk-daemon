# AGENTS.zh.md

给 AI 编码 Agent，以及**使用**本 bundle 的 DSH Agent 的说明。
English version: [AGENTS.md](AGENTS.md)。

## 这个仓库是什么

一个单文件的 DeepSeek Harness **bundle**（`dsh-bsk-daemon`），把 BrowserSkill 的 `bsk` 桥接 daemon 作为 DSH 宿主进程的子进程运行。没有构建步骤、没有运行时依赖：`index.js` 由 Cordis loader 直接加载。

```
index.js           插件（导出 name、inject、Config、apply）
cordis.patch.yml   bundle patch：插入行 id "bsk-daemon"
package.json       bundle 清单（dsh.bundle.patch、locale/icon 导出）
locale/en.json     面板标题/描述（英文）
locale/zh.json     面板标题/描述（中文）
icon.svg           面板图标
test/plugin.test.mjs  node:test 测试，无第三方依赖
README.md          用户文档（英文）
README.zh.md       用户文档（中文）
```

## 给 DSH Agent：安装与使用

1. 用户已把本仓库检出到某个绝对路径，例如 `C:\Tools\dsh-bsk-daemon`。
2. 用 `plugin_manager` 工具安装：

   ```json
   { "action": "install_bundle", "target": "C:\\Tools\\dsh-bsk-daemon" }
   ```

   该调用会向当前 profile 写入 `link:` 依赖并应用 bundle patch。以 `application: applied` 作为成功依据；返回 `restart-required` 说明插件行尚未生效。

3. 用 `bsk status --json` 和 `Get-Process bsk`（或平台等价命令）验证：daemon 必须是 DSH 宿主的子进程，并服务于 `~/.bsk/daemon.json` 中记录的回环端口。
4. **不要**在沙箱 shell 里尝试启动 daemon。本 bundle 存在的意义正是：沙箱子进程启动不了它。若 daemon 缺失，应重启/重新安装 bundle 或重启 DSH——不要在工具沙箱内执行 `bsk daemon start`，也不要删除 `~/.bsk` 下的运行时文件。

## 修改本仓库时必须保持的硬约束

1. **只对自己拉起的 daemon 发信号。** 仅当 `daemon.json` 的 `pid` 等于本插件子进程的 pid 时，才能执行优雅停止（`bsk daemon stop`）；否则只结束自己的子进程。
2. **先注册清理，再启动进程。** `ctx.effect(...)` 必须在 `spawn` 之前注册，且 disposer 要 `return` 停止流程的 Promise。Cordis 会 await disposer 返回的 Promise；返回 `undefined` 会让 reload 场景重新出现「旧 daemon 存活、新 fiber 拒绝接管」的竞态。
3. **`apply` 绝不能 reject。** daemon 出问题不允许阻塞 DSH 启动：记录日志并保持静默。
4. **重启预算要能自愈。** daemon 稳定运行一段时间后应重置尝试次数，不能让几次历史崩溃永久关闭监管。
5. **只管理自己拥有的进程。** 若同一 `BSK_HOME` 下已有可连接 daemon，保持不动，不接管、不重启、不kill。
6. **配置保持极简且有校验。** 只有三个字段（`bskPath`、`bskHome`、`args`），由导出的标准 schema 校验；修改 schema 时同步更新默认值与仓库内 `cordis.patch.yml` 的注释。
7. **仓库内不放机器特定信息。** 不放绝对用户路径、不放密钥、不放 `daemon.json` 副本；可移植性放在文档示例里。
8. **不要引入运行时依赖或构建步骤。** bundle 必须能作为 profile 的 `link:` 依赖以纯 ESM 直接加载。

## 开发流程

- 直接编辑 `index.js`，无编译步骤。
- 正在运行的 DSH 宿主会保留已导入的模块。要测试代码改动需重启宿主（bundle patch 在启动时重新读取；HMR 只覆盖 patch 变化，不替换已加载的 JavaScript 模块）。
- 提交前运行测试：

  ```bash
  node --test test/
  ```

- 测试必须保持隔离：使用临时 `BSK_HOME` 和故意不存在的 `bskPath`，因此不会启动或停止真实 daemon。

## 人工验证清单

影响生命周期的改动之后：

```powershell
# 1. 单元测试
node --test test/

# 2. 安装/刷新 bundle 后检查 daemon
bsk status --json
Get-CimInstance Win32_Process -Filter "Name='bsk.exe'" | Select-Object ProcessId, ParentProcessId

# 3. 绕开插件停掉 daemon，插件应在 ~5 秒内重启它
bsk daemon stop --json
Start-Sleep 5
bsk status --json

# 4. 关闭 bundle，daemon 必须退出且端口释放
#    （plugin_manager set_bundle enabled=false），再重新开启
```

提交说明里写**实际观察到的结果**，而不是「应该会怎样」。若某条路径无法验证（例如没有可用的 DSH 宿主），明确说明未验证。

## 发布

1. 修改 `package.json` 中的 `version`。
2. 行为或配置有变化时同步更新 `README.md` / `README.zh.md`。
3. 运行 `node --test test/`。
4. 提交后打 tag `v<version>` 并推送。

## 许可证

MIT，贡献按相同许可证接受。
