import { uiText as __uiText } from '../lib/i18n'
import { useEffect, useRef, useState } from 'react'
import { Puzzle, X, RefreshCw } from 'lucide-react'
import { useMachineStore } from '../store'
import { sendCommand, listFiles as listDeviceFiles, fetchFileContent, saveFileContent, getBase } from '../lib/http'
import { invalidateFileCache } from './FileManager'
import { lineRefusalReason, sendRaw, sendRealtime, onLine, onSessionTaken } from '../lib/ws'
import { sendCloseCommand } from '../lib/pluginClose'
import { loadPluginEntry } from '../lib/plugins'
import { createPluginJogSender } from '../lib/pluginJog'
import { pluginSession } from '../lib/pluginSession'
import { useGCodeSenderStore } from '../store/gcodeSender'
import type { Plugin } from '../types'

interface PluginRequest {
  type: 'fluid-request'
  id: string
  method: string
  params?: Record<string, unknown>
}

const MIN_W = 320
const MIN_H = 280
const DEFAULT_W = 500
const DEFAULT_H = 600

const THEME_VARS = [
  '--bg', '--surface', '--elevated', '--border', '--border-strong',
  '--accent', '--accent-hover', '--text-primary', '--text-muted', '--text-dim',
  '--ok', '--danger', '--warn', '--info', '--purple', '--teal',
  '--ok-rgb', '--danger-rgb', '--warn-rgb', '--info-rgb',
  '--accent-rgb', '--purple-rgb', '--teal-rgb',
]

function clamp(v: number, lo: number, hi: number) {
  return Math.min(Math.max(v, lo), hi)
}

function getThemeVars(): Record<string, string> {
  const cs = getComputedStyle(document.documentElement)
  const vars: Record<string, string> = {}
  for (const name of THEME_VARS) vars[name] = cs.getPropertyValue(name).trim()
  vars['--plugin-color-scheme'] = cs.colorScheme
  return vars
}

function prepareHtml(html: string, baseUrl: string, themeVars: Record<string, string>): string {
  const baseTag = /<base\s/i.test(html) ? '' : `<base href="${baseUrl}">`
  const themeScript = `<script>(function(){var v=${JSON.stringify(themeVars)},r=document.documentElement;for(var k in v)r.style.setProperty(k,v[k]);window.addEventListener('message',function(e){if(e.source===parent&&e.data&&e.data.type==='fluid-theme')for(var k in e.data.vars)r.style.setProperty(k,e.data.vars[k]);});})()</script>`
  const injection = baseTag + themeScript
  return /<head[^>]*>/i.test(html)
    ? html.replace(/(<head[^>]*>)/i, `$1${injection}`)
    : injection + html
}

