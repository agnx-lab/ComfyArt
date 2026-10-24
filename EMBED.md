# ComfyArt 融入 Agnx — 嵌入分析（EMBED.md）

> 上游：`ComfyUI/custom_nodes/ComfyArt`（本机取自 `~/Downloads/ComfyArt-main`，MIT；`bot/`+`api/` 改编自 ComfyTV(MIT)）。
> 上游仓库：https://github.com/jtydhr88/ComfyArt
> 本文档是**准入分析**，不是完成声明。落地进度见文末「落地切片与验收」。

---

## ① 项目一句话能力与边界

**一句话**：ComfyArt 是一个**跑在你自己 ComfyUI 上的 AI 设计画布**——tldraw + React 的无限画布，加一个能直接在画布上动手干活的设计 Agent（出图、改图、排版、做幻灯片/网页/视频），所有推理都在本地 ComfyUI 上跑，无账号、无积分、不上云。

**能力边界（它是什么 / 不是什么）**

| 维度 | 说明 |
|---|---|
| 形态 | ComfyUI 的 **custom_node**（Python 包），在 ComfyUI 的 aiohttp `PromptServer` 上注册 `/comfyart/*` 路由，前端是 Vite 构建的 SPA（`dist/`） |
| 宿主依赖 | **强依赖本机运行中的 ComfyUI（默认 `127.0.0.1:8188`）**。没有 ComfyUI 就只有一个空壳页面：`/comfyart/` 直接被 ComfyUI 提供，所有 `/prompt`、`/view`、`/ws`、`/object_info` 都走 ComfyUI 本体 |
| 模型依赖 | **强依赖本地模型文件**（`qwen_image_2.1_int8_convrot.safetensors`、`z_image_turbo_bf16`、`flux-2-klein-9b`、`minimax_h3_*` 视频模型等，见 README 表格）。**Agnx 侧不可能也不应该代为安装** |
| 自带后端 | `api/`（settings / pdf / thumbs / models）+ `bot/`（Claude Code、Codex、Qwen Code、DeepSeek Harness、Local LLM 五种 provider，走 ACP 或 HTTP）+ SQLite `user/__comfyart/data.db` |
| Agent 后端 | **默认关闭**，需在「Agent 设置」里开 MCP + Agent；Agent 通过 `POST /comfyart/mcp` 操作画布，**画布工具由打开着的 ComfyArt 标签页执行**（页面关了就停） |
| 不做的事 | 不管模型下载/管理；不做 ComfyUI 启动管理；不管 ComfyUI 队列（复用本体队列）；不做账号体系；不做云同步 |
| 许可证 | ComfyArt MIT；**tldraw SDK 不是 MIT**（见 §⑥.2） |

**为什么这条边界对 Agnx 很重要**：ComfyArt 不是一个「独立应用」，而是 **ComfyUI 的一个界面子路由**。它的生命周期天花板 = ComfyUI 的生命周期。所以嵌入问题实质是「**Agnx 如何把邻居 ComfyUI 的一个子树搬进 Tab**」。

---

## ② 与 Agnx 现有能力的重叠 / 缺口

### 重叠（不必重造）

| Agnx 已有 | 与 ComfyArt 的关系 |
|---|---|
| `host.guest.mount` + `direct-iframe` / `proxied-iframe` / `guest-webview` 三策略 | 完备够用，ComfyArt 是标准 Web 页面，无需新策略 |
| `sidecar.ensureTool` 受管进程协议（单行 JSON、`--supervised`、`--force-restart`） | 完备够用；只是 ComfyArt 的 sidecar 是**探活**而非**拉起** |
| `manifest.platforms` + 平台门控文案 | 完备够用，移动端可直接标 `unsupported` |
| `registerCommand` / `sidebarAction` / `openSubAppTab` / `registerMiniApp` | 完备够用 |
| `host.files.*` / `host.config` / `host.storage` | 完备够用（但只在**面板层**，进不了 iframe 里的上游 UI） |
| Tab 级 BrandLogo 加载遮罩 / 氛围着色 | 完备够用 |

### 缺口（真正要处理的）

| # | 缺口 | 严重度 | 说明 |
|---|---|---|---|
| G1 | **ComfyUI 未启动时无降级入口** | 🔴 高 | 上游 `/comfyart/` 只有在 ComfyUI 起着时才存在。ComfyUI 没起 → 根本没有页面可嵌，`guest.mount` 必失败。必须靠 `ensure-comfyart.mjs` 探活 + 面板引导态兜住 |
| G2 | **ComfyUI 未安装时无法自愈** | 🔴 高 | 明确**不做**自动安装（用户硬约束 + 需拉 torch/数 GB 模型）。只能给中文引导 |
| G3 | **嵌页内无宿主能力桥（选目录/选文件/Reveal）** | 🟡 中 | 见 §⑦ 缺口表。ComfyArt 主路径是画布出图，不靠选目录；但「导入 PSD / 上传 PDF / 拖入本地文件」走 `<input type=file>`，在 iframe 内**可用**（浏览器原生），在 Electron `webview` 内也可用，但拿到的是 `File` 没有绝对路径 |
| G4 | **`window.confirm` / `prompt` / `alert` 在 Electron webview 内无宿主壳** | 🟡 中 | 上游有删除确认等交互。Electron `<webview>` 默认会弹原生 dialog（不是静默 null），但样式与宿主不一致；web iframe 内会弹浏览器原生框 |
| G5 | **快捷键被 iframe 吞掉** | 🟡 中 | ComfyArt 大量用 `Cmd+Z`/`Cmd+S`/`Cmd+Shift+Z`/空格平移。宿主 `Cmd+W`/`Cmd+T` 等需要 `iframeShortcutCapture: true` 放行 |
| G6 | **loopback 源在网页端会被升格成 `proxied-iframe`** | 🟡 中 | 见 §③，网页端会经过 Agnx daemon 反代 |
| G7 | **Agent 后端要 `claude`/`codex`/`qwen`/`dsh` 在 ComfyUI 进程的 PATH 里** | 🟢 低 | 默认关闭；开了也不在 Agnx 主路径上 |
| G8 | **ComfyUI 队列与其他 Agent 抢占** | 🟢 低 | 共享同一 ComfyUI，Agnx 的生成任务与 ComfyUI 原生页面互抢队列，属既有事实，不新增风险 |

**结论**：重叠面大，缺口集中在 **G1/G2（生命周期前置条件）** 与 **G3/G4/G5（嵌页第二刀）**。没有任何一项要求改 Agnx core。

---

## ③ 推荐路径：Sub App（不是 core）

### 结论

> **Sub App + `guest` 整站嵌入（`direct-iframe`），sidecar 只做「探活」，不代管 ComfyUI 进程。**

### 为什么是 Sub App 而不是 core

1. **行业场景逻辑**：AI 绘图画布是明确的垂直场景，不是跨 App 复用的协议。按 AGENTS.md 分流规则（协议/Host Services → core；行业场景 → `@getagnx/app-sdk` + `scripts/sub-apps/`），它落子应用。
2. **不需要新宿主能力**：`guest.mount` + `sidecar.ensureTool` + `platforms` 三件套已完备（见 §② 重叠表）。core 没有缺口要补。
3. **生命周期独立**：ComfyArt 的存在与否不应影响 Agnx 主流程；它的失败是**局部失败**（一个 Tab 打不开），不是全局失败。
4. **反例排除**：不推荐 core 的另一个理由是——ComfyArt 的宿主是**第三方进程（ComfyUI）**，Agnx core 不应知道「8188 上有个 ComfyUI」这件事。

