import { create } from 'zustand'
import {
  parseGCodeAsync,
  yieldToEventLoop,
  type GCodeModel,
  type ParseGCodeOptions,
  type WorkCoordinateSystem,
  type WorkOffset,
} from '../lib/gcode'
import { useMachineStore } from '../store'
import { getBase, sendCommand } from '../lib/http'
import { MM_PER_INCH } from '../lib/units'
import { sendRaw } from '../lib/ws'
import { controllerPathsMatch, controllerRunCommand } from '../lib/controllerFiles'
import { canLoadControllerResources } from '../lib/controllerResources'
import { cachePreparedGCode, getCachedRunningGCode } from '../lib/gcodeCache'
import {
  buildRenderLinesAsync,
  buildStatic2DPathsAsync,
  buildStatic3DGeometry,
  type Built2DPaths,
  type Built3DGeometry,
  type RenderLines,
} from '../lib/gcodeBuild'

export interface Geometry3D extends Built3DGeometry {
  showRapids: boolean
}

type TrackedJobSource = 'local' | 'controller'

interface GCodeStore {
  // Identity
  loadedPath: string | null
  fileName: string | null
  sourceText: string | null
  restoredFromCache: boolean
  restartSource: {
    path: string | null
    fileName: string
    sourceText?: string
    requestedLine: number
    resumeLine: number
  } | null
  activeSourceLine: number | null

  // Built data (shared across all GCodeViewer instances — one parse, one build)
  model: GCodeModel | null
  renderLines: RenderLines | null
  paths2D: Built2DPaths | null
  geometry3D: Geometry3D | null

  // Setting (shared so 3D rebuild only happens once on toggle)
  showRapids: boolean

  // Loading state
  loading: boolean
  pendingPath: string | null
  pendingFileName: string | null
  downloadProgress: number | null
  isProcessing2D: boolean
  processing2DProgress: number
  isProcessing3D: boolean
  processing3DProgress: number
  is3DReady: boolean
  /** SD-card path currently being uploaded for the selected preview. */
  sdUploadPath: string | null

  // Job completion feedback
  trackedJob: { source: TrackedJobSource; startedAt: number } | null
  finishedJobElapsedMs: number | null

  // Actions
  loadFile: (path: string) => Promise<void>
  loadFromText: (
    text: string,
    name: string,
    path?: string | null,
    restartSource?: GCodeStore['restartSource'],
  ) => Promise<void>
  restoreRunningFile: (path: string) => Promise<void>
  cancelAndStartJob: (path: string) => boolean
  startTrackedJob: (source: TrackedJobSource) => void
  finishTrackedJob: (source: TrackedJobSource) => void
  cancelTrackedJob: (source?: TrackedJobSource) => void
  dismissFinishedJobNotice: () => void
  setShowRapids: (v: boolean) => void
  setActiveSourceLine: (line: number | null) => void
  beginSdUpload: (path: string) => void
  completeSdUpload: (path: string) => Promise<void>
  failSdUpload: (path: string) => void
  clear: () => void
}


let loadedParseOptions: ParseGCodeOptions = {}
let activeLoadPath: string | null = null
let loadRequestId = 0
let abortController: AbortController | null = null
let activeReader: ReadableStreamDefaultReader<Uint8Array> | null = null

const WORK_COORDINATE_SYSTEMS = new Set<WorkCoordinateSystem>([
  'G54', 'G55', 'G56', 'G57', 'G58', 'G59', 'G59.1', 'G59.2', 'G59.3',
])

function isLoadBlockedByMachineState() {
  const machine = useMachineStore.getState()
  const state = machine.status.state
  return machine.connected && (!!machine.status.sdFilename || !machine.statusReceived || state === 'Run' || state === 'Hold' || state === 'Door')
}

function abortInFlight() {
  ++loadRequestId
  if (activeReader) {
    activeReader.cancel().catch(() => {})
    activeReader = null
  }
  if (abortController) {
    abortController.abort()
    abortController = null
  }
  activeLoadPath = null
}

