#!/usr/bin/env node
/**
 * 场景：ComfyArt 子应用 ensure 探针 — 只「探」不「起」。
 *
 * 上游 ComfyArt 是 ComfyUI 的 custom_node，不是一个能独立 spawn 的 Web 服务：
 *   它的页面由 ComfyUI（127.0.0.1:8188）托管在 /comfyart/，
 *   启动 ComfyUI 需要 torch + 数 GB 权重。
 * 因此本脚本【不】安装 ComfyUI、【不】拉起 ComfyUI 进程，
 * 只探测「ComfyUI 是否已在跑、ComfyArt 是否已装好」，
 * 并把差异翻译成用户能读懂的中文原因，交给宿主渲染引导态。
 *
 * 契约：stdout 只输出「一行」JSON。
 *   成功 → {"ok":true,"port":8188,"origin":"http://localhost:8188/comfyart/","reused":true,"pid":0}
 *   失败 → {"ok":false,"error":"<中文原因>"}
 *
 * 为什么 origin 用 localhost 而不是 127.0.0.1：
 *   ComfyUI 的 create_origin_only_middleware 在 Host 与 Origin 的 hostname
 *   不一致时直接 403。宿主页在 http://localhost:8083，若 iframe 指向
 *   127.0.0.1:8188 就会整页 403（实测白屏）。因此优先用 localhost，
 *   仅当 localhost 不通时才回退 127.0.0.1。
 *
 * 用法：
 *   node ensure-comfyart.mjs [--port 8188] [--supervised] [--force-restart] [--work-dir <dir>]
 */
import http from "node:http";
import { parseArgs } from "node:util";

const APP_ID = "comfyart";
const ENSURE_ID = "ensure-comfyart";
const DEFAULT_PORT = 8188;
/** 单次 HTTP 探测超时（毫秒）。ComfyUI 冷启动可能较慢，但这里是「已在运行」的探测，不需要等太久。 */
const PROBE_TIMEOUT_MS = 4000;
/** 整体自带超时兜底，确保一定有一行 JSON 输出，不会挂死宿主的 300s 超时。 */
const HARD_TIMEOUT_MS = 20_000;

const { values } = parseArgs({
  options: {
    supervised: { type: "boolean", default: false },
    port: { type: "string", default: String(DEFAULT_PORT) },
    "force-restart": { type: "boolean", default: false },
    "forceRestart": { type: "boolean", default: false },
    "work-dir": { type: "string" },
    "workDir": { type: "string" },
  },
  allowUnknown: true,
  allowPositionals: true,
});

const PORT = Number(values.port) || DEFAULT_PORT;
/**
 * ComfyUI 自带 `create_origin_only_middleware`（server.py:146-184）：
 * 当请求同时带 `Host` 与 `Origin` 且两者 hostname 不一致时 → 403。
 * Electron 宿主页在 `http://localhost:8083`，内嵌 iframe 发出的子资源请求会带
 * `Origin: http://localhost:8083`，若我们把 origin 写成 `http://127.0.0.1:8188/`，
 * hostname 一个是 localhost、一个是 127.0.0.1 → 整页 403（实测白屏根因）。
 * 因此候选主机名按「与宿主同源优先」排序：localhost 在前，127.0.0.1 兜底。
 */
const HOST_CANDIDATES = ["localhost", "127.0.0.1"];
const BASE = `http://${HOST_CANDIDATES[0]}:${PORT}`;
const TARGET = `${BASE}/comfyart/`;

/** 诊断信息走 stderr，绝不污染 stdout 的 JSON 契约。 */
function trace(msg) {
  process.stderr.write(`[${ENSURE_ID}] ${msg}\n`);
}

function emit(payload) {
  process.stdout.write(`${JSON.stringify(payload)}\n`);
}

/**
 * 发一个 GET，返回 { status, headers, body(截断) } 或抛错。
 * 不跟随重定向 —— 我们要区分「404 未装」和「302 到 /comfyart/」。
 */
