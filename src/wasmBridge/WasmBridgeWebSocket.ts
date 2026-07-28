// A WebSocket-shaped class backed by the WASM demo's postMessage bridge
// instead of a real network socket -- installed as `window.WebSocket` (see
// index.ts) so src/lib/ws.ts works completely unmodified, the same way it
// talks to a real FluidNC WebSocket. Modeled directly on src/demo/
// wsSimulator.ts's FakeWebSocket (same public surface, since that's what
// ws.ts's `new WebSocket(url, 'arduino')` call needs), but instead of
// simulating a machine in JS, it relays to a real compiled FluidNC instance
// via shimTransport's postMessage channel.
//
// Known limitation: on real hardware, /command (src/lib/http.ts) and this
// WebSocket are genuinely independent connections, each answered by its own
// Channel object, so their response streams never cross. Here they both
// share the one physical ShimChannel. demo/index.html's 'fluidnc-shim-
// command' RPC (see commandBridge.ts, shimTransport.ts's sendShimCommand())
// now queues /command calls against each other centrally, so two of those
// can no longer misattribute each other's response lines -- but an
// HTTP-shaped /command call can still in principle race a raw G-code send
// made directly through this WebSocket (send() below posts straight to the
// shim, bypassing that queue), and have its ok/error line misattributed to
// whichever one asked first. In practice /command calls are rare (mostly
// startup queries), so that narrower remaining gap is left as-is rather
// than adding a second wasm-side channel.
import { sendToShim, addShimLineListener } from './shimTransport'

export class WasmBridgeWebSocket extends EventTarget {
  static readonly CONNECTING = 0
  static readonly OPEN = 1
  static readonly CLOSING = 2
  static readonly CLOSED = 3

  readonly CONNECTING = 0
  readonly OPEN = 1
  readonly CLOSING = 2
  readonly CLOSED = 3

  readyState: number = 0
  binaryType: BinaryType = 'arraybuffer'
  readonly url: string
  readonly protocol: string
  readonly bufferedAmount = 0
  readonly extensions = ''

  onopen: ((e: Event) => void) | null = null
  onclose: ((e: CloseEvent) => void) | null = null
  onerror: ((e: Event) => void) | null = null
  onmessage: ((e: MessageEvent) => void) | null = null

  private unsubscribe: (() => void) | null = null

  constructor(url: string, protocols?: string | string[]) {
    super()
    this.url = url
    this.protocol = Array.isArray(protocols) ? (protocols[0] ?? '') : (protocols ?? '')
    // Deferred rather than synchronous so callers that set onopen/onmessage
    // right after `new WebSocket(...)` (as ws.ts does) don't miss the open
    // event -- matches a real WebSocket's inherently async connect.
    setTimeout(() => this._open(), 0)
  }

  private _open() {
    this.readyState = 1
    // isJson is irrelevant here: whether a line came from a [JSON:...]
    // reassembly or not, ws.ts wants the same thing real hardware's
    // WSChannel would have sent it -- plain unwrapped text.
    this.unsubscribe = addShimLineListener((line) => {
      const ev = new MessageEvent('message', { data: `${line}\n` })
      this.onmessage?.(ev)
      this.dispatchEvent(ev)
    })
    const ev = new Event('open')
    this.onopen?.(ev)
    this.dispatchEvent(ev)
  }

  send(data: string | ArrayBuffer | ArrayBufferView | Blob): void {
    if (this.readyState !== 1) return

    if (data instanceof ArrayBuffer || ArrayBuffer.isView(data)) {
      const buf =
        data instanceof ArrayBuffer
          ? new Uint8Array(data)
          : new Uint8Array((data as ArrayBufferView).buffer, (data as ArrayBufferView).byteOffset, (data as ArrayBufferView).byteLength)
      // Realtime bytes ('?', ctrl-X, ...) -- ws.ts sends these as a single
      // byte, same as it would write to a real socket. sendToShim() takes a
      // string (emscripten's cwrap marshals it as UTF-8), and every
      // realtime byte FluidNC defines is single-byte-UTF8-safe.
      sendToShim(String.fromCharCode(...buf))
      return
    }

    if (typeof data === 'string') {
      sendToShim(data)
    }
  }

  close(code?: number, reason?: string) {
    if (this.readyState === 3) return
    this.readyState = 3
    if (this.unsubscribe) {
      this.unsubscribe()
      this.unsubscribe = null
    }
    const ev = new CloseEvent('close', { wasClean: true, code: code ?? 1000, reason: reason ?? '' })
    this.onclose?.(ev)
    this.dispatchEvent(ev)
  }
}
