// Request/response command sends for the wasm bridge's HTTP-shaped surface
// (src/lib/http.ts's sendCommand/sendSilent/getDeviceInfo(Fast), which real
// hardware answers over its /command endpoint -- see WebCommands.cpp /
// WebUIServer.cpp). That handler isn't compiled into the wasm build at all
// (WebUI/ is excluded -- see platformio.ini's [env:wasm] build_src_filter),
// so every command here is forwarded through the same shim channel
// WasmBridgeWebSocket reads from, using shimTransport's sendShimCommand()
// (demo/index.html collects the response and queues concurrent sends
// centrally, so this doesn't need to serialize them itself anymore).
// [ESP800] is the one exception: FluidNC's real handler for it lives in
// WebUI/WifiConfig.cpp, also excluded, and its only real purpose here is
// the capability-discovery handshake (App.tsx's parseESP800), not live
// device state -- so it's spoofed locally, matching WebUI-mm's
// commandTransport.ts.
import { sendShimCommand } from './shimTransport'

const FAKE_ESP800_RESPONSE = [
  'FW version:FluidNC v4.0.3 (wasm-demo)',
  'FW target:grbl-embedded',
  'FW HW:Direct SD',
  'primary sd:/sd/',
  'secondary sd:none',
  'authentication:no',
  'webcommunication:Sync:81:127.0.0.1',
  'hostname:fluidnc-wasm-demo',
  'axis:3',
].join('#')

export function sendBridgeCommand(cmd: string): Promise<string> {
  if (cmd === '[ESP800]') {
    return Promise.resolve(FAKE_ESP800_RESPONSE)
  }
  return sendShimCommand(cmd)
}