function probe(url) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      url,
      {
        method: "GET",
        timeout: PROBE_TIMEOUT_MS,
        headers: { Accept: "text/html,application/json;q=0.9,*/*;q=0.8" },
      },
      (res) => {
        let body = "";
        res.setEncoding("utf8");
        res.on("data", (chunk) => {
          if (body.length < 4096) body += chunk;
        });
        res.on("end", () => {
          resolve({ status: res.statusCode ?? 0, headers: res.headers, body });
        });
        res.on("error", reject);
      },
    );
    req.on("timeout", () => {
      req.destroy(new Error("PROBE_TIMEOUT"));
    });
    req.on("error", reject);
    req.end();
  });
}

/** 把网络层错误翻译成中文用户原因。 */
function describeNetworkError(err) {
  const code = err?.code ?? "";
  if (code === "ECONNREFUSED") {
    return "ECONNREFUSED";
  }
  if (code === "ECONNRESET") {
    return "ECONNRESET";
  }
  if (err?.message === "PROBE_TIMEOUT") {
    return "PROBE_TIMEOUT";
  }
  return code || err?.message || "UNKNOWN";
}

const GUIDE = {
  /** ComfyUI 根本没在跑 —— 最常见的情况。 */
  comfyui_down: [
    `没有检测到正在运行的 ComfyUI（127.0.0.1:${PORT} 无响应）。`,
    "ComfyArt 是 ComfyUI 的插件，需要先启动 ComfyUI 才能打开。",
    "请在你的 ComfyUI 安装目录执行：python main.py --listen 127.0.0.1 --port 8188",
    "（或用你平时习惯的方式启动 ComfyUI）",
    "启动后再回到这里点重试即可，无需重启 Agnx。",
  ].join(""),
  /** 8188 上跑着别的东西。 */
  wrong_service: [
    `127.0.0.1:${PORT} 上有服务在响应，但它看起来不是 ComfyUI。`,
    "ComfyArt 需要 ComfyUI 自带的路由（/comfyart/）。",
    "请确认 ComfyUI 监听的是 8188 端口，且没有其他程序占用该端口。",
  ].join(""),
  /** ComfyUI 在跑，但没装 ComfyArt 扩展。 */
  extension_missing: [
    `ComfyUI 已在运行，但没装 ComfyArt 扩展（/comfyart/ 返回 404）。`,
    "把 ComfyArt-main 整个目录放进 ComfyUI 的 custom_nodes/ 下，",
    "然后 pip install -r ComfyArt-main/requirements.txt（只需要 pypdfium2），重启 ComfyUI。",
  ].join(""),
  /** 装了扩展但前端没构建。 */
  not_built: [
    "ComfyArt 扩展已装好，但前端还没有构建（返回 503）。",
    "请在 ComfyArt-main 目录执行 npm install && npm run build，然后重启 ComfyUI。",
  ].join(""),
  /** 响应异常。 */
  bad_response: [
    `127.0.0.1:${PORT}/comfyart/ 返回了异常响应，无法确认 ComfyArt 是否可用。`,
    "请先在浏览器直接打开 http://127.0.0.1:8188/comfyart/ 确认它能正常显示。",
  ].join(""),
};;

