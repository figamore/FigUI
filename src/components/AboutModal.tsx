import { useEffect, useMemo, useRef, useState } from 'react'
import { X, Download, CheckCircle2, AlertCircle, ArrowUp, RefreshCw, Heart } from 'lucide-react'
import fluidncLogo from '../assets/fluidnc-logo.svg'
import { useMachineStore } from '../store'
import { uploadFile } from '../lib/http'
import { CURRENT_VERSION, GITHUB_REPO, DISMISSED_VERSION_KEY, semverGt } from '../lib/updateCheck'

const FIRMWARE_URL = 'https://figamore.github.io/FigUI/firmware/index.html.gz'
const MARKED_CDN_URL = 'https://cdn.jsdelivr.net/npm/marked/marked.min.js'
const IS_DEMO = Boolean(import.meta.env.VITE_DEMO_MODE)

type MarkedParser = {
  parse?: (markdown: string) => string
}

declare global {
  interface Window {
    marked?: MarkedParser | ((markdown: string) => string)
  }
}

let markedLoadPromise: Promise<void> | null = null

function loadMarkedFromCdn(): Promise<void> {
  if (window.marked) return Promise.resolve()
  if (markedLoadPromise) return markedLoadPromise

  markedLoadPromise = new Promise((resolve, reject) => {
    const script = document.createElement('script')
    script.src = MARKED_CDN_URL
    script.async = true
    script.onload = () => resolve()
    script.onerror = () => reject(new Error('Failed to load markdown renderer'))
    document.head.appendChild(script)
  })

  return markedLoadPromise
}

type UpdateState = 'idle' | 'checking' | 'up-to-date' | 'available' | 'downloading' | 'uploading' | 'done' | 'error'

interface Props {
  onClose: () => void
}

interface Tip {
  title: string
  body: React.ReactNode
}

interface GithubRelease {
  tag_name?: string
  name?: string
  body?: string
  draft?: boolean
  prerelease?: boolean
}

interface ReleaseNote {
  version: string
  body: string
}