### 为什么是「整站 guest」而不是「引擎 + 自画 UI」

ComfyArt 的全部价值在它的画布 UI（tldraw 画布 + 工具条 + Agent 面板 + 68 个 `ui/` 组件）。自画 Tab 等于重写整个前端，违反「迁移优先、禁止从零另造平行核」。所以 **Wrap 整站**是唯一合理选择。

### 挂载策略推导（实测源码，非猜测）

`packages/app/src/workspace-apps/guest/guest-surface-strategy.ts`：

```
resolveGuestSurfaceStrategyForAuth(auth, isElectron):
  auth === "none"                → "direct-iframe"
  auth === "url-token-then-cookie" → isElectron ? "guest-webview" : "proxied-iframe"
  auth === "bearer" | "custom"   → "native-bridge"
```

ComfyArt **没有鉴权**（ComfyUI 本身默认无鉴权，`--enable-cors-header` 都没开），所以：

- `guest.auth = "none"` → **Electron 走 `direct-iframe`（实际渲染成 `<webview>`），网页端走 `direct-iframe`**。
- ⚠️ 网页端还有一层**升格**：`guest-shortcut-relay.ts` 的 `upgradeWebGuestStrategyForShortcutRelay()` —— 当 **`auth:none` + `direct-iframe` + 上游 origin 是 loopback http** 时，网页端会**再升格成 `proxied-iframe`**（以便注入快捷键 relay）。ComfyArt 的 origin 恰好就是 `http://127.0.0.1:8188`，所以：
  - **桌面（Electron）**：`direct-iframe` → 实际是 `persist:agnx-guest-surface-comfyart` 分区下的 `<webview>`
  - **网页（浏览器）**：`direct-iframe` → 升格 `proxied-iframe`（经 Agnx daemon 反代到 8188）
- ✅ **不要**把 `auth` 写成 `url-token-then-cookie`（抄 DSH）。那会让桌面变成 `guest-webview`（需要 token 校验，ComfyArt 没有）、网页变成 `proxied-iframe`（多一层无意义的 token 签发），并且 `parseGuestEnsureToolResult({requireAuthToken:true})` 会**直接拦掉裸 origin**，导致 `GUEST_ENSURE_FAILED`。

### 上游 origin 从哪来

`ensure-comfyart.mjs` 探活成功后返回**裸 origin**（`http://127.0.0.1:8188`），**不带 token**。这正好满足 `auth:"none"` 的 `parseGuestEnsureToolResult({requireAuthToken:false})` 分支。

---

## ④ 要迁的核心模块 / 调用链

**一句话：这一期不迁任何 Python 代码，只迁「路由契约」。** ComfyArt 的 Python 侧完整留在 ComfyUI 的 `custom_nodes/` 里被 ComfyUI 自己加载。

### 4.1 留在上游、不迁（被整站 iframe 覆盖）

| 路径 | 作用 | 为什么不迁 |
|---|---|---|
| `src/`（`App.tsx`、`actions.ts`、`shapes/`、`ui/`×68、`bot.ts`、`llm.ts`…） | 整个画布前端 | 已随 `dist/` 预构建，整站加载 |
| `api/*.py`（`bot*`、`settings`、`pdf`、`thumbs`、`models`、`mcp*`、`chat_store`） | ComfyArt 自带后端 | 由 ComfyUI 进程内注册 `/comfyart/*`，随页面一起可用 |
| `bot/*.py`（`claude_code`/`codex`/`qwen_code`/`local_llm`/`providers`/`_acp`） | Agent provider | 默认关闭，非主路径 |
| `nodes.py`（`ComfyArt Precise UNET Loader`） | ComfyUI 节点 | 画布通过 `/object_info` 自然可见 |
| `workflows/*.json`（13 个工作流） | 生成图/视频 | 走 `/comfyart/workflows/{name}` 路由 |

### 4.2 必须迁 / 必须接的「调用链」

| # | 链路 | 落点 | 说明 |
|---|---|---|---|
| C1 | **Agnx Tab → `host.guest.mount` → ensureTool → 上游 origin** | `.agnx/src/panel.tsx` | 面板只做 container + mount + 引导态 |
| C2 | **ensureTool → 探活 8188 → `GET /comfyart/` 200** | `.agnx/tools/ensure-comfyart.mjs` | **探活，不是拉起**；失败返回中文原因 |
| C3 | **ComfyUI 侧 `/comfyart/` 路由存在性** | 上游 `__init__.py`（已存在） | 若 ComfyUI 起着但没装 ComfyArt，`/comfyart/` 会 404 → ensureTool 必须区分「ComfyUI 没起」与「ComfyUI 起着但没装 ComfyArt」 |
| C4 | **iframe 内 `/api/*` / `/ws` / `/comfyart/*` 同源** | 上游同源天然成立 | `direct-iframe` 下 iframe origin = `http://127.0.0.1:8188`，`/api`、`/ws`、`/comfyart/*` 全部同源，**不需要任何 CORS 改动** |
| C5 | **网页端 `proxied-iframe` 的反代前缀透传** | Agnx daemon（已实现） | `host-guest-proxy.ts` 按 path 前缀透明反代，`/comfyart/*`、`/api/*`、`/ws` 都走同一前缀；上游**无需改** |
| C6 | **快捷键放行** | `.agnx/src/index.ts` 的 `iframeShortcutCapture: true` | 桌面 force-subframe 转发宿主快捷键 |
| C7 | **`manifest.platforms` 平台门控** | `.agnx/manifest.json` | 移动端 `unsupported`（理由见 §⑧） |

### 4.3 ensure 返回契约（严格对齐 `parseGuestEnsureToolResult`）

```
stdout 必须且只有一行 JSON：
  成功：{"ok":true,"port":8188,"origin":"http://127.0.0.1:8188","reused":true,"pid":null}
  失败：{"ok":false,"error":"中文可读原因"}
调用方式：spawn(process.execPath, [toolPath, ...args], {cwd: appDirPath})
env：AGNX_APP_ID、AGNX_APP_DATA_ROOT
args：--supervised、--force-restart（可能还有 --port）
超时：面板侧 180s（本工具自身应 <5s 返回，因为它只探活）
```

---

## ⑤ 最小落地切片

**切片定义：从零到「桌面端 Tab 里看到真实的 ComfyArt 画布」。**

| 步 | 产物 | 验收 |
|---|---|---|
| S1 | `EMBED.md`（本文） | 人审 |
| S2 | `.agnx/manifest.json`：`guest{kind:web, auth:none, preferStrategy:auto}`、`sidecar{supervised:true, ensureTool, stateFile, defaultPort:8188}`、`platforms{desktop:supported, web:supported, mobile:unsupported}`、`contributes{commands, panels}` | `npm run sub-apps:register` 不报错 |
| S3 | `.agnx/tools/ensure-comfyart.mjs` | 独立跑：ComfyUI 起着 → 一行 `{"ok":true,...}`；没起 → 一行 `{"ok":false,"error":"中文原因"}` |
| S4 | `.agnx/src/index.ts` + `.agnx/src/panel.tsx` | `host.guest.mount` 面板（根 `backgroundColor:"transparent"`）+ `registerCommand` + `openSubAppTab` |
| S5 | `.agnx/src/icon.tsx`（上游 favicon 图形移植为 React 组件） | 侧栏 / Tab 图标显示正常 |
| S6 | `npm run build` → `.agnx/dist/index.js` | `npm run sub-apps:assert-edge-to-edge` PASS |
| S7 | `register --launch-mode=debug` → 开 Tab → 截图 → `register --launch-mode=packaged --install-state=installed` → 再开 Tab → 截图 | 桌面端真开 PASS |
| S8 | `npm run runtime-devtools -- gate error` | 无红屏 |

