import { uiText as __uiText, formatUi } from '../lib/i18n'
import { useEffect, useMemo, useRef, useState } from 'react'
import { X, Download, CheckCircle2, AlertCircle, ArrowUp, RefreshCw, Heart } from 'lucide-react'
import fluidncLogo from '../assets/fluidnc-logo.svg'
import { useMachineStore } from '../store'
import { useGCodeSenderStore } from '../store/gcodeSender'
import { uploadFile, uiDir, putUiFile } from '../lib/http'
import { CURRENT_VERSION, GITHUB_REPO, DISMISSED_VERSION_KEY, semverGt } from '../lib/updateCheck'
import { UI_LANGUAGE, LANGUAGE_NAMES, SUPPORTED_LANGUAGES, firmwareUrl, type UiLanguage } from '../lib/language'

// Pinned with a hash: this script runs with the page's access to the machine.
const MARKED_CDN_URL = 'https://cdn.jsdelivr.net/npm/marked@15.0.12/marked.min.js'
const MARKED_SRI = 'sha384-948ahk4ZmxYVYOc+rxN1H2gM1EJ2Duhp7uHtZ4WSLkV4Vtx5MUqnV+l7u9B+jFv+'
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
    script.integrity = MARKED_SRI
    script.crossOrigin = 'anonymous'
    script.async = true
    script.onload = () => resolve()
    script.onerror = () => reject(new Error(__uiText("components.AboutModal.late_coverage.1", "Failed to load markdown renderer")))
    document.head.appendChild(script)
  })

  return markedLoadPromise
}

// Writing the web UI to flash mid-job only adds load to the controller.
const UPDATE_AFTER_JOB = __uiText("components.AboutModal.job_running.1", "A job is running. Update after it has finished.")

function jobActive(state: string, sdFilename: string | undefined, senderPhase: string) {
  return state === 'Run' || state === 'Hold' || Boolean(sdFilename) ||
    senderPhase === 'streaming' || senderPhase === 'paused' || senderPhase === 'draining'
}

type UpdateState = 'idle' | 'checking' | 'up-to-date' | 'available' | 'downloading' | 'uploading' | 'done' | 'error'

interface Props {
  onClose: () => void
}

interface InstallFeedbackProps {
  state: UpdateState
  progress: number
  error: string
  languageChange?: boolean
  onDismiss: () => void
}