function normalizeVersion(tag: string): string {
  return tag.trim().replace(/^v/i, '')
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

function sanitizeMarkdownHtml(html: string): string {
  const doc = new DOMParser().parseFromString(html, 'text/html')
  const allowedTags = new Set([
    'a', 'blockquote', 'br', 'code', 'del', 'em', 'h1', 'h2', 'h3', 'h4',
    'h5', 'h6', 'hr', 'li', 'ol', 'p', 'pre', 'strong', 'table', 'tbody',
    'td', 'th', 'thead', 'tr', 'ul',
  ])

  for (const element of Array.from(doc.body.querySelectorAll('*'))) {
    const tag = element.tagName.toLowerCase()
    if (!allowedTags.has(tag)) {
      element.replaceWith(...Array.from(element.childNodes))
      continue
    }

    for (const attribute of Array.from(element.attributes)) {
      const name = attribute.name.toLowerCase()
      const keepHref = tag === 'a' && name === 'href'
      const keepTitle = name === 'title'
      const keepCodeClass = tag === 'code' && name === 'class' && /^language-[\w-]+$/.test(attribute.value)
      if (!keepHref && !keepTitle && !keepCodeClass) element.removeAttribute(attribute.name)
    }

    if (tag === 'a') {
      const href = element.getAttribute('href') ?? ''
      if (!/^(https?:|mailto:|#)/i.test(href)) element.removeAttribute('href')
      element.setAttribute('target', '_blank')
      element.setAttribute('rel', 'noopener noreferrer')
    }
  }

  return doc.body.innerHTML
}

function renderMarkdown(markdown: string): string {
  const marked = window.marked
  try {
    const html = typeof marked === 'function'
      ? marked(markdown)
      : marked?.parse?.(markdown)
    if (typeof html === 'string') return sanitizeMarkdownHtml(html)
  } catch {
    // The escaped fallback below keeps release notes readable if parsing fails.
  }
  return `<pre>${escapeHtml(markdown)}</pre>`
}

async function fetchReleaseHistory(): Promise<{ latestVersion: string; notes: ReleaseNote[] }> {
  const releases: GithubRelease[] = []

  for (let page = 1; ; page++) {
    const response = await fetch(
      `https://api.github.com/repos/${GITHUB_REPO}/releases?per_page=100&page=${page}`,
      { headers: { Accept: 'application/vnd.github+json' } },
    )
    if (!response.ok) throw new Error(`GitHub API returned ${response.status}`)

    const pageReleases = await response.json() as GithubRelease[]
    releases.push(...pageReleases)

    const reachedCurrentVersion = pageReleases.some(release => {
      if (release.draft || release.prerelease) return false
      const version = normalizeVersion(release.tag_name ?? release.name ?? '')
      return version !== '' && !semverGt(version, CURRENT_VERSION)
    })
    if (reachedCurrentVersion || pageReleases.length < 100) break
  }

  const stableReleases = releases.filter(release => !release.draft && !release.prerelease)
  const latestVersion = normalizeVersion(stableReleases[0]?.tag_name ?? stableReleases[0]?.name ?? '')
  const notes = stableReleases
    .map(release => ({
      version: normalizeVersion(release.tag_name ?? release.name ?? ''),
      body: release.body?.trim() || 'No release notes.',
    }))
    .filter(release => release.version && semverGt(release.version, CURRENT_VERSION))

  return { latestVersion, notes }
}

function MarkdownReleaseNotes({ markdown, rendererReady }: { markdown: string; rendererReady: boolean }) {
  const html = useMemo(() => renderMarkdown(markdown), [markdown, rendererReady])
  return (
    <div
      className="release-notes-markdown"
      dangerouslySetInnerHTML={{ __html: html }}
    />
  )
}

const TIPS: Tip[] = [
  {
    title: 'Keyboard jogging',
    body: (
      <>
        In the Jog panel, switch to <em>Continuous</em> mode and click the keyboard
        icon to enable. Use <kbd className="kbd">←</kbd><kbd className="kbd">→</kbd>
        <kbd className="kbd">↑</kbd><kbd className="kbd">↓</kbd> for X/Y and{' '}
        <kbd className="kbd">+</kbd><kbd className="kbd">−</kbd> for Z. Hold to jog,
        release to stop.
      </>
    ),
  },
  {
    title: 'Cancel a jog',
    body: (
      <>
        While the machine is jogging, the center of the jog rose turns into a stop
        button — click it (or release the held key) to cancel.
      </>
    ),
  },
  {
    title: 'Units (mm ↔ in)',
    body: (
      <>
        Open <em>Settings</em> and use the <em>WebUI units</em> toggle near the top.
        Display only — controller communication always stays in mm.
      </>
    ),
  },
  {
    title: 'Clear an alarm',
    body: (
      <>
        When the status pill in the header shows <em>Alarm</em>, click it to send{' '}
        <code className="font-mono text-text-primary">$X</code> and unlock.
      </>
    ),
  },
  {
    title: 'Soft reset',
    body: (
      <>
        The <em>RST</em> button in the header sends Ctrl+X — equivalent to a soft
        reset of FluidNC.
      </>
    ),
  },
  {
    title: 'Per-axis zero / home',
    body: (
      <>
        In the DRO, click an axis label to zero just that axis, or use the small
        icons next to it to go to its zero or home it individually.
      </>
    ),
  },
  {
    title: 'Large files',
    body: (
      <>
        On jobs over 100,000 segments, the toolpath completion overlay (green
        "done" trail) is automatically disabled while running. This avoids
        flooding FluidNC with position queries — the toolhead marker still
        tracks position normally, and Program Execution still follows the
        executing line.
      </>
    ),
  },
]

export function AboutModal({ onClose }: Props) {
  const theme = useMachineStore(s => s.theme)
  const espInfo = useMachineStore(s => s.espInfo)
  const pendingUpdateVersion = useMachineStore(s => s.pendingUpdateVersion)
  const setPendingUpdateVersion = useMachineStore(s => s.setPendingUpdateVersion)

  const [updateState, setUpdateState] = useState<UpdateState>(
    () => pendingUpdateVersion ? 'available' : 'idle'
  )
  const [latestVersion, setLatestVersion] = useState(() => pendingUpdateVersion ?? '')
  const [releaseNotes, setReleaseNotes] = useState<ReleaseNote[]>([])
  const [markdownReady, setMarkdownReady] = useState(() => Boolean(window.marked))
  const [uploadProgress, setUploadProgress] = useState(0)
  const [updateError, setUpdateError] = useState('')
  const downloadedBuffer = useRef<ArrayBuffer | null>(null)

  function dismissUpdate() {
    if (latestVersion) localStorage.setItem(DISMISSED_VERSION_KEY, latestVersion)
    setPendingUpdateVersion(null)
    setUpdateState('idle')
  }

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  useEffect(() => {
    if (!pendingUpdateVersion || releaseNotes.length > 0) return

    let cancelled = false
    fetchReleaseHistory()
      .then(({ latestVersion: version, notes }) => {
        if (cancelled || !version) return
        setLatestVersion(version)
        setReleaseNotes(notes)
      })
      .catch(() => {})

    return () => { cancelled = true }
  }, [pendingUpdateVersion, releaseNotes.length])

  useEffect(() => {
    if (releaseNotes.length === 0 || markdownReady) return

    let cancelled = false
    loadMarkedFromCdn()
      .then(() => {
        if (!cancelled) setMarkdownReady(true)
      })
      .catch(() => {})

    return () => { cancelled = true }
  }, [markdownReady, releaseNotes.length])

  async function checkForUpdates() {
    setUpdateState('checking')
    setUpdateError('')
    try {
      const { latestVersion: version, notes } = await fetchReleaseHistory()
      if (!version) throw new Error('No stable releases found')
      setLatestVersion(version)
      setReleaseNotes(notes)
      setUpdateState(semverGt(version, CURRENT_VERSION) ? 'available' : 'up-to-date')
    } catch (e) {
      const msg = e instanceof TypeError
        ? 'No internet connection — connect and try again'
        : e instanceof Error ? e.message : 'Failed to check for updates'
      setUpdateError(msg)
      setUpdateState('error')
    }
  }

  async function performUpdate() {
    downloadedBuffer.current = null
    try {
      setUpdateState('downloading')
      const dlRes = await fetch(FIRMWARE_URL)
      if (!dlRes.ok) throw new Error(`Download failed: ${dlRes.status}`)
      downloadedBuffer.current = await dlRes.arrayBuffer()

      setUpdateState('uploading')
      setUploadProgress(0)
      const file = new File([downloadedBuffer.current], 'index.html.gz', { type: 'application/gzip' })
      await uploadFile('/', file, 'local', pct => setUploadProgress(pct))

      localStorage.removeItem(DISMISSED_VERSION_KEY)
      setPendingUpdateVersion(null)
      setUpdateState('done')
    } catch (e) {
      setUpdateError(e instanceof Error ? e.message : 'Update failed')
      setUpdateState('error')
    }
  }

  const busy = updateState === 'downloading' || updateState === 'uploading'

  function statusLabel() {
    if (updateState === 'downloading') return 'Downloading…'
    if (updateState === 'uploading') return `Uploading… ${uploadProgress}%`
    return null
  }

  return (
    <div
      className="fixed inset-0 z-[100] flex items-end sm:items-center justify-center sm:p-4"
      onClick={e => { if (e.target === e.currentTarget) onClose() }}
    >
      <div className="absolute inset-0 bg-black/50 backdrop-blur-sm" />
      <div className="relative w-full sm:max-w-lg
                      max-h-[92dvh] sm:max-h-[85vh]
                      bg-surface border-t sm:border border-border
                      rounded-t-2xl sm:rounded-lg
                      shadow-2xl flex flex-col overflow-hidden animate-in">

        <div className="panel-header shrink-0">
          <span>About</span>
          <button
            className="btn-ghost px-2 py-1 ml-auto"
            onClick={onClose}
            title="Close"
          >
            <X size={14} />
          </button>
        </div>

        <div className="flex-1 overflow-y-auto">
          {/* Brand */}
          <div className="flex flex-col items-center gap-2 px-5 pt-6 pb-5 border-b border-border">
            <img
              src={fluidncLogo}
              alt="FluidNC"
              className="h-10 w-auto"
              style={theme !== 'light' ? { filter: 'invert(1) hue-rotate(180deg)' } : undefined}
            />
            <div className="text-[12px] text-text-muted">
              <span>Web UI: </span>
              <a
                href={`https://github.com/${GITHUB_REPO}`}
                target="_blank"
                rel="noopener noreferrer"
                className="text-accent underline hover:brightness-125"
              >
                FigUI v{CURRENT_VERSION}
              </a>
            </div>
            {espInfo?.version && (
              <div className="text-[12px] text-text-muted font-mono">
                Firmware: {espInfo.version}
              </div>
            )}
          </div>

          {/* Project support */}
          <div className="px-5 py-4 border-b border-border">
            <a
              href="https://github.com/sponsors/figamore"
              target="_blank"
              rel="noopener noreferrer"
              className="group flex items-center gap-3 rounded-lg border border-accent/30 bg-accent/10 px-3.5 py-3 transition-colors hover:bg-accent/20"
            >
              <span className="flex size-8 shrink-0 items-center justify-center rounded-full bg-accent/15 text-accent group-hover:scale-110 transition-transform">
                <Heart size={16} fill="currentColor" />
              </span>
              <span className="min-w-0">
                <span className="block text-[13px] font-semibold text-text-primary">
                  Support this project
                </span>
                <span className="block text-[12px] text-text-muted">
                  Donations help fund new features and improvements.
                </span>
              </span>
              <span className="ml-auto text-[12px] font-semibold text-accent">Sponsor ↗</span>
            </a>
          </div>

          {/* Update checker */}
          {!IS_DEMO && (
            <div className="px-5 py-4 border-b border-border">
              <h3 className="text-[11px] font-semibold uppercase tracking-[0.12em] text-text-muted mb-3">
                WebUI Update
              </h3>

              {/* idle / up-to-date / checking */}
              {(updateState === 'idle' || updateState === 'checking' || updateState === 'up-to-date') && (
                <div className="flex items-center gap-3">
                  <button
                    className="btn-primary flex items-center gap-1.5 text-[13px] py-1.5 px-3 disabled:opacity-50 disabled:cursor-not-allowed"
                    onClick={checkForUpdates}
                    disabled={updateState === 'checking'}
                  >
                    {updateState === 'checking'
                      ? <RefreshCw size={13} className="animate-spin" />
                      : <Download size={13} />}
                    {updateState === 'checking' ? 'Checking…' : 'Check for Updates'}
                  </button>
                  {updateState === 'up-to-date' && (
                    <span className="flex items-center gap-1.5 text-[13px] text-green-400">
                      <CheckCircle2 size={14} />
                      Up to date
                    </span>
                  )}
                </div>
              )}

              {/* update available */}
              {updateState === 'available' && (
                <div className="flex flex-col gap-3">
                  <div className="flex items-center justify-between">
                    <span className="text-[13px] text-accent font-semibold">
                      v{latestVersion} available
                    </span>
                    <span className="text-[11px] text-text-dim">
                      current: v{CURRENT_VERSION}
                    </span>
                  </div>
                  {releaseNotes.length > 0 && (
                    <div className="bg-[var(--bg)] border border-border rounded p-3 max-h-64 overflow-y-auto">
                      {releaseNotes.map(release => (
                        <section
                          key={release.version}
                          className="release-notes-section"
                        >
                          <div className="release-notes-version">
                            v{release.version}
                          </div>
                          <MarkdownReleaseNotes
                            markdown={release.body}
                            rendererReady={markdownReady}
                          />
                        </section>
                      ))}
                    </div>
                  )}
                  <div className="flex items-center gap-2">
                    <button
                      className="btn-primary self-start flex items-center gap-1.5 text-[13px] py-1.5 px-3"
                      onClick={performUpdate}
                    >
                      <ArrowUp size={13} />
                      Update to v{latestVersion}
                    </button>
                    <button
                      className="btn-default self-start text-[13px] py-1.5 px-3"
                      onClick={dismissUpdate}
                    >
                      Dismiss
                    </button>
                  </div>
                </div>
              )}

              {/* in-progress */}
              {busy && (
                <div className="flex flex-col gap-2">
                  <div className="flex items-center gap-2 text-[13px] text-text-muted">
                    <RefreshCw size={13} className="animate-spin shrink-0" />
                    {statusLabel()}
                  </div>
                  {updateState === 'uploading' && (
                    <div className="w-full bg-[var(--bg)] rounded-full h-1.5 overflow-hidden">
                      <div
                        className="h-full bg-accent rounded-full transition-all duration-200"
                        style={{ width: `${uploadProgress}%` }}
                      />
                    </div>
                  )}
                </div>
              )}

              {/* done */}
              {updateState === 'done' && (
                <div className="flex flex-col gap-3">
                  <span className="flex items-center gap-1.5 text-[13px] text-green-400">
                    <CheckCircle2 size={14} />
                    Update complete — reload to apply
                  </span>
                  <button
                    className="btn-primary self-start text-[13px] py-1.5 px-3"
                    onClick={() => window.location.reload()}
                  >
                    Reload Now
                  </button>
                </div>
              )}

              {/* error */}
              {updateState === 'error' && (
                <div className="flex flex-col gap-2">
                  <span className="flex items-center gap-1.5 text-[13px] text-red-400">
                    <AlertCircle size={14} className="shrink-0" />
                    {updateError}
                  </span>
                  <button
                    className="btn-default self-start text-[13px] py-1.5 px-3"
                    onClick={() => setUpdateState('idle')}
                  >
                    Dismiss
                  </button>
                </div>
              )}
            </div>
          )}

          {/* Tips */}
          <div className="px-5 py-4">
            <h3 className="text-[11px] font-semibold uppercase tracking-[0.12em] text-text-muted mb-3">
              Basic Usage
            </h3>
            <dl className="space-y-3">
              {TIPS.map(tip => (
                <div key={tip.title}>
                  <dt className="text-[13px] font-semibold text-accent">
                    {tip.title}
                  </dt>
                  <dd className="text-[13px] text-text-primary leading-relaxed mt-0.5">
                    {tip.body}
                  </dd>
                </div>
              ))}
            </dl>
          </div>

          {/* Footer */}
          <div className="px-5 py-3 border-t border-border text-center text-[11px] text-text-dim">
            © 2026 Figamore &amp; FluidNC Contributors
          </div>
        </div>
      </div>
    </div>
  )
}