function normalizeWcs(value: string | undefined): WorkCoordinateSystem | undefined {
  if (!value) return undefined
  const upper = value.toUpperCase()
  return WORK_COORDINATE_SYSTEMS.has(upper as WorkCoordinateSystem)
    ? upper as WorkCoordinateSystem
    : undefined
}

function parseWorkOffsetResponse(
  text: string,
  linearScale = 1,
): Partial<Record<WorkCoordinateSystem, WorkOffset>> {
  const offsets: Partial<Record<WorkCoordinateSystem, WorkOffset>> = {}
  const numberPattern = '(-?(?:\\d+\\.?\\d*|\\.\\d+))'
  const offsetPattern = new RegExp(`^\\[(G5[4-9](?:\\.[1-3])?):${numberPattern},${numberPattern},${numberPattern}(?:,[^\\]]*)?\\]$`)
  for (const raw of text.split('\n')) {
    const match = raw.trim().match(offsetPattern)
    const wcs = normalizeWcs(match?.[1])
    if (!match || !wcs) continue
    offsets[wcs] = {
      x: Number.parseFloat(match[2]) * linearScale,
      y: Number.parseFloat(match[3]) * linearScale,
      z: Number.parseFloat(match[4]) * linearScale,
    }
  }
  return offsets
}

async function getParseOptions(): Promise<ParseGCodeOptions> {
  const machine = useMachineStore.getState()
  const activeWcs = normalizeWcs(machine.status.gcodeModes?.wcs)
  const currentWco = machine.status.wco
  const workOffsets: Partial<Record<WorkCoordinateSystem, WorkOffset>> = {}

  if (activeWcs) {
    workOffsets[activeWcs] = currentWco
  }

  if (canLoadControllerResources(machine)) {
    try {
      const linearScale = machine.controllerSettings.reportInches ? MM_PER_INCH : 1
      Object.assign(workOffsets, parseWorkOffsetResponse(await sendCommand('$#'), linearScale))
      if (activeWcs) {
        workOffsets[activeWcs] = currentWco
      }
    } catch (e) {
      console.warn('Failed to fetch work offsets for G-code preview:', e)
    }
  }

  return { activeWcs, currentWco, workOffsets }
}

/**
 * Parses and prepares the 2D preview in short time slices, so multi-million
 * line laser jobs do not freeze the page. Progress runs from 5 to 100.
 */
async function buildPreview(
  text: string,
  onProgress: (progress: number) => void,
  shouldContinue: () => boolean,
  savedOptions?: ParseGCodeOptions,
) {
  const parseOptions = savedOptions ?? await getParseOptions()
  if (!shouldContinue()) throw new Error('stale-load')

  let lastProgress = -1
  const report = (progress: number) => {
    const rounded = Math.round(progress)
    if (rounded !== lastProgress) {
      lastProgress = rounded
      onProgress(rounded)
    }
  }

  const model = await parseGCodeAsync(text, parseOptions, fraction => report(5 + fraction * 55), shouldContinue)
  const renderLines = await buildRenderLinesAsync(model.segments, progress => report(60 + progress * 0.2), shouldContinue)
  const paths2D = await buildStatic2DPathsAsync(renderLines, progress => report(80 + progress * 0.2), shouldContinue)
  return { model, renderLines, paths2D, parseOptions }
}