function InstallFeedback({ state, progress, error, languageChange, onDismiss }: InstallFeedbackProps) {
  if (state === 'checking' || state === 'downloading' || state === 'uploading') {
    const label = state === 'checking'
      ? __uiText("components.AboutModal.language_checking.1", "Checking latest version…")
      : state === 'downloading'
        ? __uiText("components.AboutModal.downloading_status.1", "Downloading…")
        : formatUi(__uiText("components.AboutModal.uploading_progress.1", "Uploading… {progress}%"), { progress })
    return (
      <div className="flex flex-col gap-2" role="status">
        <div className="flex items-center gap-2 text-[13px] text-text-muted">
          <RefreshCw size={13} className="animate-spin shrink-0" />{label}
        </div>
        {state === 'uploading' && (
          <div className="w-full bg-[var(--bg)] rounded-full h-1.5 overflow-hidden">
            <div className="h-full bg-accent rounded-full transition-all duration-200" style={{ width: `${progress}%` }} />
          </div>
        )}
      </div>
    )
  }
  if (state === 'done') return (
    <div className="flex flex-col gap-3" role="status">
      <span className="flex items-center gap-1.5 text-[13px] text-green-400">
        <CheckCircle2 size={14} />
        {languageChange
          ? __uiText("components.AboutModal.language_complete.1", "Language installed — reload to apply")
          : __uiText("components.AboutModal.update_complete_reload_to_apply.1", "Update complete — reload to apply")}
      </span>
      <button className="btn-primary self-start text-[13px] py-1.5 px-3" onClick={() => window.location.reload()}>
        {__uiText("components.AboutModal.reload_now.1", "Reload Now")}
      </button>
    </div>
  )
  if (state === 'error') return (
    <div className="flex flex-col gap-2" role="alert">
      <span className="flex items-center gap-1.5 text-[13px] text-red-400"><AlertCircle size={14} className="shrink-0" />{error}</span>
      <button className="btn btn-ghost self-start text-[13px] py-1.5 px-3" onClick={onDismiss}>
        {__uiText("components.AboutModal.dismiss.2", "Dismiss")}
      </button>
    </div>
  )
  return null
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
    title: __uiText("components.AboutModal.tip_keyboard.1", "Keyboard jogging"),
    body: (
      <>
        {__uiText("components.AboutModal.jog_instructions.1", "In the Jog panel, switch to")}{' '}<em>{__uiText("components.AboutModal.continuous.1", "Continuous")}</em>{' '}{__uiText("components.AboutModal.jog_instructions.2", "mode and click the keyboard icon to enable. Use")}{' '}
        <kbd className="kbd">←</kbd><kbd className="kbd">→</kbd><kbd className="kbd">↑</kbd><kbd className="kbd">↓</kbd>{' '}{__uiText("components.AboutModal.jog_instructions.3", "for X/Y and")}{' '}
        <kbd className="kbd">+</kbd><kbd className="kbd">−</kbd>{' '}{__uiText("components.AboutModal.jog_instructions.4", "for Z. Hold to jog, release to stop.")}
      </>
    ),
  },
  {
    title: __uiText("components.AboutModal.tip_cancel_jog.1", "Cancel a jog"),
    body: (
      <>
        {__uiText("components.AboutModal.while_the_machine_is_jogging_the_ce.1", "While the machine is jogging, the center of the jog rose turns into a stop button — click it (or release the held key) to cancel.")}
      </>
    ),
  },
  {
    title: __uiText("components.AboutModal.tip_units.1", "Units (mm ↔ in)"),
    body: (
      <>
        {__uiText("components.AboutModal.open.1", "Open")}{' '}<em>{__uiText("components.AboutModal.settings.1", "Settings")}</em>{' '}{__uiText("components.AboutModal.units_instructions.1", "and use the")}{' '}<em>{__uiText("components.AboutModal.webui_units.1", "WebUI units")}</em>{' '}{__uiText("components.AboutModal.units_instructions.2", "toggle near the top. Display only — controller communication always stays in mm.")}
      </>
    ),
  },
  {
    title: __uiText("components.AboutModal.tip_clear_alarm.1", "Clear an alarm"),
    body: (
      <>
        {__uiText("components.AboutModal.alarm_instructions.1", "When the status pill in the header shows")}{' '}<em>{__uiText("components.AboutModal.alarm.1", "Alarm")}</em>{__uiText("components.AboutModal.alarm_instructions.2", ", click it to send")}{' '}
        <code className="font-mono text-text-primary">$X</code>{' '}{__uiText("components.AboutModal.alarm_instructions.3", "and unlock.")}
      </>
    ),
  },
  {
    title: __uiText("components.AboutModal.tip_reset.1", "Soft reset"),
    body: (
      <>
        {__uiText("components.AboutModal.reset_instructions.1", "The")}{' '}<em>RST</em>{' '}{__uiText("components.AboutModal.reset_instructions.2", "button in the header sends Ctrl+X — equivalent to a soft reset of FluidNC.")}
      </>
    ),
  },
  {
    title: __uiText("components.AboutModal.tip_axis_zero.1", "Per-axis zero / home"),
    body: (
      <>
        {__uiText("components.AboutModal.in_the_dro_click_an_axis_label_to_z.1", "In the DRO, click an axis label to zero just that axis, or use the small icons next to it to go to its zero or home it individually.")}
      </>
    ),
  },
  {
    title: __uiText("components.AboutModal.tip_large_files.1", "Large files"),
    body: (
      <>
        {__uiText("components.AboutModal.on_jobs_over_100_000_segments_the_t.1", "On jobs over 100,000 segments, the toolpath completion overlay (green \"done\" trail) is automatically disabled while running. This avoids flooding FluidNC with position queries — the toolhead marker still tracks position normally, and Program Execution still follows the executing line.")}
      </>
    ),
  },
]

