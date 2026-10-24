/**
 * 场景：ComfyArt 子应用面板 — host.guest.mount 嵌入 ComfyUI 托管的 /comfyart/。
 *
 * 三条硬约束（对应 EMBED.md §⑤/§⑦）：
 *  1. 贴边满铺：根容器 backgroundColor 必须 transparent，只用主题色，禁止自带底色。
 *  2. 不白屏：首帧即品牌扫光；ComfyUI 未运行时渲染**引导态**（说明 + 可复制命令 + 重试），
 *     而不是「状态页 + 打开外部应用」。
 *  3. 失败可恢复：引导态里点「重试」直接重新 mount，不需要重启 Agnx。
 */
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type CSSProperties,
  type ComponentType,
  type ReactElement,
} from "react";
import type {
  WorkspaceAppBrandLogoLoaderPanelProps,
  WorkspaceAppHostApi,
} from "@agnx-lab/app-sdk";
import {
  COMFYART_APP_ID,
  COMFYART_APP_TITLE,
  DEFAULT_COMFYUI_PORT,
  COMFYART_ENSURE_TOOL_REL,
} from "./constants";

const WEB_ROOT_STYLE: CSSProperties = {
  flex: "1 1 0%",
  alignSelf: "stretch",
  minHeight: 0,
  minWidth: 0,
  width: "100%",
  height: "100%",
  overflow: "hidden",
  display: "flex",
  flexDirection: "column",
  position: "relative",
  // 硬门禁：面板根必须透明，颜色一律走宿主主题。
  backgroundColor: "transparent",
};

const GUEST_HOST_STYLE: CSSProperties = {
  flex: "1 1 auto",
  minHeight: 0,
  minWidth: 0,
  width: "100%",
  height: "100%",
  overflow: "hidden",
  display: "flex",
  flexDirection: "column",
  position: "relative",
};

/** 首帧遮罩：同样保持透明，只叠一层品牌扫光，避免与宿主主题打架。 */
const BOOT_LAYER_STYLE: CSSProperties = {
  position: "absolute",
  inset: 0,
  zIndex: 2,
  display: "flex",
  flexDirection: "column",
  backgroundColor: "transparent",
};

/** 引导态容器：不铺不透明底，交给宿主主题。 */
const GUIDE_LAYER_STYLE: CSSProperties = {
  position: "absolute",
  inset: 0,
  zIndex: 3,
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  padding: 24,
  overflow: "auto",
  backgroundColor: "transparent",
};

/** 引导态内卡片：仅用半透明/描边表达层次，不写死品牌色。 */
const GUIDE_CARD_STYLE: CSSProperties = {
  maxWidth: 560,
  width: "100%",
  display: "flex",
  flexDirection: "column",
  gap: 12,
  textAlign: "center",
};

let boundHost: WorkspaceAppHostApi | null = null;

function getHost(): WorkspaceAppHostApi | null {
  return boundHost;
}

export function bindComfyArtHost(host: WorkspaceAppHostApi | null): void {
  boundHost = host;
}

export interface ComfyArtPanelProps {
  /** 宿主可传入；目前面板不依赖，保留以便后续配置端口。 */
  initialPort?: number;
}

type PanelPhase = "booting" | "ready" | "guide";

export function ComfyArtPanel(props: ComfyArtPanelProps = {}): ReactElement {
  const port = props.initialPort ?? DEFAULT_COMFYUI_PORT;
  const guestHostRef = useRef<HTMLDivElement | null>(null);
  const unmountRef = useRef<(() => void) | null>(null);
  const [phase, setPhase] = useState<PanelPhase>("booting");
  const [guideText, setGuideText] = useState<string | null>(null);
  /** 用于强制重建 mount（重试）。 */
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    const host = getHost();
    if (!host?.guest?.mount) {
      setPhase("guide");
      setGuideText("当前 Agnx 版本未提供 host.guest.mount，无法嵌入 ComfyArt。请升级 Agnx 后重试。");
      return;
    }
    const container = guestHostRef.current;
    if (!container) {
      return;
    }

    let cancelled = false;
    setPhase("booting");
    setGuideText(null);

    const unmount = host.guest.mount({
      container,
      ensureTool: COMFYART_ENSURE_TOOL_REL,
      ensureArgs: ["--port", String(port)],
      // ComfyUI 已在运行时应秒回；留足余量以防冷启动很慢。
      timeoutMs: 60_000,
      surfaceReadyTimeoutMs: 30_000,
      // 遮罩由本面板持有，避免双层闪黑。
      bootOverlay: false,
      bootTitle: COMFYART_APP_TITLE,
      onReady: () => {
        if (cancelled) return;
        setGuideText(null);
        // 留一帧给上游首屏绘制，再撤遮罩。
        window.setTimeout(() => {
          if (!cancelled) setPhase("ready");
        }, 300);
      },
      onError: (detail) => {
        if (cancelled) return;
        // ensure 探针给的中文原因最有用，直接透出；否则用宿主给的 message。
        const isEnsureFailure = detail.code === "GUEST_ENSURE_FAILED" || detail.code === "GUEST_MOUNT_ERROR";
        const text = isEnsureFailure
          ? extractUserReason(detail.message)
          : `${detail.code}: ${detail.message}`;
        setGuideText(text);
        setPhase("guide");
      },
    });
    unmountRef.current = unmount;

    return () => {
      cancelled = true;
      unmountRef.current = null;
      unmount();
    };
  }, [port, attempt]);

  const retry = useCallback(() => {
    unmountRef.current?.();
    setAttempt((n) => n + 1);
  }, []);

  const BrandPanel = getHost()?.ui?.BrandLogoLoaderPanel as
    | ComponentType<WorkspaceAppBrandLogoLoaderPanelProps>
    | undefined;

  return (
    <div style={WEB_ROOT_STYLE} aria-label={`${COMFYART_APP_TITLE} panel`}>
      <div
        ref={guestHostRef}
        data-agnx-guest-surface-host="true"
        data-testid={`workspace-mini-app-${COMFYART_APP_ID}-root`}
        style={GUEST_HOST_STYLE}
      />

      {phase === "booting" ? (
        <div data-agnx-guest-boot-overlay="true" style={BOOT_LAYER_STYLE} role="status">
          {BrandPanel ? (
            <BrandPanel title={`正在连接 ${COMFYART_APP_TITLE}…`} testID="comfyart-boot-overlay" />
          ) : (
            <div style={{ ...GUIDE_LAYER_STYLE, position: "static" }}>
              <div style={GUIDE_CARD_STYLE}>{`正在连接 ${COMFYART_APP_TITLE}…`}</div>
            </div>
          )}
        </div>
      ) : null}

      {phase === "guide" ? (
        <ComfyArtGuideState
          port={port}
          message={guideText ?? "无法连接到 ComfyUI。"}
          onRetry={retry}
        />
      ) : null}
    </div>
  );
}