**明确不做（第一期）**：自动安装 ComfyUI、拉起 ComfyUI 进程、模型下载引导（只给文案）、Agent provider 配置 UI、移动端适配。

**为什么不做“拉起 ComfyUI”**：ComfyUI 是用户的主力工作进程，Agnx 若代管它的生命周期，会出现「Agnx 退出 → 用户 ComfyUI 没了」「端口冲突」「显存被 Agnx 抢占」等连锁问题。正确的边界是：**ComfyUI 由用户自己起，Agnx 只探活 + 引导**。这与 `sidecar.supervised: true` 不冲突——`supervised` 描述的是「ensureTool 的输出被宿主监管」，不是「宿主安装软件」。

---

## ⑥ 风险

### 6.1 ComfyUI 未启动的引导态设计（**必须没有白屏**）

**问题链**：ComfyUI 没起 → `http://127.0.0.1:8188/comfyart/` 连不上 → 若直接 `guest.mount`，`onError(GUEST_ENSURE_FAILED)` → 面板必须渲染中文引导，**不能是白屏，也不能自动打开外部浏览器**。

**三段式状态机**（落在 `panel.tsx`）：

| 状态 | 触发 | UI |
|---|---|---|
| `booting` | `mount()` 已调用，`onPhase` 陆续上报 | 宿主 BrandLogo 遮罩（`bootOverlay: true`，由宿主负责）+ 面板透明底 |
| `error` | `onError({code, message})` | 面板内自绘引导卡片：标题「ComfyArt 需要在本机运行中的 ComfyUI」+ **分原因文案** + 可复制命令 + 「重试」按钮 |
| `ready` | `onReady({strategy, origin})` | 卸载遮罩，露出 iframe/webview，**面板本身不画任何东西**（edge-to-edge） |

**分原因文案**（`ensure-comfyart.mjs` 的 `error` 字段直接给中文，面板原样透出 + 补充操作）：

| ensureTool 判定 | 用户看到的中文 | 引导动作 |
|---|---|---|
| 8188 端口无监听 | 「没有检测到正在运行的 ComfyUI（127.0.0.1:8188 无响应）。请先启动 ComfyUI。」 | 给启动命令 `python main.py --port 8188` |
| 8188 有响应但 `/comfyart/` 404 | 「ComfyUI 已在运行，但没装 ComfyArt 扩展。请把 ComfyArt 放进 `ComfyUI/custom_nodes/` 后重启 ComfyUI。」 | 给 `custom_nodes` 路径 |
| 8188 有响应但 `/comfyart/` 503 | 「ComfyArt 已装上但前端未构建。请在 ComfyArt 目录执行 `npm install && npm run build`。」 | 给命令（上游 `__init__.py` 原话是 `ComfyArt is not built yet`） |
| 8188 是别的东西 | 「127.0.0.1:8188 上有服务在跑，但它不是 ComfyUI。」 | 提示改端口 |
| 探活超时 | 「检测 ComfyUI 超时（ComfyUI 可能正在加载模型）。请稍后重试。」 | 重试按钮 |

**额外硬要求**：
- **禁止**在主路径上用「状态页 + 打开外部应用」冒充完成（用户硬约束）。
- 面板根节点 `backgroundColor: "transparent"`，只用主题色，**不允许**任何硬编码背景色（`assert-edge-to-edge` 会查 guest 面板是否被 padding/fallback 包裹）。
- `onReady` 之前**不卸载** container，`onError` 之后**必须** `cleanup()`（`host.guest.mount` 返回的 disposer）。

### 6.2 tldraw 生产许可证水印（**处置 + 验证方法**）

**事实（读上游源码 + 读 tldraw 打包产物）**：

1. `licenses/tldraw-LICENSE.md` 明确：tldraw SDK **不是 MIT**，它有独立的许可证；`Production Environment` 下**必须**有 License Key；**禁止**「disable, change, or interfere with the Software's License Key enforcement」；**禁止**移除版权声明；只允许作为另一个应用的一部分分发（不能单独分发）。
2. 上游 README 原话：「从 `localhost` 或普通 `http` 访问时，它以开发模式运行，无需许可证密钥，右下角会显示一个小的 "Get a license for production" 标记。」
3. **反编译 `dist/assets/SettingsMenu-rhsMCNPi.js` 实测确认判定逻辑**：

```js
getIsDevelopment(){ const {protocol, hostname} = this.getOriginLocation();
  return hostname.endsWith('.localhost') ? false
       : (protocol === 'http:') || (protocol === 'https:' && this.isLoopbackHost(hostname)) }
isLoopbackHost(h){ h===h.toLowerCase().replace(/^\[|\]$/g,''); return h==='localhost'||h==='::1'||/^127(?:\.\d{1,3}){3}$/.test(h) }

L_(license, msg, isDevelopment):
  if (!license.isLicenseParseable) return isDevelopment ? 'unlicensed' : 'unlicensed-production';
  ...

watermark 渲染：['licensed-with-watermark','unlicensed'].includes(state)
  → 渲染 <div data-testid="tl-watermark-unlicensed">
      <button title="The tldraw SDK requires a license key to work in production...">
        "Get a license for production"
```

**关键推论（这是实测，不是猜测）**：

- 只有当 `state === 'unlicensed'`（**且** `isDevelopment === true`）时才会渲染水印按钮；
- `isDevelopment` 对 `http://127.0.0.1:8188` **恒为 true**（`protocol === 'http:'` 直接短路）；
- 所以 **Agnx 桌面端（webview 源 `http://127.0.0.1:8188`）与网页端（proxied-iframe 同样落到 loopback http）都会看到「Get a license for production」水印**；
- 更糟的是：如果未来走 **https 反代 / 非 loopback 域名**（例如远程访问经 relay 打开），`isDevelopment` 变 `false`，`state` 会变成 **`unlicensed-production`** → 水印**照常显示**，且 tldraw 的 pro 功能标志全部降级。也就是说：**水印无法通过「换个域名」消除，只能买 key 或接受开发模式。**

**处置方案（A–E 口径）**：

| 方案 | 做法 | 评价 |
|---|---|---|
| ❌ 移除/隐藏水印 | 改 DOM / CSS 隐藏 `[data-testid="tl-watermark-unlicensed"]` | **禁止**。违反 tldraw 许可证「不得禁用/干扰 License Key 校验」与「不得移除版权声明」，且属许可证风险，不能在交付里做 |
| ❌ 伪造 License Key | 逆向 `getLicenseFromKey` 造 key | **禁止**。同上，且属侵权 |
| ✅ **A（本期采纳，§9.4 已实测确认其必然性）**：接受开发模式水印 + 文档明示 | 不做任何处理；在 EMBED.md / 应用详情中写明「画布右下角 tldraw 开发模式标记属正常」 | 完全合规（内部/开发用途）；用户不会误报为 Bug。**实测命中 `data-testid="tl-watermark-unlicensed"` ×1，见 `shot-canvas2.png` 右下角，因此这不是可选而是必须提前告知** |
| ✅ **B（可选，用户自备）：`tldrawLicenseKey` 配置项** | tldraw 支持通过 `<Tldraw licenseKey>` 传入；上游 `src/` 未暴露该 prop，需要在上游一侧加一行 `licenseKey` 透传（或读 `window.ComfyArtLicenseKey`） | **属上游改造**，需要用户有 key 才能验证；本期不做，留 hook |
| ✅ **C（长期）：等 tldraw 100 天试用/商用授权** | tldraw 提供 100 天 free trial | 周期性，需用户决策 |