/** Display application details, usage tips, release notes, and self-update controls. */
export function AboutModal({ onClose }: Props) {
  const theme = useMachineStore(s => s.theme)
  const espInfo = useMachineStore(s => s.espInfo)
  const pendingUpdateVersion = useMachineStore(s => s.pendingUpdateVersion)
  const setPendingUpdateVersion = useMachineStore(s => s.setPendingUpdateVersion)
  const machineState = useMachineStore(s => s.status.state)
  const sdFilename = useMachineStore(s => s.status.sdFilename)
  const senderPhase = useGCodeSenderStore(s => s.phase)
  const updateBlocked = jobActive(machineState, sdFilename, senderPhase)

  const [updateState, setUpdateState] = useState<UpdateState>(
    () => pendingUpdateVersion ? 'available' : 'idle'
  )
  const [latestVersion, setLatestVersion] = useState(() => pendingUpdateVersion ?? '')
  const [releaseNotes, setReleaseNotes] = useState<ReleaseNote[]>([])
  const [markdownReady, setMarkdownReady] = useState(() => Boolean(window.marked))
  const [uploadProgress, setUploadProgress] = useState(0)
  const [updateError, setUpdateError] = useState('')
  const [languageState, setLanguageState] = useState<UpdateState>('idle')
  const [languageError, setLanguageError] = useState('')
  const [targetLanguage, setTargetLanguage] = useState<UiLanguage>(UI_LANGUAGE)
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
      if (!version) throw new Error(__uiText("components.AboutModal.no_stable_release.1", "No stable releases found"))
      setLatestVersion(version)
      setReleaseNotes(notes)
      setUpdateState(semverGt(version, CURRENT_VERSION) ? 'available' : 'up-to-date')
    } catch (e) {
      const msg = e instanceof TypeError
        ? __uiText("components.AboutModal.no_internet.1", "No internet connection — connect and try again")
        : e instanceof Error ? e.message : __uiText("components.AboutModal.check_failed.1", "Failed to check for updates")
      setUpdateError(msg)
      setUpdateState('error')
    }
  }

  /**
   * Download and install FigUI in its own UI directory, or the LocalFS root
   * when served outside /ui/<name>/, reporting upload progress and errors.
   * Clear the dismissed and pending update state after a successful upload.
   */
  async function performUpdate(language: UiLanguage = UI_LANGUAGE, version = latestVersion, languageChange = false) {
    const setState = languageChange ? setLanguageState : setUpdateState
    const setError = languageChange ? setLanguageError : setUpdateError
    downloadedBuffer.current = null
    try {
      setState('downloading')
      if (!version || semverGt(CURRENT_VERSION, version)) throw new Error(__uiText("components.AboutModal.older_release.1", "The selected release is older than the installed UI"))
      const dlRes = await fetch(firmwareUrl(version, language), { cache: 'no-store' })
      if (!dlRes.ok) throw new Error(formatUi(__uiText("components.AboutModal.template_coverage.1", "Download failed: {v0}"), { v0: dlRes.status }))
      downloadedBuffer.current = await dlRes.arrayBuffer()
      const bytes = new Uint8Array(downloadedBuffer.current)
      if (bytes.length < 100 || bytes[0] !== 0x1f || bytes[1] !== 0x8b) throw new Error(__uiText("components.AboutModal.invalid_download.1", "Invalid UI download"))

      // A job may have started while the file was downloading.
      const { status } = useMachineStore.getState()
      if (jobActive(status.state, status.sdFilename, useGCodeSenderStore.getState().phase)) {
        throw new Error(UPDATE_AFTER_JOB)
      }

      setState('uploading')
      setUploadProgress(0)
      const file = new File([downloadedBuffer.current], 'index.html.gz', { type: 'application/gzip' })
      // Update this copy of FigUI: under /ui/<name>/, the one in that
      // directory, not the WebUI on LocalFS
      if (uiDir) await putUiFile('index.html.gz', file, pct => setUploadProgress(pct))
      else await uploadFile('/', file, 'local', pct => setUploadProgress(pct))

      localStorage.removeItem(DISMISSED_VERSION_KEY)
      setPendingUpdateVersion(null)
      setState('done')
    } catch (e) {
      setError(e instanceof Error ? e.message : __uiText("components.AboutModal.update_failed.1", "Update failed"))
      setState('error')
    }
  }

  const busy = ['checking', 'downloading', 'uploading'].includes(updateState) ||
    ['checking', 'downloading', 'uploading'].includes(languageState)
  const installationDone = updateState === 'done' || languageState === 'done'

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
          <span>{__uiText("components.AboutModal.about.1", "About")}</span>
          <button
            className="btn-ghost px-2 py-1 ml-auto"
            onClick={onClose}
            title={__uiText("components.AboutModal.close.1", "Close")}
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
              <span>{__uiText("components.AboutModal.coverage.1", "Web UI:")} </span>
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
                {__uiText("components.AboutModal.firmware.1", "Firmware:")} {espInfo.version}
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
                  {__uiText("components.AboutModal.support_this_project.1", "Support this project")}
                </span>
                <span className="block text-[12px] text-text-muted">
                  {__uiText("components.AboutModal.donations_help_fund_new_features_an.1", "Donations help fund new features and improvements.")}
                </span>
              </span>
              <span className="ml-auto text-[12px] font-semibold text-accent">{__uiText("components.AboutModal.sponsor.1", "Sponsor ↗")}</span>
            </a>
          </div>

          {/* Update checker */}
          {!IS_DEMO && (
            <section className="px-5 py-4 border-b border-border" aria-labelledby="figui-update-heading">
              <h3 id="figui-update-heading" className="text-[11px] font-semibold uppercase tracking-[0.12em] text-text-muted mb-3">
                {__uiText("components.AboutModal.webui_update.1", "WebUI Update")}
              </h3>

              {/* idle / up-to-date / checking */}
              {(updateState === 'idle' || updateState === 'checking' || updateState === 'up-to-date') && (
                <div className="flex items-center gap-3">
                  <button
                    className="btn-primary flex items-center gap-1.5 text-[13px] py-1.5 px-3 disabled:opacity-50 disabled:cursor-not-allowed"
                    onClick={checkForUpdates}
                    disabled={busy || installationDone}
                  >
                    {updateState === 'checking'
                      ? <RefreshCw size={13} className="animate-spin" />
                      : <Download size={13} />}
                    {updateState === 'checking' ? __uiText("components.AboutModal.checking.1", "Checking…") : __uiText("components.AboutModal.check_for_updates.1", "Check for Updates")}
                  </button>
                  {updateState === 'up-to-date' && (
                    <span className="flex items-center gap-1.5 text-[13px] text-green-400">
                      <CheckCircle2 size={14} />
                      {__uiText("components.AboutModal.up_to_date.1", "Up to date")}
                    </span>
                  )}
                </div>
              )}

              {/* update available */}
              {updateState === 'available' && (
                <div className="flex flex-col gap-3">
                  <div className="flex items-center justify-between">
                    <span className="text-[13px] text-accent font-semibold">
                      v{latestVersion} {__uiText("components.AboutModal.available.1", "available")}
                    </span>
                    <span className="text-[11px] text-text-dim">
                      {__uiText("components.AboutModal.current_v.1", "current: v")}{CURRENT_VERSION}
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
                      className="btn-primary self-start flex items-center gap-1.5 text-[13px] py-1.5 px-3 disabled:opacity-50 disabled:cursor-not-allowed"
                      onClick={() => performUpdate()}
                      disabled={updateBlocked || busy || installationDone}
                      title={updateBlocked ? __uiText("components.AboutModal.update_after_the_running_job_has_fi.1", "Update after the running job has finished") : undefined}
                    >
                      <ArrowUp size={13} />
                      {__uiText("components.AboutModal.update_to_v.1", "Update to v")}{latestVersion}
                    </button>
                    <button
                      className="btn btn-ghost self-start text-[13px] py-1.5 px-3"
                      onClick={dismissUpdate}
                    >
                      {__uiText("components.AboutModal.dismiss.1", "Dismiss")}
                    </button>
                  </div>
                  {updateBlocked && (
                    <span className="text-[11px] text-text-dim">{UPDATE_AFTER_JOB}</span>
                  )}
                </div>
              )}

              {updateState !== 'checking' && (
                <InstallFeedback state={updateState} progress={uploadProgress} error={updateError} onDismiss={() => setUpdateState('idle')} />
              )}
            </section>
          )}

          {!IS_DEMO && (
            <section className="px-5 py-4 border-b border-border" aria-labelledby="figui-language-heading">
              <h3 id="figui-language-heading" className="text-[11px] font-semibold uppercase tracking-[0.12em] text-text-muted mb-3">
                {__uiText("components.AboutModal.language_section.1", "Language")}
              </h3>
              <div className="flex flex-wrap items-end gap-2">
                <label className="text-[13px] text-text-muted">
                  <span className="sr-only">Language / Idioma</span>
                  <select className="block bg-elevated text-text-primary border border-border rounded p-1.5"
                    value={targetLanguage} onChange={e => setTargetLanguage(e.currentTarget.value as UiLanguage)} disabled={busy || installationDone}>
                    {SUPPORTED_LANGUAGES.map(language => <option key={language.code} value={language.code}>{language.name}</option>)}
                  </select>
                </label>
                <button className="btn-primary text-[13px] py-1.5 px-3 disabled:opacity-50"
                  disabled={busy || installationDone || updateBlocked || targetLanguage === UI_LANGUAGE}
                  onClick={async () => {
                    setLanguageState('checking')
                    setLanguageError('')
                    try {
                      const { latestVersion: version } = await fetchReleaseHistory()
                      if (!version) throw new Error(__uiText("components.AboutModal.no_stable_release.2", "No stable releases found"))
                      await performUpdate(targetLanguage, version, true)
                    } catch (e) {
                      setLanguageError(e instanceof Error ? e.message : __uiText("components.AboutModal.check_failed.2", "Failed to check for updates"))
                      setLanguageState('error')
                    }
                  }}>
                  {__uiText("components.AboutModal.install_language.1", "Install language (latest version)")}
                </button>
              </div>
              <p className="mt-2 text-[11px] text-text-dim">{formatUi(__uiText("components.AboutModal.language_notice.1", "Installed: {language}. Translations may be incomplete. Changes apply to all users and require a reload."), { language: LANGUAGE_NAMES[UI_LANGUAGE] })}</p>
              {updateBlocked && <p className="mt-2 text-[11px] text-text-dim">{UPDATE_AFTER_JOB}</p>}
              {languageState !== 'idle' && (
                <div className="mt-3">
                  <InstallFeedback state={languageState} progress={uploadProgress} error={languageError} languageChange onDismiss={() => setLanguageState('idle')} />
                </div>
              )}
            </section>
          )}

          {/* Tips */}
          <div className="px-5 py-4">
            <h3 className="text-[11px] font-semibold uppercase tracking-[0.12em] text-text-muted mb-3">
              {__uiText("components.AboutModal.basic_usage.1", "Basic Usage")}
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
            {__uiText("components.AboutModal.coverage.2", "© 2026 Figamore & FluidNC Contributors")}
          </div>
        </div>
      </div>
    </div>
  )
}
