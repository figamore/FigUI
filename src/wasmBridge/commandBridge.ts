// Request/response command sends for the wasm bridge's HTTP-shaped surface
// (src/lib/http.ts's sendCommand/sendSilent/getDeviceInfo(Fast), which real
// hardware answers over its /command endpoint -- see WebCommands.cpp /
// WebUIServer.cpp). That handler isn't compiled into the wasm build at all
// (WebUI/ is excluded -- see platformio.ini's [env:wasm] build_src_filter),
// so every command here is forwarded through the same shim channel
// WasmBridgeWebSocket reads from, using the grbl-line ok/error protocol
// directly (see shimTransport.ts). [ESP800] is the one exception: FluidNC's
// real handler for it lives in WebUI/WifiConfig.cpp, also excluded, and its
// only real purpose here is the capability-discovery handshake (App.tsx's
// parseESP800), not live device state -- so it's spoofed locally, matching
// WebUI-mm's commandTransport.ts.
import { sendToShim, addShimLineListener } from './shimTransport'

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

// Only one of these may be in flight at a time -- see the module comment in
// httpBridge.ts for why (this shares one physical ShimChannel with
// WasmBridgeWebSocket's own live command stream, unlike real hardware where
// /command and the WebSocket are genuinely independent connections/channels
// each with their own response stream).
let chain: Promise<unknown> = Promise.resolve()

export function sendBridgeCommand(cmd: string): Promise<string> {
  if (cmd === '[ESP800]') {
    return Promise.resolve(FAKE_ESP800_RESPONSE)
  }

  const next = chain.then(() => sendOnce(cmd), () => sendOnce(cmd))
  chain = next.catch(() => {})
  return next
}

function sendOnce(cmd: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const responseLines: string[] = []
    let jsonText = ''
    const unsubscribe = addShimLineListener((line, isJson) => {
      if (!isJson && (line.startsWith('ok') || line.startsWith('error'))) {
        unsubscribe()
        if (line.startsWith('ok')) {
          resolve(jsonText || responseLines.join('\n'))
        } else {
          reject(new Error(line))
        }
        return
      }
      if (isJson) {
        jsonText += line
      } else {
        responseLines.push(line)
      }
    })
    sendToShim(`${cmd}\n`)
  })
}