**验证方法（可复现，本期必跑）**：

1. 打开 ComfyUI 上的 `http://127.0.0.1:8188/comfyart/`，用 CDP 或 Bridge 执行：
   ```js
   document.querySelector('[data-testid="tl-watermark-unlicensed"]')?.innerText
   // 期望："Get a license for production"
   document.querySelector('[data-testid="tl-watermark-licensed"]')  // 期望：null
   ```
2. Agnx 桌面 Tab 打开 comfyart 后，在 Tab 内（webview）执行同样的判断（需 `webview.executeJavaScript` / devtools 进入 webview target）。
3. 记录截图：水印位置在画布右下角，字体小、可点击跳 `tldraw.dev/pricing`。
4. 若 `tl-watermark-unlicensed` 存在但**用户要求消除** → 只能走 B/C，**不得**改 DOM。

> **当前实测状态**：✅ **已实测**（§9.4）。判定为 `tl-watermark-unlicensed` 且文案为 `Get a license for production`，截图 `shot-canvas2.png` 右下角可见。iframe 内同样命中（§9.3/§9.4）。

### 6.3 `X-Frame-Options` / CSP `frame-ancestors` — **实测结论**

**源码层结论（读 ComfyUI `server.py`）**：

```python
# server.py:187-199
def create_block_external_middleware():
    @web.middleware
    async def block_external_middleware(request, handler):
        ...
        response.headers['Content-Security-Policy'] = "default-src 'self'; script-src 'self' 'unsafe-inline' 'unsafe-eval' blob:; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self'; connect-src 'self' data:; frame-src 'self'; object-src 'self';"
        return response
...
middlewares.append(create_block_external_middleware())  # 仅当 args.disable_api_nodes 为真
```

- `--disable-api-nodes` 是 `action="store_true"`，**默认 False** → 该中间件**默认不装** → **默认没有 CSP**。
- 全仓库 `server.py` 中 **没有任何 `X-Frame-Options`** 赋值（grep 无命中）。
- 因此**默认配置下 ComfyUI 发出的响应既无 `X-Frame-Options`，也无 CSP `frame-ancestors`** → **可以合法被 iframe 嵌入**。

**这解释了为什么 `direct-iframe` 是可行的**——不是「碰巧」，而是 ComfyUI 从未设置防嵌入头。

**但有两个必须实测确认的例外**：

1. 若用户启动时带了 `--disable-api-nodes`，则 CSP 生效。注意其 CSP **没有 `frame-ancestors`**，只有 `frame-src 'self'`（限制**它嵌别人**，不限制**别人嵌它**）。所以即便开了这个开关，**仍然可以被嵌入**，只是页面内的外链（`img-src 'self' data: blob:`、`connect-src 'self' data:`）会被收紧——这会影响 ComfyArt 加载外部资源，但**不影响嵌入本身**。
2. 若用户在前面挂了 nginx / Caddy / Cloudflare 反代，反代可能自己加 `X-Frame-Options: SAMEORIGIN` 或 `frame-ancestors`。此时**必须**由用户改反代，Agnx 侧无法绕过。

**实测命令（本轮必跑，见 §⑨）**：

```bash
# 1) 是否有 X-Frame-Options / CSP
curl -sSI http://127.0.0.1:8188/comfyart/ | grep -iE "x-frame-options|content-security-policy"
# 2) 无输出 = 无防嵌入头 = 可嵌

# 3) 对 ComfyUI 根路径同样确认
curl -sSI http://127.0.0.1:8188/ | grep -iE "x-frame-options|content-security-policy"
```

> **当前实测状态**：✅ **已实测**（§9.2）：`X-Frame-Options`、`Content-Security-Policy`、`frame-ancestors` **三者均不存在**；跨源 Referer 请求返回 200；但 `localhost` vs `127.0.0.1` 主机名不一致会被 `origin_only` 中间件 **403**。

### 6.4 其他风险

| 风险 | 等级 | 说明与缓解 |
|---|---|---|
| **权限** | 🟢 低 | 无鉴权、无 token、不写 Agnx 仓库；ComfyArt 写自己的 `user/comfyart/projects/` 与 `user/__comfyart/data.db` |
| **跨端** | 🟡 中 | 移动端本质不可用（见 §⑧），已标 `unsupported` |
| **性能** | 🟡 中 | tldraw 画布 1.07MB + SettingsMenu 1.75MB，首屏重；靠宿主 BrandLogo 遮罩 + `surfaceReadyTimeoutMs` 兜底；ComfyUI 若 `--highvram` 吃满显存会影响 Agnx 其他 Agent |
| **schema 兼容** | 🟢 低 | 不改 Agnx 任何 schema；manifest 全部走已有可选字段 |
| **上游漂移** | 🟡 中 | ComfyArt 是活跃项目，`/comfyart/*` 路由契约目前稳定（`__init__.py` 只注册 3 个路由 + 1 个静态目录）；若变更，只需改 ensureTool 的 404 判定 |
| **`--disable-api-nodes` 用户** | 🟡 中 | CSP 收紧可能让画布外链功能残废；文档提示 |
| **反代用户** | 🟡 中 | 自加 `X-Frame-Options` 会直接阻断；文档提示排查 |
| **ComfyUI 升级** | 🟢 低 | ComfyArt 依赖 `PromptServer.instance.routes`，是 ComfyUI 长期稳定 API |
| **队列抢占** | 🟢 低 | 共享 ComfyUI 队列，属既有事实 |

---

## ⑦ 嵌页宿主能力缺口

> 口径：A=宿主标准面（panel/activate/详情配置里的 `host.files.*`、`host.config`）；B=Guest→Host 标准桥（目标态，**尚未落地**）；C=外置协议适配器；D=降级/不接；E=暂缓+风险（标 🔴，禁止假 PASS）。

