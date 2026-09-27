import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import { App } from './App'
import './store/terminal'
import './lib/jogWatchdog'
import { disconnect as disconnectWs } from './lib/ws'
import { installWasmBridgeIfActive } from './wasmBridge'

if (import.meta.env.VITE_DEMO_MODE) {
  const { installDemoMode } = await import('./demo')
  installDemoMode()
}

// Not gated by import.meta.env, unlike installDemoMode() above -- this must
// survive in every build mode (including the real `build:esp32` artifact),
// since it's how a stock build detects it's running inside the FluidNC WASM
// demo at runtime. See wasmBridge/index.ts.
installWasmBridgeIfActive()

window.addEventListener('pagehide', () => { disconnectWs() })

// Suppress expected connection errors
function isExpectedTransportError(reason: unknown): boolean {
  if (!reason) return false
  const msg = (reason instanceof Error ? reason.message : String(reason)).toLowerCase()
  return (
    msg.includes('failed to fetch') ||
    msg.includes('networkerror') ||
    msg.includes('load failed') ||           // Safari
    msg.includes('the operation was aborted') ||
    msg.includes('the user aborted') ||
    msg.includes('http timeout') ||
    msg.includes('websocket')
  )
}
window.addEventListener('unhandledrejection', (e) => {
  if (isExpectedTransportError(e.reason)) e.preventDefault()
})

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