async function loadTextPreview(
  text: string,
  name: string,
  path: string | null,
  restartSource: GCodeStore['restartSource'],
  savedOptions?: ParseGCodeOptions,
  canContinue = () => true,
) {
  const { setState: set, getState: get } = useGCodeStore
  const controller = getBase()
  set({ finishedJobElapsedMs: null })
  abortInFlight()
  const requestId = ++loadRequestId
  const current = () => requestId === loadRequestId && canContinue()

  set({
    loading: true,
    restoredFromCache: savedOptions !== undefined,
    pendingPath: null,
    pendingFileName: name,
    downloadProgress: 100,
    isProcessing2D: true,
    processing2DProgress: 5,
    isProcessing3D: false,
    processing3DProgress: 0,
    is3DReady: false,
    geometry3D: null,
    paths2D: null,
    activeSourceLine: null,
  })

  try {
    await yieldToEventLoop()
    const preview = await buildPreview(
      text,
      progress => {
        if (current()) set({ processing2DProgress: progress })
      },
      current,
      savedOptions,
    )
    if (!current()) return

    if (path && !savedOptions && !restartSource && get().sdUploadPath !== path) {
      await cachePreparedGCode(controller, { path, fileName: name, text, parseOptions: preview.parseOptions })
      if (!current()) return
    }
    loadedParseOptions = preview.parseOptions
    set({
      restoredFromCache: savedOptions !== undefined,
      model: preview.model,
      renderLines: preview.renderLines,
      paths2D: preview.paths2D,
      fileName: name,
      loadedPath: path,
      sourceText: text,
      restartSource,
      processing2DProgress: 100,
      isProcessing2D: false,
      loading: false,
      pendingPath: null,
      pendingFileName: null,
      isProcessing3D: true,
      processing3DProgress: 0,
    })

    await yieldToEventLoop()
    if (!current()) return
    const showRapids = get().showRapids
    const built3DGeometry = buildStatic3DGeometry(preview.renderLines, showRapids)

    set({
      geometry3D: { ...built3DGeometry, showRapids },
      processing3DProgress: 100,
      isProcessing3D: false,
      is3DReady: true,
    })
  } catch (e) {
    if (requestId === loadRequestId && (!(e instanceof Error) || e.message !== 'stale-load')) {
      console.error('Failed to load G-code from text:', e)
    }
  } finally {
    if (requestId === loadRequestId) {
      set({
        loading: false,
        pendingPath: null,
        pendingFileName: null,
        isProcessing2D: false,
        isProcessing3D: false,
        is3DReady: get().geometry3D !== null,
      })
    }
  }
}

