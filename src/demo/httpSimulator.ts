import { listDir, diskStats, getFile, setFile, deleteEntry, renameEntry } from './fileSystem'

const ESP800 = [
  'FW version:FluidNC v4.0.0-sim',
  'FW target:grbl-embedded',
  'FW HW:Direct SD',
  'primary sd:/sd/',
  'secondary sd:/ext/',
  'authentication:no',
  'webcommunication:Sync:8081:demo.sim',
  'hostname:fluidnc-sim',
  'axis:3',
].join('#')

const ESP400 = JSON.stringify({ EEPROM: [
  { F:'nvs', P:'WiFi/Mode',               H:'WiFi/Mode',               T:'B', V:'1',        M:'0', S:'0',      O:[{OFF:0},{STA:1},{AP:2}] },
  { F:'nvs', P:'Hostname',                H:'Hostname',                T:'S', V:'fluidnc-sim', M:'0', S:'32' },
  { F:'nvs', P:'HTTP/Enable',             H:'HTTP/Enable',             T:'B', V:'1',        M:'0', S:'0',      O:[{Disabled:0},{Enabled:1}] },
  { F:'nvs', P:'Grbl/Resolution/X',       H:'Grbl/Resolution/X',       T:'R', V:'200.000',  M:'0', S:'100000' },
  { F:'nvs', P:'Grbl/Resolution/Y',       H:'Grbl/Resolution/Y',       T:'R', V:'200.000',  M:'0', S:'100000' },
  { F:'nvs', P:'Grbl/Resolution/Z',       H:'Grbl/Resolution/Z',       T:'R', V:'400.000',  M:'0', S:'100000' },
  { F:'nvs', P:'Grbl/MaxRate/X',          H:'Grbl/MaxRate/X',          T:'R', V:'5000.000', M:'0', S:'100000' },
  { F:'nvs', P:'Grbl/MaxRate/Y',          H:'Grbl/MaxRate/Y',          T:'R', V:'5000.000', M:'0', S:'100000' },
  { F:'nvs', P:'Grbl/MaxRate/Z',          H:'Grbl/MaxRate/Z',          T:'R', V:'1500.000', M:'0', S:'100000' },
  { F:'nvs', P:'Grbl/Acceleration/X',     H:'Grbl/Acceleration/X',     T:'R', V:'200.000',  M:'0', S:'100000' },
  { F:'nvs', P:'Grbl/Acceleration/Y',     H:'Grbl/Acceleration/Y',     T:'R', V:'200.000',  M:'0', S:'100000' },
  { F:'nvs', P:'Grbl/Acceleration/Z',     H:'Grbl/Acceleration/Z',     T:'R', V:'80.000',   M:'0', S:'100000' },
  { F:'nvs', P:'Grbl/MaxTravel/X',        H:'Grbl/MaxTravel/X',        T:'R', V:'300.000',  M:'0', S:'100000' },
  { F:'nvs', P:'Grbl/MaxTravel/Y',        H:'Grbl/MaxTravel/Y',        T:'R', V:'300.000',  M:'0', S:'100000' },
  { F:'nvs', P:'Grbl/MaxTravel/Z',        H:'Grbl/MaxTravel/Z',        T:'R', V:'100.000',  M:'0', S:'100000' },
  { F:'nvs', P:'Grbl/MaxSpindleSpeed',    H:'Grbl/MaxSpindleSpeed',    T:'R', V:'24000.000',M:'0', S:'100000' },
  { F:'nvs', P:'Grbl/HomingCycleEnable',  H:'Grbl/HomingCycleEnable',  T:'B', V:'1',        M:'0', S:'0',      O:[{Disabled:0},{Enabled:1}] },
  { F:'nvs', P:'Grbl/HardLimitsEnable',   H:'Grbl/HardLimitsEnable',   T:'B', V:'0',        M:'0', S:'0',      O:[{Disabled:0},{Enabled:1}] },
  { F:'nvs', P:'Grbl/SoftLimitsEnable',   H:'Grbl/SoftLimitsEnable',   T:'B', V:'0',        M:'0', S:'0',      O:[{Disabled:0},{Enabled:1}] },
]})

function ok(body: string, type = 'text/plain'): Response {
  return new Response(body, { status: 200, headers: { 'Content-Type': type } })
}

function fileListResponse(dirPrefix: string, path: string): Response {
  const entries = listDir(dirPrefix + (path === '/' ? '' : path))
  const stats = diskStats()
  return ok(JSON.stringify({
    files: entries.map(e => ({
      name: e.name, shortname: e.name,
      size: e.isDir ? -1 : e.size,
      isDir: e.isDir, datetime: '',
    })),
    path,
    total:      stats.total,
    used:       stats.used,
    occupation: stats.occupation,
    status:     'Ok',
  }), 'application/json')
}