async function main() {
  /**
   * 依次尝试候选主机名。第一个能对 /comfyart/ 返回 200 的胜出 —— 它决定了
   * 宿主 iframe 的 origin（必须与宿主页面 hostname 一致，否则被 ComfyUI 403）。
   * localhost 排第一：Electron 宿主页在 http://localhost:8083。
   */
  let lastFailure = null;
  let chosen = null;

  for (const host of HOST_CANDIDATES) {
    const base = `http://${host}:${PORT}`;
    const target = `${base}/comfyart/`;

    // ── 第一步：该主机名上有没有 ComfyUI 根路径 ───────────────────────
    let rootRes;
    try {
      rootRes = await probe(`${base}/`);
    } catch (err) {
      const kind = describeNetworkError(err);
      trace(`[${host}] 根路径探测失败: ${kind}`);
      lastFailure = { host, kind, stage: "root", timedOut: kind === "PROBE_TIMEOUT" };
      continue;
    }

    trace(`[${host}] 根路径 ${base}/ → ${rootRes.status}`);

    if (rootRes.status === 0 || rootRes.status >= 500) {
      lastFailure = { host, stage: "root", kind: `HTTP ${rootRes.status}` };
      continue;
    }

    // ── 第二步：/comfyart/ 是否可用 ──────────────────────────────────
    let artRes;
    try {
      artRes = await probe(target);
    } catch (err) {
      const kind = describeNetworkError(err);
      trace(`[${host}] /comfyart/ 探测失败: ${kind}`);
      lastFailure = { host, kind, stage: "art", timedOut: kind === "PROBE_TIMEOUT" };
      continue;
    }

    trace(`[${host}] /comfyart/ → ${artRes.status}`);

    if (artRes.status === 200) {
      chosen = { host, target, rootRes, artRes };
      break;
    }

    lastFailure = { host, stage: "art", status: artRes.status, rootRes, artRes };
  }

  // 所有候选都失败 → 按「最能说明问题」的失败翻译成中文原因。
  if (!chosen) {
    if (!lastFailure) {
      emit({ ok: false, error: GUIDE.comfyui_down });
      return;
    }
    if (lastFailure.kind === "ECONNREFUSED" || lastFailure.kind === "ECONNRESET") {
      emit({ ok: false, error: GUIDE.comfyui_down });
      return;
    }
    if (lastFailure.timedOut && lastFailure.stage === "root") {
      emit({
        ok: false,
        error: `ComfyUI 在 127.0.0.1:${PORT} 上无响应（${PROBE_TIMEOUT_MS}ms 超时）。它可能正在启动或已卡死，请稍后重试。`,
      });
      return;
    }
    if (lastFailure.timedOut && lastFailure.stage === "art") {
      emit({
        ok: false,
        error: `ComfyUI 的 /comfyart/ 页面响应超时（${PROBE_TIMEOUT_MS}ms），ComfyUI 可能正忙或已卡死。`,
      });
      return;
    }

    const { rootRes, artRes } = lastFailure;
    if (artRes) {
      if (artRes.status === 302 || artRes.status === 301) {
        trace(`意外重定向 → ${artRes.headers?.location ?? ""}`);
        emit({ ok: false, error: GUIDE.bad_response });
        return;
      }
      if (artRes.status === 404) {
        const looksLikeComfy = rootRes.status === 200 && /html|json/i.test(String(rootRes.headers?.["content-type"] ?? ""));
        emit({ ok: false, error: looksLikeComfy ? GUIDE.extension_missing : GUIDE.wrong_service });
        return;
      }
      if (artRes.status === 503) {
        emit({ ok: false, error: GUIDE.not_built });
        return;
      }
      emit({ ok: false, error: `${GUIDE.bad_response}（HTTP ${artRes.status}）` });
      return;
    }

    if (lastFailure.stage === "root" && rootRes === undefined) {
      emit({ ok: false, error: GUIDE.wrong_service });
      return;
    }
    emit({ ok: false, error: GUIDE.wrong_service });
    return;
  }

  // 成功：origin 必须是 loopback，且不带 token（guest.auth = "none"）。
  // 主机名与宿主页保持一致（localhost 优先），否则会被 ComfyUI 的 origin 中间件 403。
  trace(`选中主机名 ${chosen.host} → origin ${chosen.target}`);
  emit({
    ok: true,
    port: PORT,
    origin: chosen.target,
    reused: true,
    pid: 0,
    warnings: [],
  });
  return;
}

// 兜底：无论发生什么，都保证 stdout 恰好一行 JSON，且不悬挂。
const hardTimer = setTimeout(() => {
  emit({
    ok: false,
    error: `探测 ComfyUI 超时（${HARD_TIMEOUT_MS}ms）。请确认 127.0.0.1:${PORT} 上的 ComfyUI 是否正常。`,
  });
  process.exit(1);
}, HARD_TIMEOUT_MS);
hardTimer.unref?.();

main()
  .catch((err) => {
    trace(`未捕获异常: ${err?.stack ?? err}`);
    emit({ ok: false, error: `探测 ComfyUI 时发生内部错误：${err?.message ?? String(err)}` });
    process.exitCode = 1;
  })
  .finally(() => {
    clearTimeout(hardTimer);
    // 允许 stdout 刷盘后退出，避免宿主拿到空输出。
    setTimeout(() => process.exit(process.exitCode ?? 0), 30).unref?.();
  });
