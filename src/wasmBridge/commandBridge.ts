// Request/response command sends for the wasm bridge's HTTP-shaped surface
// (src/lib/http.ts's sendCommand/sendSilent/getDeviceInfo(Fast), which real
// hardware answers over its /command endpoint -- see WebCommands.cpp /
// WebUIServer.cpp). That handler isn't compiled into the wasm build at all
// (WebUI/ is excluded -- see platformio.ini's [env:wasm] build_src_filter),
// so every command here is forwarded through the same shim channel
// WasmBridgeWebSocket reads from, using shimTransport's sendShimCommand()
// (demo/index.html collects the response and queues concurrent sends
// centrally, so this doesn't need to serialize them itself anymore).
// [ESP800] used to be spoofed locally here (its real handler lives in
// WebUI/WifiConfig.cpp, also excluded, and needs WiFi/WebUI_Server APIs
// that don't exist in this build) -- wasm/FwInfo.cpp now provides a real,
// wasm-specific handler instead, so it's just another command.
import { sendShimCommand } from './shimTransport'

export function sendBridgeCommand(cmd: string): Promise<string> {
  return sendShimCommand(cmd)
}