| 上游能力 | 信号位置 | 嵌后风险 | 处置 (A–E) | 是否主路径 | 备注 |
|---|---|---|---|---|---|
| **选目录 / 选文件夹** | `src/ui/*` 无 `showOpenDialog`/`directoryPicker`；ComfyArt **没有**「选项目目录」入口，项目固定落在 `user/comfyart/projects/` | 无 | **D 不接** | 否 | 上游根本不需要；这是相对 DSH/Boujoy 的**优势** |
| **选文件（PSD/图片/视频导入）** | `<input type="file">`、拖放 `src/psd.ts` / `src/assets.ts` | iframe/webview 内**可用**（浏览器原生 File 选择器）；拿到 `File` 无绝对路径 | **D 可用，不接桥** | 是（导入） | 上游只做**内容**处理（读字节 → 画布），不需要路径。实测待补 |
| **上传 PDF** | `src/pdf.ts` → `POST /comfyart/pdf`（multipart） | 同源，可用 | **D 可用，不接桥** | 否 | 依赖 `pypdfium2`，缺则报错由上游 UI 提示 |
| **拖拽本地文件到画布** | `src/assets.ts`、`ui/` 拖放区 | webview/iframe 内 `DataTransfer.files` **可用**；**拖入绝对路径** 不可用 | **D 降级**（禁止用 `window.prompt` 要路径） | 否 | 用户可见文案：拖文件本身即可 |
| **Reveal in Finder / 打开导出目录** | `src/pptx.ts`、`src/videoEdit.ts`（导出后下载 / 也可能提示保存位置） | 上游**无** `shell.openPath`/`revealInFinder` | **D 不接** | 否 | 导出走浏览器下载（webview 内 JSON 下载可用，Electron 需 `will-download` 兜底——待实测） |
| **保存文件到指定路径** | 上游用 Blob + `<a download>` | webview 内会触发 Electron 默认下载或静默失败 | **E 暂缓 + 风险** 🔴 | 否 | 若下载失联，唯一按钮不可用；实测确认后决定是否需 Agnx 侧补 `will-download`（**不得改 Agnx core**，只能报风险） |
| **`window.confirm` / `prompt` / `alert`** | `src/ui/` 多处删除确认；`src/bot*.ts` | Electron webview 内弹原生 dialog；**桌面端可接受**；web iframe 内弹浏览器原生框 | **D 接受原生** | 是 | 禁止改成 Agnx 自绘（会打断上游流程）；若后续发现静默 null，再走 C 外置 shim |
| **系统通知 / Dock badge** | 上游无 | 无 | **D 不接** | 否 | Agent 完成后用页内提示 |
| **全局快捷键（画布内）** | `Cmd+Z`/`Cmd+S`/`空格`/`Delete`… | iframe 吞键 → 宿主 `Cmd+W` 等失效 | **A（`iframeShortcutCapture: true`）** | 是 | 已有标准面 |
| **legacy RPC / 旧 UI 协议** | 上游 `src/ws.ts` 连 ComfyUI `/ws`；`src/comfy.ts` 走 `/api` | 同源，天然通（实测无绝对 URL，§9.5） | **D 不接** | 是 | `proxied-iframe` 下由 Agnx 反代统一前缀透传。⚠️ 但 ComfyUI `origin_only` 中间件要求 **Host 与 Origin 主机名一致**，否则 403（§9.2 实测） |
| **项目数据目录 Reveal** | 项目落在 `ComfyUI/user/default/comfyart/projects/*.json`（§9.6 实测） | 路径属 ComfyUI，不属 Agnx | **D 不接** | 否 | 宿主 `files.revealPath` 无从介入；**用户清理必须去 ComfyUI 目录**，Agnx「清除应用数据」清不掉——**必须文档明示** |
| **剪贴板图片粘贴** | `src/clipboard.ts` | iframe 内 `navigator.clipboard.read()` 需**权限**；webview 内需 `clipboard-read` | **E 暂缓 + 风险** 🟡 | 否 | 宿主 iframe 已带 `allow="clipboard-read; clipboard-write"`；webview 需实测 |
| **全屏 / pointer lock** | tldraw 全屏、`src/videoEdit.ts` | 宿主 iframe `allow="fullscreen; pointer-lock"` 已给 | **D 可用** | 否 | webview 天然支持 |
| **Agent provider 需要 `claude`/`codex`/`dsh` 在 PATH** | `bot/providers.py` 探测 PATH | ComfyUI 进程的 PATH 不含 Agnx 的 CLI | **E 暂缓 + 风险** 🟡 | 否 | 默认关闭；开了也不影响画布出图。用户可见：Agent 设置里显示「未找到」 |

**🔴 必须写进交付说明的三条**：

1. **导出下载**（`E`）：若 Electron webview 内 `<a download>` 静默失败，用户会看到「点了导出没反应」。本期以实测为准；若复现，只能报风险（不改 Agnx core）。
2. ~~**`legacy RPC` 绝对 URL**~~ → ✅ **已由实测排除**（§9.5）：上游全部使用 `/api`、`/ws`、`/comfyart/*` 相对路径，`grep "127.0.0.1\|localhost" src/` **零命中**，无硬编码绝对地址。**`proxied-iframe` 下路径前缀透传是安全的。** 但另有 **`origin_only` 中间件的 Host/Origin 主机名必须一致** 的硬约束（§9.2），这才是网页端真正的风险点。
3. **剪贴板**（`E`）：webview 内 `navigator.clipboard.read()` 可能不弹权限框直接 reject。

---

## ⑧ 平台矩阵

| 平台 | 判定 | 理由 |
|---|---|---|
| **desktop**（Electron） | ✅ `supported`（**已实测通过**） | 主场景。`direct-iframe`，同源 API/WS，`X-Frame-Options` 无关，`iframeShortcutCapture` 让宿主快捷键可用。ComfyUI 天生是桌面软件。**实测**：Tab 内完整渲染 ComfyArt 真实界面（`1008×702`，§9.6.1），`launchMode=packaged` 下复测同样正常。**前提**：ensure 输出的 `origin` 必须用 `localhost` 与宿主页 hostname 对齐，否则 ComfyUI `origin_only` 中间件返回 403 → 白屏（§9.6.1 已修复并回归） |
| **web**（浏览器） | ⚠️ `supported`（**带强保留**，需真机验证） | `direct-iframe` 会被升格为 **`proxied-iframe`**（loopback 快捷键 relay），经 Agnx daemon 反代到 8188。要求：① Agnx daemon 与 ComfyUI 在同一台机器；② **反代必须让 `Host` 与 `Origin` 主机名一致**——ComfyUI `origin_only` 中间件实测会对 `Host:127.0.0.1:8188` + `Origin:http://localhost:8083` 返回 **403**（§9.2、§9.6.1），这是网页端能否可用的**第一决定因素**；③ iframe 依赖 ComfyUI 无防嵌入头（✅ 已实测通过）。**其中 ② 尚未在真机网页端验证**，若失败需降级为 `partial` 并在 UI 说明「请用桌面端」 |
| **mobile**（RN 原生 / Electron 窄屏紧凑断点） | ⛔ `unsupported` | ① tldraw 画布是**鼠标优先**的无限画布（右键菜单、悬停、多选框、`Cmd` 组合键），触控体验残缺（tldraw 自身把 <700px 视口标记为 `is mobile` 并降级水印样式，但画布交互未做移动化）；② ComfyArt 的 generate 依赖 **ComfyUI 在 loopback**，手机端通常连不到本机 8188（除同机移动模拟）；③ 宿主把 **Electron 紧凑断点也判为 mobile**，若不显式标 `unsupported`，窄窗口打开会得到一个破版画布；④ 上游 `src/` 无任何 RN/移动分支。**结论：显式声明 `unsupported`，理由写进 manifest 注释与本文档。** |

> 注意：`manifest.platforms` 的**推导默认值**是——`guest.kind === "web"` 时三端全 `supported`。**所以必须显式写 `mobile: "unsupported"`**，否则会被推导成 supported 并导致「声称支持但实际破版」。

---

## ⑨ 实测记录

> 本机现状（截至撰写）：`lsof -i:8188` **无监听**；`~/Downloads/ComfyUI-master`（ComfyUI **0.18.1**）存在但**从未安装 Python 依赖**（无 venv、`aiohttp` 未装）。
> 实测手段：在 `/tmp/comfy-probe/.venv`（Python 3.12）里 `uv pip install -r requirements.txt` **试装 ComfyUI 依赖**，把 `ComfyArt-main` **软链**到 `custom_nodes/ComfyArt`，再以 `--cpu --port 8188` 启动，仅用于**测量响应头与水印**。
> **重要边界**：这次试装**仅在 /tmp 下的探针环境里做**，**不写 Agnx 仓库、不装进 `$AGNX_HOME`、不作为子应用的自动安装能力**。子应用的 `ensure-comfyart.mjs` **只探活、不安装**。

### 9.1 实测环境

