// Low-level postMessage client for the FluidNC WASM demo's bridge (see
// FluidNC/wasm/README.md and demo/index.html's self.fluidncOnShimOutput /
// 'fluidnc-shim-send' listener). This is the same protocol WebUI-mm's own
// wasmBridgeTransport.ts speaks -- the demo page doesn't know or care which
// WebUI is loaded in its iframe, so nothing on the FluidNC/demo side needed
// to change for FigUI to use it too.
//
// Two message kinds share this one postMessage channel:
//  - 'fluidnc-shim-line'/'fluidnc-shim-send': ShimChannel's Grbl-line
//    protocol. demo/index.html buffers raw shim output into whole lines and
//    reassembles [JSON:...]-encapsulated chunks (see FluidNC's JSONencoder
//    -- a JSON payload sent out over a serial-shaped channel is wrapped
//    that way so a payload line can never be mistaken for the ok/error
//    line that terminates a command) itself before ever posting a line
//    here, so this module just relays whole, already-unwrapped lines to
//    listeners -- matching what FigUI's own code already expects to see
//    from real hardware's WebSocket (WSChannel doesn't use that wrapping --
//    see WebCommands.cpp/ShimChannel.cpp).
//  - 'fluidnc-fs-request'/'fluidnc-fs-response': a request/response RPC for
//    file operations, answered directly against the WASM instance's MEMFS
//    (list/delete/deletedir/mkdir/read/write) -- see demo/index.html's
//    handleFsRequest().
//  - 'fluidnc-shim-command'/'fluidnc-shim-command-response': send a
//    command, get back its collected response once the ok/error terminator
//    arrives -- see demo/index.html's deliverShimLine()/
//    maybeStartNextShimCommand(), which also queues these so two in flight
//    at once can't have their response lines cross-attributed (this used
//    to be commandBridge.ts's own job, via a hand-rolled line collector and
//    a Promise chain to serialize sends -- both gone now that
//    demo/index.html does it centrally for every WebUI bridge).

type LineListener = (line: string, isJson: boolean) => void

interface FsResponse {
  type: 'fluidnc-fs-response'
  id: number
  ok: boolean
  result?: unknown
}

interface ShimCommandResponse {
  type: 'fluidnc-shim-command-response'
  id: number
  ok: boolean
  response: string
  ackLine: string
}

const lineListeners: LineListener[] = []
const pendingFsRequests = new Map<number, { resolve: (result: unknown) => void; reject: (error: Error) => void }>()
const pendingShimCommands = new Map<number, { resolve: (response: string) => void; reject: (error: Error) => void }>()
let nextRequestId = 1
let nextCommandId = 1

// Set by a marker <script> the demo injects ahead of the actual page
// content before Blob-constructing the iframe's document -- see
// demo/index.html's webuiSelect handler / loadWebuiHtml().
export function isWasmBridgeActive(): boolean {
  return typeof window !== 'undefined' && (window as unknown as Record<string, unknown>).__FLUIDNC_WASM_BRIDGE__ === true
}

if (typeof window !== 'undefined') {
  window.addEventListener('message', (event: MessageEvent) => {
    // The demo page is the only legitimate sender -- postMessage's
    // targetOrigin is '*' on both ends (this document is loaded from a
    // blob: URL with no fixed origin to pin to), so checking the source
    // window is the only authenticity check available.
    if (event.source !== window.parent) return
    const msg = event.data
    if (msg && msg.type === 'fluidnc-shim-line' && typeof msg.line === 'string') {
      lineListeners.forEach((fn) => fn(msg.line, !!msg.isJson))
    } else if (msg && msg.type === 'fluidnc-shim-command-response' && typeof msg.id === 'number') {
      const response = msg as ShimCommandResponse
      const pending = pendingShimCommands.get(response.id)
      if (!pending) return
      pendingShimCommands.delete(response.id)
      if (response.ok) {
        pending.resolve(response.response)
      } else {
        pending.reject(new Error(response.ackLine))
      }
    } else if (msg && msg.type === 'fluidnc-fs-response' && typeof msg.id === 'number') {
      const response = msg as FsResponse
      const pending = pendingFsRequests.get(response.id)
      if (!pending) return
      pendingFsRequests.delete(response.id)
      if (response.ok) {
        pending.resolve(response.result)
      } else {
        pending.reject(new Error(typeof response.result === 'string' ? response.result : 'File operation failed'))
      }
    }
  })
}

export function sendToShim(text: string): void {
  window.parent.postMessage({ type: 'fluidnc-shim-send', text }, '*')
}

// Sends a command and resolves with its collected response once the
// ok/error terminator line arrives -- see demo/index.html's
// deliverShimLine()/maybeStartNextShimCommand(), which also queues these
// centrally so concurrent sends can't have their response lines
// cross-attributed over the bridge's one shared channel.
export function sendShimCommand(cmd: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const id = nextCommandId++
    pendingShimCommands.set(id, { resolve, reject })
    window.parent.postMessage({ type: 'fluidnc-shim-command', id, cmd }, '*')
  })
}

// isJson is true exactly when `line` is a fully reassembled [JSON:...]
// payload (brackets already stripped, chunks concatenated) rather than a
// normal protocol line -- callers should never need to sniff line content
// to tell the two apart.
export function addShimLineListener(fn: LineListener): () => void {
  lineListeners.push(fn)
  return () => {
    const i = lineListeners.indexOf(fn)
    if (i >= 0) lineListeners.splice(i, 1)
  }
}

// root is "native_sd" or "native_localfs"; path is POSIX-absolute-style
// ("/", "/sub/file.nc"), matching what demo/index.html's handleFsRequest
// (and the C++ fluidnc_fs_* bridge functions it calls) expect.
export function fsRequest(op: string, params: Record<string, unknown>): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const id = nextRequestId++
    pendingFsRequests.set(id, { resolve, reject })
    window.parent.postMessage({ type: 'fluidnc-fs-request', id, op, ...params }, '*')
  })
}