function handleCommand(params: URLSearchParams): Response {
  const plain = params.get('cmd') ?? params.get('plain') ?? ''
  if (plain === '[ESP800]') return ok(ESP800)
  if (plain === '[ESP800]json=yes') return ok(JSON.stringify({ data: {
    FWVersion: 'FluidNC v4.0.0-sim', WebCommunication: 'Synchronous',
    WebSocketPort: '8081', WebSocketIP: 'demo.sim', HostName: 'fluidnc-sim',
    Authentication: 'Disabled', Axisletters: 'XYZ',
  } }), 'application/json')
  if (plain === '[ESP400]') return ok(ESP400, 'application/json')
  return ok('ok')
}

function handleFsAction(
  method: string,
  params: URLSearchParams,
  body: FormData | null,
  fsPrefix: string,
): Response {
  const action = params.get('action') ?? ''
  const path   = params.get('path') ?? '/'
  const fname  = params.get('filename') ?? ''
  const nname  = params.get('newname')  ?? ''

  if (method === 'POST' && body) {
    // Store uploaded files in memory
    body.forEach((val, key) => {
      if (key === 'myfile[]' && val instanceof File) {
        val.text().then(content => setFile(fsPrefix + path + '/' + val.name, content))
      }
    })
    return fileListResponse(fsPrefix, path)
  }

  if (action === 'delete')    deleteEntry(fsPrefix + path + (fname ? '/' + fname : ''))
  if (action === 'deletedir') deleteEntry(fsPrefix + path + (fname ? '/' + fname : ''))
  if (action === 'createdir') setFile(fsPrefix + path + '/' + fname + '/.keep', '')
  if (action === 'rename' && fname && nname)
    renameEntry(fsPrefix + path + '/' + fname, fsPrefix + path + '/' + nname)

  return fileListResponse(fsPrefix, path)
}

function handleFileDownload(pathname: string): Response {
  const fsPath = pathname.startsWith('/sd/')
    ? pathname
    : '/localfs/' + pathname.split('/').slice(2).join('/')
  const content = getFile(fsPath)
  return content !== null ? ok(content) : new Response('Not found', { status: 404 })
}

export function installFetchInterceptor(): void {
  const orig = window.fetch.bind(window)

  window.fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const href = typeof input === 'string' ? input
      : input instanceof URL ? input.href
      : (input as Request).url
    const url = new URL(href, window.location.href)
    const p   = url.pathname
    const m   = (init?.method ?? 'GET').toUpperCase()

    if (p === '/command' || p === '/command_silent') return handleCommand(url.searchParams)

    if (p === '/upload') {
      const fd = m === 'POST' && init?.body instanceof FormData ? init.body : null
      return handleFsAction(m, url.searchParams, fd, '/sd')
    }

    if (p === '/files') {
      const fd = m === 'POST' && init?.body instanceof FormData ? init.body : null
      return handleFsAction(m, url.searchParams, fd, '/localfs')
    }

    if (p.startsWith('/sd/') || p.startsWith('/localfs/') || p.startsWith('/ext/'))
      return handleFileDownload(p)

    const localFile = url.origin === window.location.origin ? getFile('/localfs' + p) : null
    if (m === 'GET' && localFile !== null) return ok(localFile)

    return orig(input, init)
  }
}

// XHR intercept for uploadFile() which uses XMLHttpRequest for progress tracking
export function installXhrInterceptor(): void {
  const Orig = window.XMLHttpRequest

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ;(window as any).XMLHttpRequest = function InterceptedXHR() {
    const real = new Orig()
    let intercept = false
    let storedOnload: ((e: ProgressEvent) => void) | null = null
    const fakeUpload = { onprogress: null as ((e: ProgressEvent) => void) | null }

    return new Proxy(real, {
      get(target, prop) {
        if (intercept && prop === 'status')     return 200
        if (intercept && prop === 'readyState') return 4
        if (intercept && prop === 'upload')     return fakeUpload

        if (prop === 'open') return (method: string, url: string | URL, ...rest: unknown[]) => {
          const path = new URL(String(url), location.href).pathname
          intercept = path === '/upload' || path === '/files'
          if (!intercept)
            real.open.call(real, method, url, ...(rest as [boolean, string?, string?]))
        }

        if (prop === 'send') return (body?: unknown) => {
          if (intercept) {
            // Simulate instant upload success
            const fd = body instanceof FormData ? body : null
            if (fd) {
              fd.forEach((val, key) => {
                if (key === 'myfile[]' && val instanceof File) {
                  const path = (fd.get('path') as string) ?? '/'
                  val.text().then(content => setFile('/sd' + path + val.name, content))
                }
              })
            }
            setTimeout(() => storedOnload?.(new ProgressEvent('load', { loaded: 100, total: 100 })), 80)
          } else {
            real.send.call(real, body as XMLHttpRequestBodyInit | Document | null | undefined)
          }
        }

        if (prop === 'setRequestHeader') return (name: string, value: string) => {
          if (!intercept) real.setRequestHeader.call(real, name, value)
        }

        if (prop === 'abort') return () => real.abort.call(real)

        const val = Reflect.get(target, prop, target)
        return typeof val === 'function' ? val.bind(target) : val
      },

      set(target, prop, value) {
        if (intercept && prop === 'onload') { storedOnload = value; return true }
        try { Reflect.set(target, prop, value, target) } catch { /* read-only accessor */ }
        return true
      },
    })
  }
}