export function PluginFrame({ plugin, onClose, inline }: { plugin: Plugin; onClose: () => void; inline?: boolean }) {
  const iframeRef = useRef<HTMLIFrameElement>(null)
  const statusSubscribed = useRef(false)
  const lineUnsubRef = useRef<(() => void) | null>(null)
  // A line the plugin asked to be sent when its window goes away (a laser
  // pointer's M5): the plugin itself is unreachable by then.
  const closeCommandRef = useRef('')
  const [srcDoc, setSrcDoc] = useState<string | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [frameLoaded, setFrameLoaded] = useState(false)

  const isMobile = window.innerWidth < 768

  const [pos, setPos] = useState(() => ({
    x: Math.round(clamp((window.innerWidth - DEFAULT_W) / 2, 20, window.innerWidth - DEFAULT_W - 20)),
    y: Math.round(clamp((window.innerHeight - DEFAULT_H) / 4, 20, window.innerHeight - DEFAULT_H - 20)),
  }))
  const [size, setSize] = useState({ w: DEFAULT_W, h: DEFAULT_H })
  const [interacting, setInteracting] = useState(false)

  const dragRef = useRef<{ ox: number; oy: number } | null>(null)
  const resizeRef = useRef<{ ox: number; oy: number; ow: number; oh: number } | null>(null)

  useEffect(() => {
    const controller = new AbortController()
    setSrcDoc(null)
    setLoadError(null)
    setFrameLoaded(false)
    loadPluginEntry(plugin, controller.signal)
      .then(({ html, entryUrl }) => {
        if (controller.signal.aborted) return
        const baseUrl = entryUrl.substring(0, entryUrl.lastIndexOf('/') + 1)
        setSrcDoc(prepareHtml(html, baseUrl, getThemeVars()))
      })
      .catch(err => { if (!controller.signal.aborted) setLoadError(err.message) })
    return () => controller.abort()
  }, [plugin])

  useEffect(() => {
    const jogSender = createPluginJogSender()
    let disposed = false
    let streamJobId: number | null = null
    let streamGeneration = 0
    let streamStartGeneration = 0
    let streamStartPending = false
    const streamBusy = (phase: string) => ['streaming', 'paused', 'draining'].includes(phase)
    const streamSnapshot = () => {
      const sender = useGCodeSenderStore.getState()
      if (streamJobId == null || sender.jobId !== streamJobId) return null
      return {
        jobId: sender.jobId, phase: sender.phase,
        completedBlocks: sender.completedBlocks, totalBlocks: sender.totalBlocks,
        acceptedLine: sender.acceptedLine, error: sender.error,
        reset: pluginSession.read(plugin.id).generation !== streamGeneration,
      }
    }
    const publishStream = () => {
      const snapshot = streamSnapshot()
      if (!disposed && snapshot) iframeRef.current?.contentWindow?.postMessage(
        { type: 'fluid-event', event: 'program-stream', data: snapshot }, '*')
    }
    const stopStream = useGCodeSenderStore.subscribe(publishStream)
    function onMessage(e: MessageEvent) {
      if (e.source !== iframeRef.current?.contentWindow) return
      const msg = e.data as PluginRequest
      if (!msg || msg.type !== 'fluid-request') return
      const reply = (result: unknown, error?: string) =>
        iframeRef.current?.contentWindow?.postMessage(
          { type: 'fluid-response', id: msg.id, result: result ?? null, error: error ?? null }, '*')
      switch (msg.method) {
        case 'getStatus': {
          const machine = useMachineStore.getState()
          reply(machine.connected && machine.statusReceived
            ? machine.status : { ...machine.status, state: 'Unknown' })
          break
        }
        case 'getSessionState':
          reply(pluginSession.read(plugin.id)); break
        case 'getLocalState':
        case 'setLocalState': {
          // The sandboxed frame has an opaque origin. Keep browser storage
          // in the host, isolated by controller and plugin identity.
          const key = `figui.plugin-local.v1:${encodeURIComponent(getBase() || window.location.origin)}:${encodeURIComponent(plugin.id)}`
          try {
            if (msg.method === 'getLocalState') {
              const raw = localStorage.getItem(key)
              reply(raw ? JSON.parse(raw) : null)
            } else {
              localStorage.setItem(key, JSON.stringify(msg.params?.data ?? null))
              reply(null)
            }
          } catch (error) { reply(null, String(error)) }
          break
        }
        case 'setSessionState':
          try {
            pluginSession.write(plugin.id, Number(msg.params?.generation), msg.params?.data)
            reply(null)
          } catch (error) { reply(null, String(error)) }
          break
        case 'sendCommand': {
          const cmd = String(msg.params?.command ?? '')
          if (!useMachineStore.getState().connected) { reply(null, 'Not connected'); break }
          if (sendRaw(cmd)) reply(null)
          else reply(null, lineRefusalReason())
          break
        }
        case 'sendJog': {
          jogSender.send(String(msg.params?.command ?? ''))
            .then(result => reply(result)).catch(err => reply(null, String(err)))
          break
        }
        case 'endJog':
          jogSender.close().then(() => reply(null))
          break
        case 'startProgramFile':
        case 'startProgramStream': {
          if (streamStartPending || streamBusy(useGCodeSenderStore.getState().phase)) {
            reply(null, 'A G-code stream is already active')
            break
          }
          const fromSd = msg.method === 'startProgramFile'
          const text = fromSd ? msg.params?.path : msg.params?.gcode
          const rawStart = msg.params?.startPosition
          if (typeof text !== 'string' || !text.trim() || !Array.isArray(rawStart) || rawStart.length !== 6) {
            reply(null, 'Expected a program and six starting axis positions')
            break
          }
          if (fromSd && !/^\/[\w./-]+$/.test(text)) {
            reply(null, 'Invalid SD program path')
            break
          }
          const positions = rawStart.map(value => {
            const item = value as { axis?: unknown; position?: unknown; tolerance?: unknown } | null
            return {
              axis: String(item?.axis ?? '').toLowerCase(),
              position: typeof item?.position === 'number' ? item.position : NaN,
              tolerance: typeof item?.tolerance === 'number' ? item.tolerance : NaN,
            }
          })
          if (new Set(positions.map(item => item.axis)).size !== 6 || positions.some(item =>
            !/^[xyzabc]$/.test(item.axis) || !Number.isFinite(item.position) || !Number.isFinite(item.tolerance) || item.tolerance <= 0)) {
            reply(null, 'Invalid starting axis positions')
            break
          }
          const referenceGeneration = pluginSession.read(plugin.id).generation
          const ready = () => {
            const machine = useMachineStore.getState()
            return !disposed && pluginSession.read(plugin.id).generation === referenceGeneration &&
              machine.connected && machine.statusReceived && !machine.controllerResetPending &&
              machine.status.state === 'Idle' && !machine.status.sdFilename && positions.every(item => {
                const actual = machine.status.mpos[item.axis as keyof typeof machine.status.mpos]
                return typeof actual === 'number' && Number.isFinite(actual) && Math.abs(actual - item.position) <= item.tolerance
              })
          }
          const stamp = ++streamStartGeneration
          streamStartPending = true
          void (async () => {
            try {
              await jogSender.close()
              if (disposed || stamp !== streamStartGeneration) throw new Error('Stream start cancelled')
              if (!ready()) throw new Error('The machine must be Idle at the planned start position')
              if (fromSd) {
                if (!sendRaw(`$SD/Run=${text}`)) throw new Error('Controller command channel is busy')
                reply({ started: true })
                return
              }
              streamJobId = null
              streamGeneration = referenceGeneration
              const sender = useGCodeSenderStore.getState()
              if (!sender.start(text, `${plugin.id}.nc`, {
                showRuntimeEstimate: false, trackSourcePosition: false, validateStart: ready,
              })) throw new Error(useGCodeSenderStore.getState().error ?? 'The controller command channel is busy')
              streamJobId = useGCodeSenderStore.getState().jobId
              reply(streamSnapshot())
              publishStream()
            } catch (error) {
              if (!disposed) reply(null, error instanceof Error ? error.message : String(error))
            } finally {
              streamStartPending = false
            }
          })()
          break
        }
        case 'getProgramStreamState':
          reply(streamSnapshot()); break
        case 'pauseProgramStream':
        case 'resumeProgramStream':
        case 'stopProgramStream': {
          const sender = useGCodeSenderStore.getState()
          const requestedId = msg.params?.jobId
          if (requestedId != null && requestedId !== streamJobId) {
            reply(null, 'This plugin does not own that stream')
            break
          }
          if (msg.method === 'stopProgramStream') streamStartGeneration++
          if (streamJobId != null && sender.jobId === streamJobId && streamBusy(sender.phase)) {
            if (msg.method === 'pauseProgramStream') sender.pause()
            else if (msg.method === 'resumeProgramStream') sender.resume()
            else sender.abort()
          }
          reply(streamSnapshot())
          break
        }
        case 'sendRealtime': {
          const byte = Number(msg.params?.byte ?? 0)
          if (!useMachineStore.getState().connected) { reply(null, 'Not connected'); break }
          const sent = byte === 0x85 ? jogSender.cancel() : sendRealtime(byte)
          reply(null, sent ? undefined : 'Not connected')
          break
        }
        case 'sendQuery': {
          const cmd = String(msg.params?.command ?? '')
          if (!useMachineStore.getState().connected) { reply(null, 'Not connected'); break }
          sendCommand(cmd).then(result => reply(result)).catch(err => reply(null, String(err)))
          break
        }
        case 'subscribe':
          if (msg.params?.event === 'status') statusSubscribed.current = true
          if (msg.params?.event === 'line' && !lineUnsubRef.current) {
            lineUnsubRef.current = onLine(line => {
              iframeRef.current?.contentWindow?.postMessage(
                { type: 'fluid-event', event: 'line', data: line }, '*')
            })
          }
          reply(null); break
        case 'unsubscribe':
          if (msg.params?.event === 'status') statusSubscribed.current = false
          if (msg.params?.event === 'line') {
            lineUnsubRef.current?.()
            lineUnsubRef.current = null
          }
          reply(null); break
        case 'readFile': {
          const path = String(msg.params?.path ?? '')
          const fs = (msg.params?.fs as 'sd' | 'local') ?? 'local'
          fetchFileContent(path, fs, { cache: msg.params?.fresh ? 'no-store' : undefined, timeoutMs: 45000 })
            .then(text => reply(text)).catch(err => reply(null, String(err)))
          break
        }
        case 'writeFile': {
          const fullPath = String(msg.params?.path ?? '')
          const content = String(msg.params?.content ?? '')
          const fs = (msg.params?.fs as 'sd' | 'local') ?? 'local'
          const lastSlash = fullPath.lastIndexOf('/')
          const dir = lastSlash > 0 ? fullPath.slice(0, lastSlash) : '/'
          const filename = fullPath.slice(lastSlash + 1)
          saveFileContent(dir, filename, content, fs)
            .then(() => {
              reply(null)
              invalidateFileCache()
              window.dispatchEvent(new CustomEvent('files:changed'))
            })
            .catch(err => reply(null, String(err)))
          break
        }
        case 'listFiles': {
          const path = String(msg.params?.path ?? '/')
          const fs = (msg.params?.fs as 'sd' | 'local') ?? 'local'
          listDeviceFiles(path, fs).then(result => reply(result)).catch(err => reply(null, String(err)))
          break
        }
        case 'openFile': {
          const path = String(msg.params?.path ?? '')
          window.dispatchEvent(new CustomEvent('gcode:load', { detail: path }))
          reply(null)
          break
        }
        case 'close':
          reply(null)
          onClose()
          break
        case 'setCloseCommand':
          closeCommandRef.current = String(msg.params?.command ?? '').trim()
          reply(null)
          break
        case 'getDeviceInfo':
          reply(useMachineStore.getState().espInfo); break
        case 'getMachineSettings':
          reply(useMachineStore.getState().controllerSettings); break
        case 'getSettings': {
          const tryRead = async () => {
            try {
              const text = await fetchFileContent(`/plugins/${plugin.id}/settings.json`, plugin.fs, { timeoutMs: 45000, cache: 'no-store' })
              const trimmed = text.replace(/^\uFEFF/, '').trim()
              return trimmed ? JSON.parse(trimmed) : {}
            } catch (error) {
              if (error instanceof Error && error.message === 'HTTP 404') return {}
              throw error
            }
          }

          tryRead()
            .then(data => reply(data))
            .catch(err => reply(null, String(err)))
          break
        }
        case 'saveSettings': {
          const data = msg.params?.data ?? {}
          const fs = plugin.fs
          saveFileContent(`/plugins/${plugin.id}`, 'settings.json', JSON.stringify(data), fs)
            .then(() => reply(null))
            .catch(err => reply(null, String(err)))
          break
        }
        default:
          reply(null, `Unknown method: ${msg.method}`)
      }
    }
    window.addEventListener('message', onMessage)
    const stopSession = pluginSession.subscribe(() => {
      iframeRef.current?.contentWindow?.postMessage(
        { type: 'fluid-event', event: 'session', data: pluginSession.read(plugin.id) }, '*')
    })
    const stopTakeover = onSessionTaken(() => {
      streamStartGeneration++
      // Stop this plugin's control without discarding its joint calibration.
      iframeRef.current?.contentWindow?.postMessage(
        { type: 'fluid-event', event: 'control-taken' }, '*')
    })
    return () => {
      disposed = true
      streamStartGeneration++
      stopStream()
      const sender = useGCodeSenderStore.getState()
      if (streamJobId != null && sender.jobId === streamJobId && streamBusy(sender.phase)) sender.abort()
      stopSession()
      stopTakeover()
      window.removeEventListener('message', onMessage)
      jogSender.dispose()
      lineUnsubRef.current?.()
      lineUnsubRef.current = null
      if (closeCommandRef.current) sendCloseCommand(closeCommandRef.current)
      closeCommandRef.current = ''
    }
  }, [plugin.id])

  useEffect(() => {
    return useMachineStore.subscribe((state, prevState) => {
      if (!statusSubscribed.current || (state.status === prevState.status &&
        state.connected === prevState.connected && state.statusReceived === prevState.statusReceived)) return
      const status = state.connected && state.statusReceived ? state.status : { ...state.status, state: 'Unknown' }
      iframeRef.current?.contentWindow?.postMessage({ type: 'fluid-event', event: 'status', data: status }, '*')
    })
  }, [])

  useEffect(() => {
    return useMachineStore.subscribe((state, prevState) => {
      if (state.theme === prevState.theme) return
      requestAnimationFrame(() => {
        iframeRef.current?.contentWindow?.postMessage(
          { type: 'fluid-theme', vars: getThemeVars() }, '*')
      })
    })
  }, [])

  useEffect(() => {
    function onKey(e: KeyboardEvent) { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  const loadingIndicator = (
    <div className="flex h-full w-full flex-col items-center justify-center gap-3 bg-[var(--bg)] px-6 text-center">
      <RefreshCw size={28} className="animate-spin text-accent" />
      <div>
        <div className="text-base font-semibold text-text-primary">{__uiText("components.PluginFrame.loading_plugin.1", "Loading plugin…")}</div>
        <div className="mt-1 text-sm text-text-muted">{plugin.manifest.name}</div>
      </div>
    </div>
  )

  const frameContent = loadError ? (
    <div className="flex-1 flex flex-col items-center justify-center gap-3 text-center px-6">
      <span className="text-danger text-sm">{__uiText("components.PluginFrame.failed_to_load_plugin.1", "Failed to load plugin:")} {loadError}</span>
      <button className="btn btn-ghost text-sm" onClick={onClose}>{__uiText("components.PluginFrame.close.1", "Close")}</button>
    </div>
  ) : srcDoc === null ? (
    <div className="flex-1">{loadingIndicator}</div>
  ) : (
    <div className="relative flex-1 min-h-0">
      <iframe
        ref={iframeRef}
        srcDoc={srcDoc}
        sandbox="allow-scripts allow-forms allow-popups allow-downloads"
        className={`absolute inset-0 h-full w-full border-0 transition-opacity duration-200 ${frameLoaded ? 'opacity-100' : 'opacity-0'}`}
        style={interacting ? { pointerEvents: 'none' } : undefined}
        title={plugin.manifest.name}
        onLoad={() => setFrameLoaded(true)}
      />
      {!frameLoaded && <div className="absolute inset-0">{loadingIndicator}</div>}
    </div>
  )

  if (inline) {
    return (
      <div className="flex flex-col h-full w-full overflow-hidden">
        <div className="flex items-center gap-3 px-4 h-11 border-b border-border shrink-0 bg-surface">
          <Puzzle size={16} className="text-accent shrink-0" />
          <span className="font-semibold text-text-primary flex-1 truncate text-base">{plugin.manifest.name}</span>
          {plugin.manifest.version && (
            <span className="text-xs text-text-dim font-mono">v{plugin.manifest.version}</span>
          )}
          <button onClick={onClose} className="text-text-muted hover:text-text-primary transition-colors p-1" aria-label={__uiText("components.PluginFrame.close_plugin.1", "Close plugin")}>
            <X size={18} />
          </button>
        </div>
        {frameContent}
      </div>
    )
  }

  if (isMobile) {
    return (
      <div className="fixed inset-0 z-[110] flex flex-col bg-[var(--bg)]">
        <div className="flex items-center gap-3 px-4 h-11 border-b border-border shrink-0 bg-surface">
          <Puzzle size={16} className="text-accent shrink-0" />
          <span className="font-semibold text-text-primary flex-1 truncate text-base">{plugin.manifest.name}</span>
          {plugin.manifest.version && (
            <span className="text-xs text-text-dim font-mono">v{plugin.manifest.version}</span>
          )}
          <button onClick={onClose} className="text-text-muted hover:text-text-primary transition-colors p-1" aria-label={__uiText("components.PluginFrame.close_plugin.2", "Close plugin")}>
            <X size={18} />
          </button>
        </div>
        {frameContent}
      </div>
    )
  }

  return (
    <div
      className="fixed z-[110] flex flex-col bg-[var(--bg)] border border-border rounded-lg shadow-2xl overflow-hidden"
      style={{ left: pos.x, top: pos.y, width: size.w, height: size.h }}
    >
      {/* Drag handle — title bar */}
      <div
        className="flex items-center gap-3 px-4 h-11 border-b border-border shrink-0 bg-surface
                   cursor-grab active:cursor-grabbing select-none"
        style={{ touchAction: 'none' }}
        onPointerDown={e => {
          e.currentTarget.setPointerCapture(e.pointerId)
          setInteracting(true)
          dragRef.current = { ox: e.clientX - pos.x, oy: e.clientY - pos.y }
        }}
        onPointerMove={e => {
          if (!dragRef.current) return
          setPos({
            x: clamp(e.clientX - dragRef.current.ox, 0, window.innerWidth  - size.w),
            y: clamp(e.clientY - dragRef.current.oy, 0, window.innerHeight - 44),
          })
        }}
        onPointerUp={() => { dragRef.current = null; setInteracting(false) }}
      >
        <Puzzle size={16} className="text-accent shrink-0" />
        <span className="font-semibold text-text-primary flex-1 truncate text-base">{plugin.manifest.name}</span>
        {plugin.manifest.version && (
          <span className="text-xs text-text-dim font-mono">v{plugin.manifest.version}</span>
        )}
        <button
          onPointerDown={e => e.stopPropagation()}
          onClick={onClose}
          className="text-text-muted hover:text-text-primary transition-colors p-1"
          aria-label={__uiText("components.PluginFrame.close_plugin.3", "Close plugin")}
        >
          <X size={18} />
        </button>
      </div>

      {frameContent}

      {/* Resize handle — bottom-right grip */}
      <div
        className="absolute bottom-0 right-0 w-5 h-5 cursor-se-resize"
        style={{ touchAction: 'none' }}
        onPointerDown={e => {
          e.stopPropagation()
          e.currentTarget.setPointerCapture(e.pointerId)
          setInteracting(true)
          resizeRef.current = { ox: e.clientX, oy: e.clientY, ow: size.w, oh: size.h }
        }}
        onPointerMove={e => {
          if (!resizeRef.current) return
          const { ox, oy, ow, oh } = resizeRef.current
          setSize({
            w: clamp(ow + e.clientX - ox, MIN_W, window.innerWidth  - pos.x),
            h: clamp(oh + e.clientY - oy, MIN_H, window.innerHeight - pos.y),
          })
        }}
        onPointerUp={() => { resizeRef.current = null; setInteracting(false) }}
      >
        <svg
          width="10" height="10" viewBox="0 0 10 10"
          className="absolute bottom-1 right-1 text-border"
          fill="currentColor"
        >
          <rect x="6" y="0" width="2" height="2" />
          <rect x="6" y="4" width="2" height="2" />
          <rect x="2" y="4" width="2" height="2" />
          <rect x="6" y="8" width="2" height="2" />
          <rect x="2" y="8" width="2" height="2" />
          <rect x="0" y="8" width="2" height="2" />
        </svg>
      </div>
    </div>
  )
}