| 项 | 值 |
|---|---|
| 日期 | 2026-10-19 |
| ComfyUI | `~/Downloads/ComfyUI-master`（`comfyui_version` 0.18.1） |
| ComfyArt | `~/Downloads/ComfyArt-main`，软链到 `custom_nodes/ComfyArt` |
| 运行时 | `/tmp/comfy-probe/.venv`（Python 3.12.12）+ `aiohttp 3.14.5`、`pyyaml`、`Pillow`、`numpy` |
| 探针脚本 | `/tmp/comfy-probe/mini_comfy_server.py`（逐字复刻 ComfyUI `server.py` 的 `cache_control` + `create_origin_only_middleware` 中间件栈、路由注册方式与 `/userdata` 接口） |
| 浏览器 | Playwright 1.58.2 `chromium_headless_shell-1228` |
| 宿主页 | `python3 -m http.server 6555` 托管 `http://127.0.0.1:6555/iframetest.html`（内含 `<iframe src="http://127.0.0.1:8188/comfyart/">`） |

> ⚠️ **诚实声明**：因 `torch` / 数 GB 权重无法在验收时间窗内装起，本轮**没有跑起完整 ComfyUI 内核**（`nodes.py`→torch→模型加载）。实测的是 **ComfyUI 的 HTTP 层 + ComfyArt 的完整前端 `dist/`**。凡是依赖 HTTP 头、iframe 嵌入、前端渲染、tldraw 水印的结论**全部真实测得**；凡是依赖推理（`/prompt`、`/view`、模型加载）的结论**未实测**，已在下文逐条标注。

### 9.2 实测一：`X-Frame-Options` / CSP（✅ 已实测）

```
$ curl -sSI http://127.0.0.1:8188/comfyart/
HTTP/1.1 200 OK
Cache-Control: no-cache
Content-Type: text/html
Etag: "18df58d3014e5000-259"
Last-Modified: Sat, 17 Oct 2026 14:54:00 GMT
Content-Length: 601
Accept-Ranges: bytes
Date: Sun, 18 Oct 2026 18:00:48 GMT
Server: Python/3.12 aiohttp/3.14.5

$ curl -sSI http://127.0.0.1:8188/comfyart/ | grep -iE "x-frame-options|content-security-policy|frame-ancestors"
$ echo $?
1
```

| 检查项 | 结果 | 判定 |
|---|---|---|
| `X-Frame-Options` | **不存在** | ✅ 可嵌 |
| `Content-Security-Policy` | **不存在** | ✅ 可嵌 |
| `frame-ancestors` | **不存在** | ✅ 可嵌 |
| 根路径 `GET /` 同样检索 | **均不存在** | ✅ 可嵌 |
| 带跨源 `Referer: http://127.0.0.1:3054/` 请求 | **200** | ✅ 不拦 |
| 全仓 `grep -rn "X-Frame-Options" --include="*.py"` | **0 命中** | — |
| 全仓 `grep -rn "frame-ancestors" --include="*.py"` | **0 命中** | — |
| `grep -rn "Content-Security-Policy" --include="*.py"` | 仅 `server.py:196` 一处（`--disable-api-nodes` 分支） | — |

**结论（实测）**：ComfyUI **默认不发任何防嵌入头**，`direct-iframe` / `proxied-iframe` 策略**在浏览器层面成立**。

**额外实测发现（重要，前面推理没料到）**：

`http://localhost:8188/comfyart/` 被 iframe 引入时 → **403**。原因不是防嵌入头，而是 ComfyUI 的 `create_origin_only_middleware()`：

```python
if 'Host' in request.headers and 'Origin' in request.headers:
    loopback = is_loopback(hostname_of_host)
    if loopback and host_domain != origin_domain:   # Host=localhost:8188, Origin=127.0.0.1:6555
        logging.warning("WARNING: request with non matching host and origin ... returning 403")
        return web.Response(status=403)
```

**这条对 Agnx 是硬约束**：
- 宿主页 origin 与 `Host` 必须**主机名完全一致**（`127.0.0.1` vs `localhost` 被视作不同）；
- 网页端走 `proxied-iframe` 时，Agnx daemon 反代会改写 `Host`，需保证**反代出去的 `Host` 与 `Origin` 主机名一致**（或干脆不带 `Origin`），否则全部 403。**这是网页端能否可用的第一决定因素，必须在真机网页端验证。**

### 9.3 实测二：iframe 内完整渲染 ComfyArt（✅ 已实测）

```
宿主页 http://127.0.0.1:6555/iframetest.html
 └─ <iframe src="http://127.0.0.1:8188/comfyart/">
```

| 检查项 | 结果 |
|---|---|
| iframe 是否加载成功 | ✅ `frames = ["http://127.0.0.1:6555/iframetest.html", "http://127.0.0.1:8188/comfyart/"]` |
| 首页文案渲染 | ✅ `"What do you want to design?"` 命中 |
| 点击 `Poster Design` 进入画布 | ✅ URL 变成 `/?project=<id>` |
| tldraw 画布节点 | ✅ 命中 `.tl-canvas / .tl-container` |
| 工具条（Select/Comment/Draw/Insert/Image Generation） | ✅ 渲染（见截图） |
| 截图 | `/tmp/comfy-probe/shot-embed-canvas.png` |

**结论（实测）**：ComfyArt **能完整嵌入 iframe**，首页 + 画布都正常渲染，**不是白屏**。

### 9.4 实测三：tldraw 许可证水印（✅ 已实测，🔴 确认存在）

直接打开 `http://127.0.0.1:8188/comfyart/` 并进入画布后执行：

```js
document.querySelectorAll('[data-testid="tl-watermark-unlicensed"]').length   // → 1
document.querySelectorAll('[data-testid="tl-watermark-licensed"]').length     // → 0
document.querySelector('[data-testid="tl-watermark-unlicensed"]').outerHTML
```

实测 DOM（原样）：

```html
<div class="tl-watermark_SEE-LICENSE"
     data-debug="false" data-mobile="false" data-unlicensed="true"
     data-testid="tl-watermark-unlicensed" draggable="false">
  <button draggable="false" role="button"
    title="The tldraw SDK requires a license key to work in production.
           You can get a free 100-day trial license at tldraw.dev/pricing.">
    Get a license for production
  </button>
</div>
```

| 检查项 | 直接打开 | iframe 嵌入 |
|---|---|---|
| `tl-watermark-unlicensed` 数量 | **1** | **1** |
| `tl-watermark-licensed` 数量 | **0** | **0** |
| 水印文案 | `Get a license for production` | 同 |
| 视觉位置 | 画布**右下角**（见 `shot-canvas2.png` / `shot-embed-canvas.png`） | 同 |
| `data-mobile` | `false` | `false` |

**结论（实测）**：水印**确实存在**，且**在 iframe 内同样存在**。`data-unlicensed="true"` 证明 tldraw 判定为「无许可证的开发模式」。

**对 Agnx 的含义**：ComfyArt 在 Agnx Tab 里跑起来后，**右下角必然有这个标记**。这**不是 Bug**，是 tldraw 许可证的设计。处置见 §6.2 —— **A 方案（接受 + 文档明示）**，**禁止**改 DOM 隐藏。

### 9.5 实测四：ComfyUI 的 `origin_only` 中间件对绝对 URL 的影响（✅ 已实测）

上游源码实测确认**全部使用相对路径**，无硬编码 `127.0.0.1:8188`：

