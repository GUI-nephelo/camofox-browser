# OS Profile 持久化模式（persistence.mode = "os-profile"）

> 本文档说明 fork 分支 `feat/os-profile-persistence` 相对上游 `jo-inc/camofox-browser@master` 的唯一行为差异、启用方式与风险边界。为向上游提 PR 准备。

## 一句话

默认 `storageState` 模式下**一切行为与上游逐字节一致**；显式切到 `os-profile` 后，每个 `userId` 独占一个 Firefox 进程 + 磁盘 profile 目录，登录态由浏览器自身持久化——**零 Playwright 协议层状态注入**。

## 为什么需要 os-profile

storageState 恢复登录态必须调用 `context.addCookies()`（/ 或 `addInitScript`），这是 **Playwright 协议调用**，与"用户自然打开浏览器后逐步产生 cookie"的时序特征不同，理论上可被页面侧指纹检测（注入时序 vs 自然导航）。OS profile 模式下 cookie 存在 Firefox 自己的 `cookies.sqlite` 里，浏览器进程启动即加载，协议层观察不到任何恢复动作。

对上游维护者：#6525 被拒的理由是 IndexedDB 覆盖与多租户成本——本实现针对两者：
1. **多租户成本**：每个 userId 一个独立进程，内存按需增长、进程树互不污染，不依赖上游"1 browser + N context"假设；`MAX_SESSIONS` 继续兜底。
2. **IndexedDB 覆盖**：OS profile 天然持久化 IndexedDB（含不可序列化结构），无需 `storageState({ indexedDB: true })` 的采样式快照。
3. **差异化场景**：单用户唯一浏览器 + VNC 人工共控（登录/验证码由人完成），隐身是硬需求而非偏好——这正是 #10992 讨论的 persistent profiles + VNC handoff 场景。

## 启用

方式一（环境变量）：

```bash
export CAMOFOX_PERSISTENCE_MODE=os-profile
export CAMOFOX_PRIMARY_PROFILE=/home/me/.camo/profiles/agent-main   # 主身份 profile（已有目录直接复用）
export CAMOFOX_PRIMARY_USER_ID=agent-main                            # 该 userId 使用 PRIMARY_PROFILE
export CAMOFOX_OS_PROFILE_DIR=~/.camofox/os-profiles                 # 其他 userId 的父目录（默认值）
npm start
```

方式二（camofox.config.json）：

```json
{
  "persistence": { "mode": "os-profile" }
}
```

env 变量覆盖文件配置。两个 mode 取值：`storageState`（默认）/ `os-profile`。

### userDataDir 解析规则

| userId | 目录 |
|---|---|
| 等于 `CAMOFOX_PRIMARY_USER_ID` | `CAMOFOX_PRIMARY_PROFILE`（原样 resolve，可为任意已有 profile） |
| 匹配 `^[a-z0-9][a-z0-9._-]{0,63}$`（大小写不敏感） | `<OS_PROFILE_DIR>/<userId>` |
| 其他（含路径穿越尝试） | `<OS_PROFILE_DIR>/u-<sha256(userId)[0:32]>` |

profile 目录首次使用时自动 `mkdir -p`。默认 `~/.camofox/os-profiles` **不在系统临时目录**，不会被 tmp-cleanup 扫描（`playwright_firefoxdev_profile-` pattern 只匹配 tmpdir 顶层）。

## 行为差异清单（os-profile 模式）

| 方面 | storageState（默认） | os-profile |
|---|---|---|
| 浏览器进程 | 1 个全局进程 | 每 userId 一个进程 |
| context 生命周期 | 每会话 `newContext()`，随 session 关闭 | 进程级 context，`session.context.close()` 即关闭整个浏览器进程（预期行为） |
| 登录态恢复 | `session:creating` hook 注入 storageState | 无注入——Firefox 从 profile 自行加载 |
| IndexedDB | 需 opt-in，快照式 | 完整持久化 |
| persistence 插件 | 启用（checkpoint/restore/bootstrap cookies） | storageState hooks 全部早退；`DELETE /sessions/:userId/storage_state` 返回 404（路由未注册） |
| cookie 导入 API | 可用 | **可用**（`context.addCookies` 仍在，属于显式用户操作而非隐式恢复） |
| 代理轮换 | per-session（每个 context 独立代理） | **launch 级**（per-user），`canRotateSessions` 的 session 粘性不可用 |
| VNC 插件 | 可用 | 可用（`ENABLE_VNC=1` 时 Xvfb 有头模式照常） |
| 内存压力重启 | 关进程重启浏览器 | 只重置 primary 句柄；其他用户进程由各自 session 生命周期管理 |
| `/health`、`browserConnected` | 全局 browser | primary 用户的 browser 句柄语义 |

## 已知限制 / 风险

1. **每用户一个 Firefox 进程**：`MAX_SESSIONS=50` 的服务器若 50 个 userId 并发，是 50 个进程而非 50 个 context。部署前用 `MAX_SESSIONS` / `MAX_CONCURRENT_PER_USER` 限制总内存。单用户场景（本项目目标）无此问题。
2. **代理会话粘性失效**：多代理轮换部署（`PROXY_STRATEGY=backconnect`）下，os-profile 用户的出口 IP 是 launch 级的。GeoIP 回退逻辑不变。
3. **profile lock**：同一 userDataDir 同时只能被一个 Firefox 进程使用。确保旧进程已退出再重启服务（systemd 服务 `Restart=on-failure` 天然满足）。
4. **storage_state 导出/重置端点在 os 模式不可用**：状态在文件系统里，直接备份/删除 profile 目录即可。
5. **`_browserPid` / 进程树强杀降级**：playwright 1.62 已移除 `browser.process()`，os 模式依赖 `closeSession → context.close()` 的优雅关闭；进程树强杀兜底（`browserProcessNameRssMb` 名称扫描）仍可用。

## 测试

```bash
npx jest tests/unit/osProfile.test.js     # 新增：路径解析/存活探测/源码契约
npx jest tests/unit/launchCompat.test.js  # 契约已更新（launch 签名 + os 分支断言）
npm run test:unit                          # 全量回归
```

## 与上游的差异面（供 PR review）

| 文件 | 改动 |
|---|---|
| `lib/os-profile.js` | **新增**（~50 行）：路径解析 + mkdir + 存活探测 |
| `lib/config.js` | +4 配置项 + normalize 函数 + env 转发 |
| `camofox.config.json` | +`"persistence": { "mode": "storageState" }` |
| `server.js` | launch 分支 / per-user 单飞 / closeSession 清理 / health 探针分支 / pluginCtx.launchMode |
| `plugins/persistence/index.js` | register() 顶部 os-mode gate（其余零改动） |
| `tests/unit/launchCompat.test.js` | 3 处 marker `launchBrowserInstance()` → `launchBrowserInstance(` + 2 个新测试 |
| `tests/unit/osProfile.test.js` | **新增**（14 tests） |
| `README-OS-PROFILE.md` | **新增**（本文档） |

storageState 代码路径（`lib/persistence.js`、`plugins/persistence/index.js` 的 hooks、`b.newContext(contextOptions)`）逻辑零改动，仅由 `OS_PROFILE_MODE` 常量 gate 分流。

## 考古证据

`git log -S launchPersistentContext` 全历史 0 命中（上游从未使用过该 API），本分支是**新增能力**而非回退。相关上游讨论：#4793（closed）、#6525（closed，维护者反对理由已在本文档回应）、#10992（open，persistent profiles across expiry + VNC handoff）。