/**
 * 从 ensure 探针的失败消息里取出给用户看的中文原因。
 * 宿主会把 sidecar stdout 的 JSON 塞进 message，形如：
 *   ensure 失败: {"ok":false,"error":"没有检测到正在运行的 ComfyUI…"}
 */
function extractUserReason(message: string): string {
  const idx = message.indexOf("{");
  if (idx >= 0) {
    try {
      const parsed = JSON.parse(message.slice(idx)) as { error?: unknown };
      if (typeof parsed.error === "string" && parsed.error.trim().length > 0) {
        return parsed.error;
      }
    } catch {
      // 落到下面按原文返回。
    }
  }
  return message;
}

interface ComfyArtGuideStateProps {
  port: number;
  message: string;
  onRetry: () => void;
}

/**
 * 引导态：明确告诉用户「ComfyUI 没起来」以及怎么起来。
 * 不调用 window.alert / prompt（SKILL 明确禁止长留），也不打开外部浏览器当作主路径。
 */
function ComfyArtGuideState({ port, message, onRetry }: ComfyArtGuideStateProps): ReactElement {
  const command = `cd /path/to/ComfyUI && python main.py --listen 127.0.0.1 --port ${port}`;
  const [copied, setCopied] = useState(false);

  const copy = useCallback(() => {
    const nav = globalThis.navigator as Navigator | undefined;
    if (!nav?.clipboard?.writeText) return;
    void nav.clipboard.writeText(command).then(
      () => {
        setCopied(true);
        window.setTimeout(() => setCopied(false), 2000);
      },
      () => {
        // 剪贴板不可用时不弹窗，用户可直接选中文本复制。
      },
    );
  }, [command]);

  return (
    <div style={GUIDE_LAYER_STYLE} role="alert" data-testid="comfyart-guide-state">
      <div style={GUIDE_CARD_STYLE}>
        <div style={{ fontSize: 15, lineHeight: 1.7 }}>{message}</div>
        <div
          style={{
            fontFamily:
              'ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, "Liberation Mono", monospace',
            fontSize: 12,
            lineHeight: 1.6,
            padding: "10px 12px",
            borderRadius: 8,
            border: "1px solid currentColor",
            opacity: 0.85,
            textAlign: "left",
            whiteSpace: "pre-wrap",
            wordBreak: "break-all",
            userSelect: "all",
          }}
        >
          {command}
        </div>
        <div style={{ display: "flex", gap: 8, justifyContent: "center" }}>
          <button
            type="button"
            onClick={copy}
            style={{
              padding: "8px 16px",
              borderRadius: 8,
              border: "1px solid currentColor",
              background: "transparent",
              color: "inherit",
              cursor: "pointer",
              fontSize: 13,
            }}
          >
            {copied ? "已复制" : "复制启动命令"}
          </button>
          <button
            type="button"
            onClick={onRetry}
            style={{
              padding: "8px 16px",
              borderRadius: 8,
              border: "1px solid currentColor",
              background: "transparent",
              color: "inherit",
              cursor: "pointer",
              fontSize: 13,
            }}
          >
            重试
          </button>
        </div>
        <div style={{ fontSize: 12, lineHeight: 1.7, opacity: 0.7 }}>
          {`ComfyArt 是 ComfyUI 的插件，由 ComfyUI 在 127.0.0.1:${port}/comfyart/ 提供页面。`}
          <br />
          启动 ComfyUI 后点「重试」即可，无需重启 Agnx。
        </div>
      </div>
    </div>
  );
}

export { getHost as getComfyArtHost };
