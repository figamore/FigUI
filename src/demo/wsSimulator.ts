import { statusReport, handleRealtime, handleTextCommand, getProbeGeneration } from './machine'

// Replaces window.WebSocket in demo mode — no network, pure in-browser simulation
export class FakeWebSocket extends EventTarget {
  static readonly CONNECTING = 0
  static readonly OPEN       = 1
  static readonly CLOSING    = 2
  static readonly CLOSED     = 3

  readonly CONNECTING = 0
  readonly OPEN       = 1
  readonly CLOSING    = 2
  readonly CLOSED     = 3

  readyState: number = 0
  binaryType: BinaryType = 'arraybuffer'
  readonly url: string
  readonly protocol: string
  readonly bufferedAmount = 0
  readonly extensions = ''

  onopen:    ((e: Event) => void)        | null = null
  onclose:   ((e: CloseEvent) => void)   | null = null
  onerror:   ((e: Event) => void)        | null = null
  onmessage: ((e: MessageEvent) => void) | null = null

  private statusTimer: ReturnType<typeof setInterval> | null = null

  constructor(url: string, protocols?: string | string[]) {
    super()
    this.url = url
    this.protocol = Array.isArray(protocols) ? (protocols[0] ?? '') : (protocols ?? '')
    setTimeout(() => this._open(), 80)
  }

  private _open() {
    this.readyState = 1
    const pageId = String(Math.floor(Math.random() * 9000) + 1000)
    const ev = new Event('open')
    this.onopen?.(ev)
    this.dispatchEvent(ev)
    this._emit(`CURRENT_ID:${pageId}\n`)
    this.statusTimer = setInterval(() => {
      if (this.readyState === 1) this._emit(statusReport() + '\n')
    }, 500)
  }

  private _emit(data: string) {
    const ev = new MessageEvent('message', { data })
    this.onmessage?.(ev)
    this.dispatchEvent(ev)
  }

  send(data: string | ArrayBuffer | ArrayBufferView | Blob): void {
    if (this.readyState !== 1) return

    if (data instanceof ArrayBuffer || ArrayBuffer.isView(data)) {
      const buf = data instanceof ArrayBuffer
        ? new Uint8Array(data)
        : new Uint8Array(
            (data as ArrayBufferView).buffer,
            (data as ArrayBufferView).byteOffset,
            (data as ArrayBufferView).byteLength,
          )
      if (buf.length === 1) { handleRealtime(buf[0]); return }
      this._handleText(new TextDecoder().decode(buf))
    } else if (typeof data === 'string') {
      this._handleText(data)
    }
  }

  private commandQueue: Promise<unknown> = Promise.resolve()

  private _handleText(text: string) {
    // Serialize lines in arrival order: handleTextCommand sleeps to simulate
    // motion, so dispatching concurrently could interleave moves with a
    // pending PRB report from an earlier command in the same payload.
    for (const line of text.split('\n')) {
      if (!line.trim()) continue
      // Snapshot the generation at enqueue time: a soft reset that lands
      // while this line waits in the queue must discard it at dispatch.
      const queuedGeneration = getProbeGeneration()
      this.commandQueue = this.commandQueue
        .then(() => {
          if (this.readyState !== 1) return
          return handleTextCommand(line, (msg) => this._emit(msg), queuedGeneration)
        })
        .catch(() => { /* keep the queue alive if one command fails */ })
    }
  }

  close(code?: number, reason?: string) {
    if (this.readyState === 3) return
    if (this.statusTimer) { clearInterval(this.statusTimer); this.statusTimer = null }
    this.readyState = 3
    const ev = new CloseEvent('close', { wasClean: true, code: code ?? 1000, reason: reason ?? '' })
    this.onclose?.(ev)
    this.dispatchEvent(ev)
  }
}