```
$ grep -rn "127.0.0.1\|localhost" ~/Downloads/ComfyArt-main/src/*.ts ~/Downloads/ComfyArt-main/src/*.tsx
（无输出）
$ grep -rn "new URL(" ~/Downloads/ComfyArt-main/src/*.ts
src/comfy.ts:60   const q = new URL(src, location.origin).searchParams
src/notices.ts:17 return new URL(location.href).searchParams.get('project') ?? ''
src/projects.ts:78/89  new URL(location.pathname, location.origin)
src/workflows.ts:8    new URL(src, location.origin).searchParams
src/ws.ts:12          new URL('/ws', location.href)
```

**结论（实测）**：上游**没有绝对 URL 依赖**，全部 `location.origin` / `location.href` 派生 → **`proxied-iframe` 下的路径前缀透传是安全的**（§⑦ 风险 2 降级为 🟢 已排除）。

但注意 §9.2 的 `origin_only` 403 问题仍然存在——那是**中间件的 Host/Origin 主机名比对**，与路径无关。

### 9.6 实测五：项目保存链路的真实依赖（✅ 已实测，发现一处**非 HTTP 层**依赖）

实测发现：进入画布后 UI 立刻报红条

```
Error: save comfyart/projects/<id>.json failed: 404
```

追源码（`src/comfy.ts:12-15`, `src/projects.ts:13`）：

```ts
export function api(path, init) {
  const user = comfyUser()                       // localStorage['Comfy.userId']
  return fetch(`/api${path}`, user ? {...init, headers: {...,'Comfy-User': user}} : init)
}
const userFile = (path) => `/userdata/${encodeURIComponent(path)}`
export const saveProject = (id, snapshot) => writeUserJson(filePath(id), snapshot)  // comfyart/projects/<id>.json
```

- 404 是因为**我的探针没有实现 `/api/userdata/*`**（ComfyUI 的 `/userdata` 路由由 `app/user_manager.py` 注册，需要在仓库根 `user/default/` 下读写），**不是 ComfyArt 的缺陷**。
- 但它揭示了一条**必须写进 EMBED 的真实依赖链**：

```
ComfyArt 保存项目 → POST /api/userdata/comfyart%2Fprojects%2F<id>.json
                  → ComfyUI UserManager → 磁盘 <ComfyUI>/user/default/comfyart/projects/<id>.json
```

**对 Agnx 的含义**：
1. 项目数据**落在 ComfyUI 目录下**，不在 Agnx 的 `$AGNX_HOME/apps/data/comfyart/`。**Agnx 不该接管**（接管会造成两套真相）。
2. 因此「Reveal in Finder / 打开项目目录」这一行的处置是 **D（不接）**：上游没有这个入口，且路径属于 ComfyUI 而非 Agnx，宿主 `host.files.revealPath` 也无从介入。
3. 用户清理数据必须去 ComfyUI 目录删 `user/default/comfyart/` + `user/__comfyart/data.db`。**Agnx 的「清除应用数据」按钮清不掉它们**——这条必须写进文档，否则用户会以为清了。

### 9.6.1 实测六：桌面端白屏的根因（✅ 已定位并修复，原 🔴 已解除）

这一节记录一次**必须写进文档的踩坑**：同样的页面「直接打开正常、iframe 正常、Electron 里却整片白」。

**现象**：ComfyArt Tab 能正常创建、激活，面板尺寸 `1008×702`，`data-agnx-guest-surface-host` 结构正确，
`host.guest.mount` 走到 `mount.surface-ready`（不是引导态、不是报错态），但 iframe 内容整片纯白。

**排除过程（关键几条实测）**：

| 假设 | 实测手段 | 结论 |
|---|---|---|
| guest iframe 链路不通 | 把 iframe 指向一个自造的 `type="module"` 测试页（8333） | ❌ 排除：模块脚本执行、页面正常渲染 |
| 截图工具没合成跨域 iframe 像素 | 同一套 clip 几何分别截 8333 与 8188 | ❌ 排除：8333 能截到真实像素 |
| 8188 页面本身坏了 | 独立 Chromium 里直接 cross-origin iframe 挂载 | ❌ 排除：`textLen:434`，渲染完整 |
| aiohttp / 端口 / HTTP 版本 | 用镜像反代把 8188 全站搬到 8334 再挂 | **✅ 8334 渲染正常，8188 白屏** |

**A/B 定位（同一宿主页面、同一时刻、同宽 480px 并排挂两个 iframe）**：

```
["8188/comfyart/", 403, "Python/3.12 aiohttp/3.14.5"]   ← 白屏
["8334/comfyart/", 200, "BaseHTTP/0.6 Python/3.14.8"]    ← 正常渲染
```

**根因**：ComfyUI 自带的 `create_origin_only_middleware`（`server.py:146-184`）在请求**同时带 `Host` 与 `Origin`
且二者 hostname 不一致时返回 403**。Electron 宿主页在 `http://localhost:8083`，iframe 子资源请求会带
`Origin: http://localhost:8083`；而 ensure 探针当时把 origin 写成 `http://127.0.0.1:8188/comfyart/`
（hostname = `127.0.0.1`）→ **hostname 不一致 → 403 → 白屏**。

`curl` 复现（`/tmp/comfy-probe`）：

```
Host=127.0.0.1:8188  Origin=http://localhost:8083  → 403
Host=127.0.0.1:8188  无 Origin                      → 200
Host=127.0.0.1:8188  Origin=http://127.0.0.1:8083  → 403
Host=localhost:8188  Origin=http://localhost:8188   → 200   ← 同名才放行
Host=127.0.0.1:8188  Origin=http://127.0.0.1:8188   → 200
```

**修复**：`ensure-comfyart.mjs` 按「与宿主同源优先」选择 origin 主机名 ——
`HOST_CANDIDATES = ["localhost", "127.0.0.1"]`，逐个探测 `/` 与 `/comfyart/`，
**第一个能对 `/comfyart/` 返回 200 的主机名胜出**并作为 `origin` 输出；
`localhost` 优先（Electron 宿主页是 `localhost`），`127.0.0.1` 兜底（`localhost` 解析异常时）。

修复后实测：

```
$ node .agnx/tools/ensure-comfyart.mjs --port 8188
{"ok":true,"port":8188,"origin":"http://localhost:8188/comfyart/","reused":true,"pid":0,"warnings":[]}

$ # stderr
[ensure-comfyart] [localhost] 根路径 http://localhost:8188/ → 200
[ensure-comfyart] [localhost] /comfyart/ → 200
[ensure-comfyart] 选中主机名 localhost → origin http://localhost:8188/comfyart/
```

宿主内实测：`iframe.src = "http://localhost:8188/comfyart/"`，面板 `1008×702`，`aria-selected="true"`，
`guide=false`，截图显示 ComfyArt **完整真实界面**（"你想设计什么？"输入框、"帮你做"分类标签、
"最近项目 / 还没有项目"、"从 Skill 开始 / 海报设计 / 社交媒体套图 / 品牌识别"、底部四键导航栏）。
`launchMode=packaged` 下复测同样正常。

**对所有 Web 类子应用的普适结论（务必遵守）**：

1. **ensure 探针输出的 `origin` hostname 必须与宿主页面 hostname 一致**（同为 `localhost` 或同为 `127.0.0.1`）。
   ComfyUI 这类带 origin 校验的上游，主机名不一致就是整页 403，而且**表现是「白屏」而不是「报错」**——
   因为 403 的是 iframe 里的文档，宿主只看到 load 事件，`mount.surface-ready` 照样触发。
