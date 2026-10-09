import { useCallback, useEffect, useRef, useState } from 'react'
import { Puzzle, RefreshCw, Upload, Store, HardDrive, Server, Trash2, Download, AlertCircle, X, CheckCircle, Search } from 'lucide-react'
import { discoverPlugins, uploadFolderPlugin, deletePlugin, fetchRegistry, installStorePlugin, PLUGIN_SD_REQUIRED_MESSAGE } from '../lib/plugins'
import { PluginFrame } from './PluginFrame'
import type { Plugin, StoreEntry, ActiveLayout } from '../types'
import { getEffectiveLayout } from '../types'
import { semverGt } from '../lib/updateCheck'
import { canLoadControllerResources, useControllerResourcesReady } from '../lib/controllerResources'
import { useMachineStore } from '../store'

type Tab = 'installed' | 'store'

let pluginsCache: Plugin[] | null = null

interface ProgressState {
  current: number
  total: number
  filename: string
  label: string
}

function installErrorMessage(err: any, fallback: string): string {
  const message = err?.message ?? fallback
  return message === 'No SD card' ? PLUGIN_SD_REQUIRED_MESSAGE : message
}

function PluginIcon({ src, size = 22 }: { src?: string; size?: number }) {
  const [error, setError] = useState(false)
  if (!src || error) return <Puzzle size={size} className="text-accent" />
  return <img src={src} alt="" className="w-10 h-10 object-contain" onError={() => setError(true)} />
}

function FsBadge({ fs }: { fs: 'sd' | 'local' }) {
  return (
    <span className={`inline-flex items-center gap-0.5 px-1.5 py-0.5 rounded text-sm font-medium border ${
      fs === 'sd'
        ? 'bg-info/10 border-info/30 text-info'
        : 'bg-elevated border-border text-text-dim'
    }`}>
      {fs === 'sd' ? <HardDrive size={8} /> : <Server size={8} />}
      {fs === 'sd' ? 'SD' : 'Internal'}
    </span>
  )
}

