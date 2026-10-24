/**
 * 场景：ComfyArt Sub App 常量（AppId / 命令 / 面板 / ensure / 端口）。
 */
export const COMFYART_APP_ID = "comfyart";
export const COMFYART_APP_TITLE = "ComfyArt";
export const COMFYART_PANEL_ID = "comfyart.main";
export const COMFYART_OPEN_COMMAND_ID = "comfyart.open";

/** 短跑 sidecar：探测本机是否已有 ComfyUI + ComfyArt（只探不起）。 */
export const COMFYART_ENSURE_TOOL_REL = ".agnx/tools/ensure-comfyart.mjs";

/**
 * ComfyUI 默认端口。ComfyArt 由 ComfyUI 托管在 /comfyart/，
 * 因此这个端口是「ComfyUI 的端口」，不是 ComfyArt 自己的端口。
 */
export const DEFAULT_COMFYUI_PORT = 8188;

/**
 * 必须用 127.0.0.1 而非 localhost。
 * ComfyUI 的 create_origin_only_middleware 会比对 Host 与 Origin 的主机名，
 * 实测 localhost 与 127.0.0.1 混用会直接 403。
 */
export const COMFYUI_LOOPBACK_HOST = "127.0.0.1";
