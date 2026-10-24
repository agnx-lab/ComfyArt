/**
 * 场景：ComfyArt Sub App 入口 — 注册面板 + 打开命令，嵌入 ComfyUI 托管的 /comfyart/。
 */
import type { WorkspaceAppHostApi, WorkspaceAppModule } from "@agnx-lab/app-sdk";
import {
  COMFYART_APP_ID,
  COMFYART_APP_TITLE,
  COMFYART_ENSURE_TOOL_REL,
  COMFYART_OPEN_COMMAND_ID,
  COMFYART_PANEL_ID,
} from "./constants";
import { bindComfyArtHost, ComfyArtPanel } from "./panel";

export const appId = COMFYART_APP_ID;

interface OpenContext {
  serverId?: string;
  workspaceId?: string;
  currentPathname?: string | null;
}

function openComfyArtTab(host: WorkspaceAppHostApi, context?: OpenContext): void {
  // openSubAppTab 是新名；旧名 openMiniAppTab 等价，此处用新名。
  host.openSubAppTab({
    appId: COMFYART_APP_ID,
    panelId: COMFYART_PANEL_ID,
    serverId: context?.serverId,
    workspaceId: context?.workspaceId,
    currentPathname: context?.currentPathname,
  });
}

/**
 * 宿主在卸载 App 时调用 deactivate；registerMiniApp / registerCommand 本身返回 void，
 * 由宿主统一回收注册项，这里只需断开 host 引用。
 */
export function activate(host: WorkspaceAppHostApi): void {
  bindComfyArtHost(host);

  host.registerMiniApp({
    id: COMFYART_PANEL_ID,
    appId: COMFYART_APP_ID,
    title: COMFYART_APP_TITLE,
    component: ComfyArtPanel,
    /**
     * 网页端会被升格成 proxied-iframe，iframe 内部的快捷键必须由 relay 捕获，
     * 否则 Cmd+W / Cmd+S 之类会把 Agnx 自己的窗口吃掉。
     */
    iframeShortcutCapture: true,
    isolation: {
      mode: "iframe",
      sidecarTools: [COMFYART_ENSURE_TOOL_REL],
      note: "Tab 内嵌 ComfyUI 托管的 /comfyart/；ensure 只探测本机 ComfyUI，不代为安装或启动",
    },
  });

  host.registerCommand({
    id: COMFYART_OPEN_COMMAND_ID,
    appId: COMFYART_APP_ID,
    title: COMFYART_APP_TITLE,
    keywords: ["comfyart", "comfyui", "art", "design", "canvas", "画布", "设计", "绘图"],
    sidebarAction: {
      defaultVisible: true,
      label: "ComfyArt",
      order: 62,
    },
    run: (context) => {
      openComfyArtTab(host, context);
    },
  });
}

export function deactivate(): void {
  bindComfyArtHost(null);
}

const moduleExport: WorkspaceAppModule = {
  appId: COMFYART_APP_ID,
  activate,
  deactivate,
};

export default moduleExport;