export const useGCodeStore = create<GCodeStore>((set, get) => ({
  loadedPath: null,
  fileName: null,
  sourceText: null,
  restoredFromCache: false,
  restartSource: null,
  activeSourceLine: null,
  model: null,
  renderLines: null,
  paths2D: null,
  geometry3D: null,
  showRapids: true,
  loading: false,
  pendingPath: null,
  pendingFileName: null,
  downloadProgress: null,
  isProcessing2D: false,
  processing2DProgress: 0,
  isProcessing3D: false,
  processing3DProgress: 0,
  is3DReady: false,
  sdUploadPath: null,
  trackedJob: null,
  finishedJobElapsedMs: null,

  loadFile: async (path: string) => {
    if (isLoadBlockedByMachineState()) return
    if (activeLoadPath === path) return

    set({ finishedJobElapsedMs: null })
    abortInFlight()
    activeLoadPath = path
    const controller = getBase()
    const requestId = ++loadRequestId

    set({
      loading: true,
      pendingPath: path,
      pendingFileName: path.split('/').pop() ?? path,
      downloadProgress: 0,
      isProcessing2D: false,
      processing2DProgress: 0,
      isProcessing3D: false,
      processing3DProgress: 0,
      is3DReady: false,
      geometry3D: null,
      paths2D: null,
      activeSourceLine: null,
    })

    try {
      const url = `${controller}${path}`
      abortController = new AbortController()
      const res = await fetch(url, { signal: abortController.signal, cache: 'no-store' })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)

      const contentLength = Number(res.headers.get('content-length') ?? '0')
      let text = ''

      if (res.body) {
        const reader = res.body.getReader()
        activeReader = reader
        const decoder = new TextDecoder()
        const chunks: string[] = []
        let received = 0
        let lastProgress = -1

        while (true) {
          const { done, value } = await reader.read()
          if (requestId !== loadRequestId) { reader.cancel().catch(() => {}); return }
          if (done) break
          if (!value) continue

          received += value.byteLength
          chunks.push(decoder.decode(value, { stream: true }))

          if (contentLength > 0) {
            const progress = Math.min(100, Math.round((received / contentLength) * 100))
            if (progress !== lastProgress) {
              lastProgress = progress
              set({ downloadProgress: progress })
            }
          }
        }

        chunks.push(decoder.decode())
        text = chunks.join('')
        activeReader = null
      } else {
        text = await res.text()
      }

      if (requestId !== loadRequestId) return
      set({ downloadProgress: 100, isProcessing2D: true, processing2DProgress: 5 })
      await yieldToEventLoop()

      const preview = await buildPreview(
        text,
        progress => {
          if (requestId === loadRequestId) set({ processing2DProgress: progress })
        },
        () => requestId === loadRequestId,
      )
      if (requestId !== loadRequestId) return

      const fileName = path.split('/').pop() ?? path
      await cachePreparedGCode(controller, { path, fileName, text, parseOptions: preview.parseOptions })
      if (requestId !== loadRequestId) return
      loadedParseOptions = preview.parseOptions
      set({
        restoredFromCache: false,
        model: preview.model,
        renderLines: preview.renderLines,
        paths2D: preview.paths2D,
        fileName,
        loadedPath: path,
        sourceText: text,
        restartSource: null,
        processing2DProgress: 100,
        isProcessing2D: false,
        loading: false,
        pendingPath: null,
        pendingFileName: null,
        isProcessing3D: true,
        processing3DProgress: 0,
      })

      await yieldToEventLoop()
      if (requestId !== loadRequestId) return
      const showRapids = get().showRapids
      const built3DGeometry = buildStatic3DGeometry(preview.renderLines, showRapids)

      set({
        geometry3D: { ...built3DGeometry, showRapids },
        processing3DProgress: 100,
        isProcessing3D: false,
        is3DReady: true,
      })
    } catch (e) {
      if (requestId === loadRequestId && (!(e instanceof Error) || e.message !== 'stale-load')) {
        if (!(e instanceof DOMException && e.name === 'AbortError')) {
          console.error('Failed to load G-code:', e)
        }
      }
    } finally {
      if (requestId === loadRequestId) {
        activeLoadPath = null
        abortController = null
        activeReader = null
        set({
          loading: false,
          pendingPath: null,
          pendingFileName: null,
          isProcessing2D: false,
          isProcessing3D: false,
          is3DReady: get().geometry3D !== null,
        })
      }
    }
  },

  loadFromText: async (text, name, path = null, restartSource = null) => {
    if (isLoadBlockedByMachineState()) return
    await loadTextPreview(text, name, path, restartSource)
  },

  restoreRunningFile: async path => {
    const controller = getBase()
    const requestId = loadRequestId
    const stillRunning = () => {
      const machine = useMachineStore.getState()
      return machine.connected && machine.statusReceived && machine.status.sdFilename === path && getBase() === controller
    }
    if (!stillRunning() || get().loading) return
    // Start without preview deliberately leaves only the path in this session.
    // A fresh page has no such marker and can still restore the saved copy.
    const loadedPath = get().loadedPath
    if (loadedPath && controllerPathsMatch(path, loadedPath) && get().sourceText === null) return
    const file = await getCachedRunningGCode(controller, path)
    if (!file || !stillRunning() || requestId !== loadRequestId || get().loading) return
    if (get().model && get().sourceText === file.text && get().loadedPath === file.path) return
    await loadTextPreview(file.text, file.fileName, file.path, null, file.parseOptions, stillRunning)
  },

  cancelAndStartJob: (path: string) => {
    if (isLoadBlockedByMachineState()) return false
    // Stop any in-flight download immediately. The ESP32 must not be serving a
    set({ finishedJobElapsedMs: null })
    abortInFlight()
    set({
      loading: false,
      pendingPath: null,
      pendingFileName: null,
      isProcessing2D: false,
      isProcessing3D: false,
      downloadProgress: null,
      // Mark this path as loaded so controller-job tracking doesn't
      // re-fetch it. The user explicitly chose to skip the preview.
      loadedPath: path,
      fileName: path.split('/').pop() ?? path,
      sourceText: null,
      restoredFromCache: false,
      restartSource: null,
      activeSourceLine: null,
      // Drop any partial built data — they're stale now.
      model: null,
      renderLines: null,
      paths2D: null,
      geometry3D: null,
      is3DReady: false,
    })
    return sendRaw(controllerRunCommand(path))
  },

  startTrackedJob: source => {
    const path = get().loadedPath
    if (source === 'controller' && path) void getCachedRunningGCode(getBase(), path)
    set({
      trackedJob: { source, startedAt: Date.now() },
      finishedJobElapsedMs: null,
    })
  },

  finishTrackedJob: source => {
    const trackedJob = get().trackedJob
    if (!trackedJob || trackedJob.source !== source) return
    set({
      trackedJob: null,
      finishedJobElapsedMs: Math.max(0, Date.now() - trackedJob.startedAt),
    })
  },

  cancelTrackedJob: source => {
    const trackedJob = get().trackedJob
    if (source && trackedJob?.source !== source) return
    set({ trackedJob: null })
  },

  dismissFinishedJobNotice: () => set({ finishedJobElapsedMs: null }),

  setShowRapids: (v: boolean) => {
    if (get().showRapids === v) return
    set({ showRapids: v })

    const renderLines = get().renderLines
    if (!get().model || !renderLines) return

    // 2D rendering filters at draw time, so only the 3D geometry needs
    // rebuilding. The joined render lines make this fast enough to do inline.
    set({
      geometry3D: { ...buildStatic3DGeometry(renderLines, v), showRapids: v },
      processing3DProgress: 100,
      isProcessing3D: false,
      is3DReady: true,
    })
  },

  setActiveSourceLine: (line: number | null) => {
    if (get().activeSourceLine === line) return
    set({ activeSourceLine: line })
  },

  beginSdUpload: path => set({ sdUploadPath: path }),

  completeSdUpload: async path => {
    const file = get()
    if (file.sdUploadPath !== path) return
    if (file.loadedPath === path && file.sourceText !== null && file.model) {
      await cachePreparedGCode(getBase(), { path, fileName: file.fileName!, text: file.sourceText, parseOptions: loadedParseOptions })
    }
    if (get().sdUploadPath === path) set({ sdUploadPath: null })
  },

  failSdUpload: path => {
    // Do not leave a preview pointing at an SD file that did not finish
    // uploading. A newer preview may have replaced it while the request ran.
    if (get().sdUploadPath !== path) return
    if (get().loadedPath === path) {
      abortInFlight()
      set({
        loadedPath: null,
        fileName: null,
        sourceText: null,
        restoredFromCache: false,
        restartSource: null,
        activeSourceLine: null,
        model: null,
        renderLines: null,
        paths2D: null,
        geometry3D: null,
        loading: false,
        pendingPath: null,
        pendingFileName: null,
        downloadProgress: null,
        isProcessing2D: false,
        processing2DProgress: 0,
        isProcessing3D: false,
        processing3DProgress: 0,
        is3DReady: false,
        sdUploadPath: null,
      })
      return
    }
    set({ sdUploadPath: null })
  },

  clear: () => {
    abortInFlight()
    set({
      loadedPath: null,
      fileName: null,
      sourceText: null,
      restoredFromCache: false,
      restartSource: null,
      activeSourceLine: null,
      model: null,
      renderLines: null,
      paths2D: null,
      geometry3D: null,
      loading: false,
      pendingPath: null,
      pendingFileName: null,
      downloadProgress: null,
      isProcessing2D: false,
      processing2DProgress: 0,
      isProcessing3D: false,
      processing3DProgress: 0,
      is3DReady: false,
      sdUploadPath: null,
    })
  },
}))
