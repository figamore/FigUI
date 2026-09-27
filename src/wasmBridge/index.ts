import { isWasmBridgeActive } from './shimTransport'
import { WasmBridgeWebSocket } from './WasmBridgeWebSocket'
import { installFetchInterceptor, installXhrInterceptor } from './httpBridge'

// Mirrors src/demo/index.ts's installDemoMode() (replace window.WebSocket,
// intercept fetch/XHR), but gated on a runtime marker (see
// shimTransport.ts's isWasmBridgeActive()) instead of the build-time
// VITE_DEMO_MODE flag -- so a stock production build (e.g. `npm run
// build:esp32`, the real firmware-deployment artifact) works unmodified
// when loaded inside the FluidNC WASM demo's iframe, without needing a
// special build mode of its own. Unlike demo mode, which fully simulates a
// machine in JS, this talks to a real compiled FluidNC instance running in
// WebAssembly, via postMessage -- see FluidNC/wasm/README.md.
//
// Called unconditionally from main.tsx (not behind an import.meta.env
// check) so it survives tree-shaking in every build mode; it's a no-op
// unless the runtime marker is present.
export function installWasmBridgeIfActive(): void {
  if (!isWasmBridgeActive()) return
  ;(window as unknown as { WebSocket: unknown }).WebSocket = WasmBridgeWebSocket
  installFetchInterceptor()
  installXhrInterceptor()
}
