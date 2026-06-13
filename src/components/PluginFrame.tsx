import { useEffect, useRef, useState } from 'react'
import { Puzzle, X, RefreshCw } from 'lucide-react'
import { useMachineStore } from '../store'
import { sendCommand, listFiles as listDeviceFiles, fetchFileContent, saveFileContent } from '../lib/http'
import { invalidateFileCache } from './FileManager'
import { sendRaw, sendRealtime, onLine } from '../lib/ws'
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
  return vars
}

function prepareHtml(html: string, baseUrl: string, themeVars: Record<string, string>): string {
  const baseTag = /<base\s/i.test(html) ? '' : `<base href="${baseUrl}">`
  const themeScript = `<script>(function(){var v=${JSON.stringify(themeVars)},r=document.documentElement;for(var k in v)r.style.setProperty(k,v[k]);window.addEventListener('message',function(e){if(e.data&&e.data.type==='fluid-theme')for(var k in e.data.vars)r.style.setProperty(k,e.data.vars[k]);});})()</script>`
  const injection = baseTag + themeScript
  return /<head[^>]*>/i.test(html)
    ? html.replace(/(<head[^>]*>)/i, `$1${injection}`)
    : injection + html
}

export function PluginFrame({ plugin, onClose, inline }: { plugin: Plugin; onClose: () => void; inline?: boolean }) {
  const iframeRef = useRef<HTMLIFrameElement>(null)
  const statusSubscribed = useRef(false)
  const lineUnsubRef = useRef<(() => void) | null>(null)
  const [srcDoc, setSrcDoc] = useState<string | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)

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
    setSrcDoc(null)
    setLoadError(null)
    const baseUrl = plugin.entryUrl.substring(0, plugin.entryUrl.lastIndexOf('/') + 1)
    fetch(plugin.entryUrl)
      .then(r => { if (!r.ok) throw new Error(`HTTP ${r.status}`); return r.text() })
      .then(html => setSrcDoc(prepareHtml(html, baseUrl, getThemeVars())))
      .catch(err => setLoadError(err.message))
  }, [plugin.entryUrl])

  useEffect(() => {
    function onMessage(e: MessageEvent) {
      if (e.source !== iframeRef.current?.contentWindow) return
      const msg = e.data as PluginRequest
      if (!msg || msg.type !== 'fluid-request') return
      const reply = (result: unknown, error?: string) =>
        iframeRef.current?.contentWindow?.postMessage(
          { type: 'fluid-response', id: msg.id, result: result ?? null, error: error ?? null }, '*')
      switch (msg.method) {
        case 'getStatus':
          reply(useMachineStore.getState().status); break
        case 'sendCommand': {
          const cmd = String(msg.params?.command ?? '')
          if (!useMachineStore.getState().connected) { reply(null, 'Not connected'); break }
          sendRaw(cmd)
          reply(null)
          break
        }
        case 'sendRealtime': {
          const byte = Number(msg.params?.byte ?? 0)
          if (!useMachineStore.getState().connected) { reply(null, 'Not connected'); break }
          sendRealtime(byte)
          reply(null)
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
          fetchFileContent(path, fs).then(text => reply(text)).catch(err => reply(null, String(err)))
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
        case 'getDeviceInfo':
          reply(useMachineStore.getState().espInfo); break
        case 'getMachineSettings':
          reply(useMachineStore.getState().controllerSettings); break
        case 'getSettings': {
          const fs = plugin.fs
          const paths = fs === 'sd'
            ? [`/sd/plugins/${plugin.id}/settings.json`, `/plugins/${plugin.id}/settings.json`]
            : [`/plugins/${plugin.id}/settings.json`]

          const tryRead = async () => {
            for (const path of paths) {
              try {
                const text = await fetchFileContent(path, fs)
                const trimmed = text.replace(/^\uFEFF/, '').trim()
                if (!trimmed) return {}
                return JSON.parse(trimmed)
              } catch {
                // Try next path variant.
              }
            }
            return {}
          }

          tryRead()
            .then(data => reply(data))
            .catch(() => reply({}))
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
    return () => {
      window.removeEventListener('message', onMessage)
      lineUnsubRef.current?.()
      lineUnsubRef.current = null
    }
  }, [plugin.id])

  useEffect(() => {
    return useMachineStore.subscribe((state, prevState) => {
      if (state.status === prevState.status || !statusSubscribed.current) return
      iframeRef.current?.contentWindow?.postMessage(
        { type: 'fluid-event', event: 'status', data: state.status }, '*')
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

  const frameContent = loadError ? (
    <div className="flex-1 flex flex-col items-center justify-center gap-3 text-center px-6">
      <span className="text-danger text-sm">Failed to load plugin: {loadError}</span>
      <button className="btn btn-ghost text-sm" onClick={onClose}>Close</button>
    </div>
  ) : srcDoc === null ? (
    <div className="flex-1 flex items-center justify-center">
      <RefreshCw size={22} className="text-text-muted animate-spin" />
    </div>
  ) : (
    <iframe
      ref={iframeRef}
      srcDoc={srcDoc}
      sandbox="allow-scripts allow-forms allow-popups"
      className="flex-1 w-full border-0"
      style={interacting ? { pointerEvents: 'none' } : undefined}
      title={plugin.manifest.name}
    />
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
          <button onClick={onClose} className="text-text-muted hover:text-text-primary transition-colors p-1" aria-label="Close plugin">
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
          <button onClick={onClose} className="text-text-muted hover:text-text-primary transition-colors p-1" aria-label="Close plugin">
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
          aria-label="Close plugin"
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