export function PluginLauncher({ isTablet, onLaunchPanel, activeLayout }: { isTablet?: boolean; onLaunchPanel?: (plugin: Plugin) => void; activeLayout?: ActiveLayout }) {
  const resourcesReady = useControllerResourcesReady()
  const [tab, setTab] = useState<Tab>('installed')
  const [plugins, setPlugins] = useState<Plugin[]>(pluginsCache ?? [])
  const [scanning, setScanning] = useState(false)
  const scanGeneration = useRef(0)
  const [activePlugin, setActivePlugin] = useState<Plugin | null>(null)
  const [query, setQuery] = useState('')

  // Upload folder state
  const folderInputRef = useRef<HTMLInputElement>(null)
  useEffect(() => {
    folderInputRef.current?.setAttribute('webkitdirectory', '')
  }, [])
  const [progress, setProgress] = useState<ProgressState | null>(null)
  const [uploadDone, setUploadDone] = useState(false)

  // Confirm delete
  const [confirmDelete, setConfirmDelete] = useState<Plugin | null>(null)
  const [deleting, setDeleting] = useState(false)

  // Store
  const [storeEntries, setStoreEntries] = useState<StoreEntry[] | null>(null)
  const [storeLoading, setStoreLoading] = useState(false)
  const [storeError, setStoreError] = useState<string | null>(null)
  const [installingId, setInstallingId] = useState<string | null>(null)
  const [justInstalled, setJustInstalled] = useState<string | null>(null)
  const [updatingId, setUpdatingId] = useState<string | null>(null)

  const scan = useCallback(async (silent = false) => {
    const generation = ++scanGeneration.current
    if (!canLoadControllerResources(useMachineStore.getState())) {
      setScanning(false)
      return
    }
    if (!silent) setScanning(true)
    try {
      const found = await discoverPlugins()
      if (generation !== scanGeneration.current || !canLoadControllerResources(useMachineStore.getState())) return
      pluginsCache = found
      setPlugins(found)
    } finally {
      if (generation === scanGeneration.current) setScanning(false)
    }
  }, [])

  useEffect(() => {
    if (resourcesReady) scan(pluginsCache !== null)
    else setScanning(false)
    return () => { scanGeneration.current++ }
  }, [scan, resourcesReady])

  const loadStore = useCallback(async () => {
    if (storeEntries !== null) return
    setStoreLoading(true)
    setStoreError(null)
    try {
      setStoreEntries(await fetchRegistry())
    } catch (e: any) {
      setStoreError(e.message ?? 'Failed to load store')
    } finally {
      setStoreLoading(false)
    }
  }, [storeEntries])

  useEffect(() => {
    if (tab === 'store') loadStore()
  }, [tab, loadStore])

  function handleAddFromFolder() {
    folderInputRef.current?.click()
  }

  async function handleFolderSelect(e: React.ChangeEvent<HTMLInputElement>) {
    const files = e.target.files
    if (!files || files.length === 0) return
    setUploadDone(false)
    setProgress({ current: 0, total: files.length, filename: '', label: 'Preparing…' })
    try {
      await uploadFolderPlugin(files, 'sd', (current, total, filename) => {
        setProgress({ current, total, filename, label: 'Uploading' })
      })
      setUploadDone(true)
      setProgress(null)
      await scan()
      setTab('installed')
    } catch (err: any) {
      alert(installErrorMessage(err, 'Upload failed'))
      setProgress(null)
    } finally {
      e.target.value = ''
    }
  }

  async function handleDelete(plugin: Plugin) {
    setDeleting(true)
    try {
      await deletePlugin(plugin)
      await scan()
    } catch {}
    setDeleting(false)
    setConfirmDelete(null)
  }

  async function handleInstall(entry: StoreEntry) {
    setInstallingId(entry.id)
    setUploadDone(false)
    setProgress({ current: 0, total: 1, filename: '', label: 'Installing' })
    try {
      await installStorePlugin(entry, 'sd', (current, total, filename) => {
        setProgress({ current, total, filename, label: 'Installing' })
      })
      setJustInstalled(entry.id)
      setProgress(null)
      await scan()
      setTimeout(() => setJustInstalled(null), 3000)
    } catch (err: any) {
      alert(installErrorMessage(err, 'Install failed'))
      setProgress(null)
    } finally {
      setInstallingId(null)
    }
  }

  async function handleUpdate(entry: StoreEntry, plugin: Plugin) {
    setUpdatingId(entry.id)
    setUploadDone(false)
    setProgress({ current: 0, total: 1, filename: '', label: 'Updating' })
    try {
      await installStorePlugin(entry, plugin.fs, (current, total, filename) => {
        setProgress({ current, total, filename, label: 'Updating' })
      }, { cleanExisting: true })
      setJustInstalled(entry.id)
      setProgress(null)
      await scan()
      setTimeout(() => setJustInstalled(null), 3000)
    } catch (err: any) {
      alert(installErrorMessage(err, 'Update failed'))
      setProgress(null)
    } finally {
      setUpdatingId(null)
    }
  }

  const installedPluginFor = (entry: StoreEntry) =>
    plugins.find(p => p.id === entry.id)

  const hasStoreUpdate = (entry: StoreEntry, plugin?: Plugin) =>
    Boolean(entry.version && plugin?.manifest.version && semverGt(entry.version, plugin.manifest.version))

  const q = query.trim().toLowerCase()
  const filteredPlugins = q
    ? plugins.filter(p => p.manifest.name.toLowerCase().includes(q) || p.manifest.description?.toLowerCase().includes(q))
    : plugins
  const filteredStore = q
    ? (storeEntries ?? []).filter(e => e.name.toLowerCase().includes(q) || e.description?.toLowerCase().includes(q))
    : (storeEntries ?? [])

  const pad = isTablet ? 'p-5' : 'p-4'

  return (
    <>
      <div className="flex flex-col h-full overflow-hidden">

        {/* Header */}
        <div className={`flex items-center gap-2 ${pad} pb-3 border-b border-border shrink-0`}>
          <span className="text-base text-text-muted uppercase tracking-wide font-medium flex-1">Plugins</span>
          <button
            onClick={handleAddFromFolder}
            className="btn btn-ghost text-base py-1 px-2 gap-1.5 shrink-0"
            title="Install from folder"
          >
            <Upload size={12} />
            Add
          </button>
          <button
            onClick={() => scan()}
            disabled={scanning}
            className="text-text-muted hover:text-accent transition-colors disabled:opacity-40 shrink-0"
            aria-label="Refresh"
          >
            <RefreshCw size={14} className={scanning ? 'animate-spin' : ''} />
          </button>
        </div>

        {/* Tabs */}
        <div className="flex border-b border-border shrink-0">
          {(['installed', 'store'] as const).map(t => (
            <button
              key={t}
              onClick={() => setTab(t)}
              className={`flex-1 flex items-center justify-center gap-1.5 py-2 text-sm font-semibold
                          uppercase tracking-wide transition-colors border-b-2 -mb-px ${
                tab === t
                  ? 'border-accent text-accent'
                  : 'border-transparent text-text-muted hover:text-text-primary'
              }`}
            >
              {t === 'installed' ? <Puzzle size={11} /> : <Store size={11} />}
              {t === 'installed' ? 'Installed' : 'Store'}
              {t === 'installed' && plugins.length > 0 && (
                <span className="ml-0.5 bg-elevated border border-border rounded-full text-sm px-1.5 py-px text-text-dim">
                  {plugins.length}
                </span>
              )}
            </button>
          ))}
        </div>

        {/* Search */}
        <div className="px-3 py-2 border-b border-border shrink-0">
          <div className="relative">
            <Search size={12} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-text-dim pointer-events-none" />
            <input
              type="text"
              value={query}
              onChange={e => setQuery(e.target.value)}
              placeholder="Search plugins…"
              className="w-full bg-elevated border border-border rounded pl-7 pr-7 py-1.5 text-sm text-text-primary placeholder:text-text-dim focus:outline-none focus:border-accent"
            />
            {query && (
              <button
                onClick={() => setQuery('')}
                className="absolute right-2 top-1/2 -translate-y-1/2 text-text-dim hover:text-text-primary"
              >
                <X size={12} />
              </button>
            )}
          </div>
        </div>

        {/* Content */}
        <div className="flex-1 overflow-y-auto min-h-0">

          {/* Progress overlay */}
          {progress && (
            <div className="flex flex-col items-center justify-center gap-3 h-full text-center px-6">
              <RefreshCw size={22} className="text-accent animate-spin" />
              <p className="text-base font-medium text-text-primary">{progress.label}…</p>
              <p className="text-sm text-text-muted font-mono">{progress.filename}</p>
              <div className="w-48 h-1 bg-elevated rounded-full overflow-hidden">
                <div
                  className="h-full bg-accent rounded-full transition-all duration-300"
                  style={{ width: progress.total > 0 ? `${(progress.current / progress.total) * 100}%` : '0%' }}
                />
              </div>
              <p className="text-sm text-text-dim">{progress.current} / {progress.total} files</p>
            </div>
          )}

          {/* Upload success flash */}
          {!progress && uploadDone && (
            <div className="m-4 p-3 rounded border border-ok/30 bg-ok/10 flex items-center gap-2">
              <CheckCircle size={14} className="text-ok shrink-0" />
              <p className="text-base text-ok flex-1">Plugin installed successfully</p>
              <button onClick={() => setUploadDone(false)} className="text-ok/60 hover:text-ok shrink-0">
                <X size={12} />
              </button>
            </div>
          )}

          {/* Installed tab */}
          {!progress && tab === 'installed' && (
            !resourcesReady && pluginsCache === null ? (
              <div className="p-4 text-text-muted text-sm">Plugins will load when the controller is idle.</div>
            ) : scanning ? (
              <div className="flex-1 flex items-center justify-center py-16">
                <RefreshCw size={22} className="text-text-muted animate-spin" />
              </div>
            ) : filteredPlugins.length === 0 ? (
              <div className="flex flex-col items-center justify-center gap-3 text-center px-6 py-12">
                <Puzzle size={32} className="text-text-dim" />
                <p className="text-base font-medium text-text-muted">
                  {q ? 'No plugins match your search' : 'No plugins installed'}
                </p>
                {!q && (
                  <p className="text-sm text-text-dim leading-relaxed">
                    Click <strong className="text-text-muted">Add</strong> to install from a folder, or visit the <strong className="text-text-muted">Store</strong> tab.
                  </p>
                )}
              </div>
            ) : (
              <div className={`flex flex-col gap-3 ${pad}`}>
                {filteredPlugins.map(plugin => (
                  <div key={`${plugin.id}:${plugin.fs}`} className="panel flex flex-col gap-2 p-3">
                    <div className="flex items-center gap-3">
                      <button
                        onClick={() => getEffectiveLayout(plugin.manifest, activeLayout ?? 'desktop') !== 'default' && onLaunchPanel ? onLaunchPanel(plugin) : setActivePlugin(plugin)}
                        className="shrink-0 w-12 h-12 flex items-center justify-center overflow-hidden
                                   hover:opacity-80 transition-opacity"
                        title={`Launch ${plugin.manifest.name}`}
                      >
                        <PluginIcon src={plugin.manifest.icon} />
                      </button>
                      <button
                        onClick={() => getEffectiveLayout(plugin.manifest, activeLayout ?? 'desktop') !== 'default' && onLaunchPanel ? onLaunchPanel(plugin) : setActivePlugin(plugin)}
                        className="flex-1 min-w-0 text-left hover:opacity-80 transition-opacity"
                      >
                        <p className="font-medium text-text-primary text-base truncate">
                          {plugin.manifest.name}
                        </p>
                        <div className="flex items-center gap-2 mt-0.5">
                          {plugin.manifest.version && (
                            <span className="text-sm text-text-dim font-mono shrink-0">
                              v{plugin.manifest.version}
                            </span>
                          )}
                          <FsBadge fs={plugin.fs} />
                        </div>
                      </button>
                      <button
                        onClick={() => setConfirmDelete(plugin)}
                        className="shrink-0 w-7 h-7 flex items-center justify-center rounded text-text-muted
                                   hover:text-danger hover:bg-danger/10 transition-colors border border-transparent
                                   hover:border-danger/30"
                        title="Uninstall plugin"
                      >
                        <Trash2 size={12} />
                      </button>
                    </div>
                    {plugin.manifest.description && (
                      <p className="text-sm text-text-muted">
                        {plugin.manifest.description}
                      </p>
                    )}
                  </div>
                ))}
              </div>
            )
          )}

          {/* Store tab */}
          {!progress && tab === 'store' && (
            storeLoading ? (
              <div className="flex flex-col items-center justify-center gap-2 py-16">
                <RefreshCw size={22} className="text-text-muted animate-spin" />
                <p className="text-sm text-text-dim">Loading store…</p>
              </div>
            ) : storeError ? (
              <div className="flex flex-col items-center justify-center gap-3 text-center px-6 py-12">
                <AlertCircle size={28} className="text-danger" />
                <p className="text-base font-medium text-text-muted">Could not load store</p>
                <p className="text-sm text-text-dim break-words">{storeError}</p>
                <button
                  className="btn btn-ghost text-sm px-3 py-1.5 mt-1"
                  onClick={() => { setStoreEntries(null); setStoreError(null); loadStore() }}
                >
                  Retry
                </button>
              </div>
            ) : filteredStore.length === 0 ? (
              <div className="flex flex-col items-center justify-center gap-3 text-center px-6 py-12">
                <Store size={28} className="text-text-dim" />
                <p className="text-base text-text-muted">
                  {q ? 'No plugins match your search' : 'No plugins in the store yet'}
                </p>
              </div>
            ) : (
              <div className={`flex flex-col gap-3 ${pad}`}>
                {filteredStore.map(entry => {
                  const installedPlugin = installedPluginFor(entry)
                  const installed = Boolean(installedPlugin)
                  const updateAvailable = hasStoreUpdate(entry, installedPlugin)
                  const installing = installingId === entry.id
                  const updating = updatingId === entry.id
                  const done = justInstalled === entry.id
                  return (
                    <div key={entry.id} className="panel flex flex-col gap-2 p-3">
                      <div className="flex items-center gap-3">
                        <div className="shrink-0 w-12 h-12 flex items-center justify-center overflow-hidden">
                          <PluginIcon src={entry.base + 'icon.png'} />
                        </div>
                        <div className="flex-1 min-w-0">
                          <p className="font-medium text-text-primary text-base truncate" title={entry.name}>
                            {entry.name}
                          </p>
                          <div className="flex items-center gap-2 mt-0.5 min-w-0">
                            {entry.version && (
                              <span className="text-sm text-text-dim font-mono shrink-0">
                                v{entry.version}
                              </span>
                            )}
                            {entry.author && (
                              <span className="text-sm text-text-dim truncate min-w-0" title={`by ${entry.author}`}>
                                by {entry.author}
                              </span>
                            )}
                          </div>
                        </div>
                      </div>
                      {entry.description && (
                        <p className="text-sm text-text-muted">{entry.description}</p>
                      )}
                      <div>
                        {done ? (
                          <span className="flex items-center gap-1 text-sm text-ok font-medium">
                            <CheckCircle size={12} /> Done
                          </span>
                        ) : updateAvailable && installedPlugin ? (
                          <button
                            onClick={() => handleUpdate(entry, installedPlugin)}
                            disabled={!!installingId || !!updatingId}
                            className="btn btn-warn text-sm px-2.5 py-1.5 gap-1.5 disabled:opacity-40"
                            title={`Update ${entry.name} from v${installedPlugin.manifest.version} to v${entry.version}`}
                          >
                            {updating
                              ? <><RefreshCw size={11} className="animate-spin" /> Updating…</>
                              : <><Download size={11} /> Update to v{entry.version}</>}
                          </button>
                        ) : installed ? (
                          <span className="inline-flex items-center gap-1 text-sm text-text-dim px-2 py-1.5 rounded border border-border">
                            <CheckCircle size={11} /> Installed
                          </span>
                        ) : (
                          <button
                            onClick={() => handleInstall(entry)}
                            disabled={!!installingId}
                            className="btn btn-ghost text-sm px-2.5 py-1.5 gap-1.5 disabled:opacity-40"
                            title={`Install ${entry.name}`}
                          >
                            {installing
                              ? <><RefreshCw size={11} className="animate-spin" /> Installing…</>
                              : <><Download size={11} /> Install</>}
                          </button>
                        )}
                      </div>
                    </div>
                  )
                })}
              </div>
            )
          )}
        </div>
      </div>

      {/* Hidden folder input */}
      <input
        ref={folderInputRef}
        type="file"
        multiple
        className="hidden"
        onChange={handleFolderSelect}
      />

      {/* Delete confirm dialog */}
      {confirmDelete && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50" onClick={() => setConfirmDelete(null)}>
          <div
            className="bg-surface border border-border rounded shadow-xl w-72 p-4 animate-in space-y-3"
            onClick={e => e.stopPropagation()}
          >
            <p className="text-base font-semibold text-text-primary">Uninstall plugin?</p>
            <p className="text-sm text-text-muted">
              This will delete <strong>{confirmDelete.manifest.name}</strong> from{' '}
              {confirmDelete.fs === 'sd' ? 'SD Card' : 'Internal'} storage.
            </p>
            <div className="flex justify-end gap-2 pt-1">
              <button className="btn btn-ghost text-base py-1.5 px-3" onClick={() => setConfirmDelete(null)}>
                Cancel
              </button>
              <button
                className="btn btn-danger text-base py-1.5 px-3"
                disabled={deleting}
                onClick={() => handleDelete(confirmDelete)}
              >
                {deleting ? <RefreshCw size={11} className="animate-spin" /> : <Trash2 size={11} />}
                Uninstall
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Active plugin frame */}
      {activePlugin && (
        <PluginFrame plugin={activePlugin} onClose={() => setActivePlugin(null)} />
      )}
    </>
  )
}