2. **网页端 `proxied-iframe` 更危险**：反向代理如果改写 Host 但透传浏览器原始 Origin，同样会 403。
   反代必须保证 `Host` 与 `Origin` 的 hostname 一致，或在必要时对 `Host` 做同名回写。
3. **白屏排查顺序**建议固定为：`Network` 看 iframe 文档状态码 → 换一个能渲染的对照页排除管道问题 →
   核对 `Host`/`Origin` → 再看页面自身 JS。

**顺带验证了引导态与重试链路（意外的正向收获）**：移除 `custom_nodes/ComfyArt` 软链（模拟「ComfyUI 在跑但没装扩展」）后，
再打开 Tab **不白屏**，而是正确显示引导卡：

```
ComfyUI 已在运行，但没装 ComfyArt 扩展（/comfyart/ 返回 404）。
把 ComfyArt-main 整个目录放进 ComfyUI 的 custom_nodes/ 下，然后
pip install -r ComfyArt-main/requirements.txt（只需要 pypdfium2），重启 ComfyUI。
[复制启动命令] [重试]
```

恢复软链后点「重试」→ `iframe.src` 重新指向 `http://localhost:8188/comfyart/`、`guide=false`、
界面完整渲染（按钮实测可用，无需重启 Agnx）。

### 9.7 未实测项（🔴 明确标注，禁止当成已验收）
| 项 | 为什么没测 | 风险 |
|---|---|---|
| `/prompt` 提交 + 出图 | 需要 torch + 模型权重（数 GB），验收窗内不可得 | 🔴 出图主路径**未端到端验证**。若 ComfyUI 正常，上游自身就工作（它是官方 custom_node），Agnx 不介入；但「Agnx 里出图」这条链路**尚缺实证** |
| `/ws` 实时进度 | 同上（探针只发了一条 status 帧） | 🟡 上游用相对 `/ws`，同源成立；风险低但未实测 |
| 网页端 `proxied-iframe` 反代 | 需要 Agnx daemon + 真机浏览器 | **`origin_only` 403 是最大不确定项**（§9.2、§9.6.1）；反代须保证 Host/Origin hostname 一致 |
| 移动端 | 上游是鼠标优先的 tldraw 画布，ComfyUI 仅 loopback | 已显式声明 `mobile: unsupported`，不进入验收范围 |
| 模型未装的报错文案 | 同上 | 上游会显示「模型缺失」，Agnx 不介入 |

> 注：**Electron 桌面端已实测通过**（见 §9.6.1），不再是未实测项。

### 9.8 截图清单

| 文件 | 内容 |
|---|---|
| `/tmp/comfy-probe/FINAL-desktop-region.png` | **桌面端 Tab 内 ComfyArt 完整真实界面**（修复后最终验收，1008×702） |
| `/tmp/comfy-probe/FINAL-desktop.png` | 同上，整窗（含 Agnx 侧栏 + Tab 栏） |
| `/tmp/comfy-probe/packaged.png` | `launchMode=packaged` 下复测，界面完整 |
| `/tmp/comfy-probe/ab.png` | A/B 对比：左 8188 白屏 / 右 8334 正常（白屏根因取证） |
| `/tmp/comfy-probe/localhost-ab.png` | A/B 对比：左 `127.0.0.1:8188` 403 / 右 `localhost:8188` 200 |
| `/tmp/comfy-probe/retry-recovered.png` | 引导态 → 点「重试」→ 恢复完整渲染（实测取证） |
| `/tmp/comfy-probe/shot-canvas2.png` | 直接打开，画布 + 右下角 tldraw 水印 |
| `/tmp/comfy-probe/shot-embed-canvas.png` | iframe 嵌入，画布 + 水印 |
| `/tmp/comfy-probe/shot-direct.png` | 首页（skills 列表） |

> 截图在 `/tmp`，属一次性验证产物；如需长期留存应由交付方另行归档。

---

## 上游嵌入

- 工作方式：**整站嵌入（Wrap）**——上游 ComfyArt 完整留在 `ComfyUI/custom_nodes/ComfyArt`，Agnx 只在 Tab 里挂载 `/comfyart/`
- 推荐模式：**Wrap + Sidecar（探活型）**。sidecar 不代管 ComfyUI 生命周期，只回答「8188 上有没有能用的 ComfyArt」
- 挂载：`guest.kind=web` / `guest.auth=none` / `preferStrategy=auto` → 桌面解析为 **`direct-iframe`**（实测为**跨域 OOPIF `<iframe>`**，非 `<webview>`）；网页端因 loopback 快捷键 relay 升格为 **`proxied-iframe`**
- **实测关键**：`origin` 的主机名必须与宿主页 hostname 一致（都 `localhost` 或都 `127.0.0.1`），否则被 ComfyUI `origin_only` 中间件 403 → 白屏（§9.6.1）
- 上游：`ComfyUI/custom_nodes/ComfyArt`（本机 `~/Downloads/ComfyArt-main`），ComfyUI `0.18.1`（`~/Downloads/ComfyUI-master`）
- Port 切片：**（无）**。本期不迁任何 Python 代码，只迁路由契约（`/comfyart/`、`/comfyart/assets/*`、`/comfyart/workflows/{name}`、`/comfyart/bot/*`、`/comfyart/settings`、`/comfyart/mcp`、`/comfyart/pdf`）
- 默认值：`sidecar.lifecycle=lazy`、`sidecar.supervised=true`、`sidecar.defaultPort=8188`、`sidecar.stateFile=comfyart.json`、`platforms.mobile=unsupported`、`iframeShortcutCapture=true`

## 嵌页宿主能力缺口

| 上游能力 | 信号位置 | 嵌后风险 | 处置 (A–E) | 主路径 | 备注 |
|---|---|---|---|---|---|
| 选目录 | 上游无此入口 | 无 | D 不接 | 否 | 项目路径固定 `user/comfyart/projects/` |
| 选文件/导入 | `<input type=file>`、拖放 | webview/iframe 内可用（无绝对路径） | D 可用 | 是 | 上游只读字节 |
| 上传 PDF | `POST /comfyart/pdf` | 同源可用 | D 可用 | 否 | 需 `pypdfium2` |
| 保存/导出 | Blob + `<a download>` | Electron webview 下载可能静默失败 | E 🔴 | 否 | 实测确认后再定 |
| confirm/prompt/alert | `ui/` 多处 | Electron 弹原生框；web 弹浏览器框 | D 接受原生 | 是 | 不得自绘替代 |
| 全局快捷键 | tldraw 大量 `Cmd+*` | 宿主快捷键被吞 | A `iframeShortcutCapture:true` | 是 | 标准面 |
| legacy RPC（`/ws`、`/api`） | `src/ws.ts`、`src/comfy.ts` | web 端 `proxied-iframe` 下绝对 URL 跨源 | D（需确认相对路径） | 是 | 不进 core |
| 剪贴板图片 | `src/clipboard.ts` | webview 内可能 reject | E 🟡 | 否 | iframe `allow` 已给 clipboard |
| Agent provider PATH | `bot/providers.py` | 找不到 CLI | E 🟡 | 否 | 默认关闭 |
| **Origin 主机名一致性** | `ensure` 输出的 `origin`；ComfyUI `server.py:146-184` | **Host 与 Origin hostname 不一致 → 整页 403 → 白屏（实测踩中）** | **B 标准桥（`sidecar.ensureTool` 输出同名 origin）** | 是 | 已修复：`localhost` 优先、`127.0.0.1` 兜底（§9.6.1）。**所有 Web 类子应用通用** |
