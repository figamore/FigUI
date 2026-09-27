// fetch()/XMLHttpRequest interception for the wasm bridge, matching
// src/lib/http.ts's real endpoints (/command, /command_silent, /upload,
// /files, and direct /sd, /localfs, /ext downloads). Modeled directly on
// src/demo/httpSimulator.ts (same URL matching), but backs file operations
// with the real wasm filesystem via shimTransport's fsRequest() instead of
// an in-memory JS simulation, and commands via commandBridge.ts instead of
// canned responses.
import { fsRequest } from './shimTransport'
import { sendBridgeCommand } from './commandBridge'

type Root = 'native_sd' | 'native_localfs'

function rootForPath(p: string): Root {
  return p === '/upload' ? 'native_sd' : 'native_localfs'
}

function joinPath(dir: string, name: string): string {
  return (dir.endsWith('/') ? dir : `${dir}/`) + name
}

function ok(body: string, type = 'text/plain'): Response {
  return new Response(body, { status: 200, headers: { 'Content-Type': type } })
}

// Manual parsing instead of `new URL(href, location.href)`: resolving a
// relative reference against a blob: base throws ("Failed to construct
// 'URL': Invalid URL") -- the same relative-resolution quirk that broke
// Router.tsx's `location.href = ...` navigation elsewhere in this project,
// now also hitting URL construction. It's compounded by a real FigUI bug:
// src/App.tsx's attemptConnect() calls `setBase(\`http://${window.location
// .host}\`)`, and window.location.host is empty inside this blob: iframe,
// so requests end up as "http:///command?..." -- which the URL parser
// reads as host="command", path="/", not what was intended. Since every
// request we care about targets one of a small set of known endpoints,
// recovering the real path+query by finding that endpoint name in the raw
// string sidesteps both problems: it needs no base at all, and it isn't
// fooled by the mis-parsed-host case either.
const KNOWN_PATH_RE = /\/(command_silent|command|upload|files|localfs\/|sd(?:\/|(?=\?)|$))/

function extractRequestUrl(href: string): { pathname: string; searchParams: URLSearchParams } | null {
  const m = KNOWN_PATH_RE.exec(href)
  if (!m) return null
  const rest = href.slice(m.index)
  const q = rest.indexOf('?')
  const pathname = q >= 0 ? rest.slice(0, q) : rest
  const searchParams = new URLSearchParams(q >= 0 ? rest.slice(q + 1) : '')
  return { pathname, searchParams }
}

function errorResponse(message: string, status = 500): Response {
  return new Response(message, { status })
}

// fluidnc_fs_list() (see wasm/wasm_fs_bridge.cpp) emits {"name","size"
// (JSON number, -1 for dirs),"datetime"}; FigUI's http.ts::listFiles()
// expects size as a *string*, checking `f.size === '-1'` for the directory
// sentinel -- matching real FluidNC's FileCommands.cpp wire convention.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function reshapeListing(raw: any, path: string): unknown {
  const files = (raw.files ?? []).map((f: { name: string; size: number; datetime?: string }) => ({
    name: f.name,
    shortname: f.name,
    size: f.size < 0 ? '-1' : String(f.size),
    isDir: f.size < 0,
    datetime: f.datetime ?? '',
  }))
  return {
    files,
    path: raw.path ?? path,
    total: raw.total,
    used: raw.used,
    occupation: raw.occupation,
    status: raw.status ?? 'Ok',
  }
}

async function handleFsAction(root: Root, params: URLSearchParams): Promise<Response> {
  const action = params.get('action') ?? 'list'
  const dir = params.get('path') ?? '/'
  const filename = params.get('filename') ?? ''

  try {
    switch (action) {
      case 'list':
        break
      case 'delete':
        await fsRequest('delete', { root, path: joinPath(dir, filename) })
        break
      case 'deletedir':
        await fsRequest('deletedir', { root, path: joinPath(dir, filename) })
        break
      case 'createdir':
        await fsRequest('mkdir', { root, path: joinPath(dir, filename) })
        break
      // 'rename' isn't implemented -- no fluidnc_fs_rename() bridge
      // function exists yet (same gap as WebUI-mm's wasmBridgeFileTransport
      // .ts). Falls through to the default below.
      default:
        return errorResponse(`Unsupported file operation in wasm demo: ${action}`, 400)
    }
    const listing = await fsRequest('list', { root, path: dir })
    return ok(JSON.stringify(reshapeListing(listing, dir)), 'application/json')
  } catch (e) {
    return errorResponse(String(e))
  }
}

async function handleUpload(root: Root, params: URLSearchParams, body: FormData): Promise<Response> {
  const dir = params.get('path') ?? '/'
  const writes: Promise<unknown>[] = []
  body.forEach((val, key) => {
    if (key === 'myfile[]' && val instanceof File) {
      writes.push(val.text().then((content) => fsRequest('write', { root, path: joinPath(dir, val.name), content })))
    }
  })
  await Promise.all(writes)
  const listing = await fsRequest('list', { root, path: dir })
  return ok(JSON.stringify(reshapeListing(listing, dir)), 'application/json')
}

async function handleFileDownload(pathname: string): Promise<Response> {
  const isSd = pathname === '/sd' || pathname.startsWith('/sd/')
  const root: Root = isSd ? 'native_sd' : 'native_localfs'
  const path = isSd ? pathname.slice(3) || '/' : pathname
  try {
    const content = await fsRequest('read', { root, path })
    return ok(content as string)
  } catch {
    return new Response('Not found', { status: 404 })
  }
}

export function installFetchInterceptor(): void {
  const orig = window.fetch.bind(window)

  window.fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const href = typeof input === 'string' ? input : input instanceof URL ? input.href : (input as Request).url
    const extracted = extractRequestUrl(href)
    if (!extracted) return orig(input, init)
    const { pathname: p, searchParams } = extracted
    const m = (init?.method ?? 'GET').toUpperCase()

    if (p === '/command' || p === '/command_silent') {
      const plain = searchParams.get('plain') ?? ''
      try {
        return ok(await sendBridgeCommand(plain))
      } catch (e) {
        return errorResponse(String(e))
      }
    }

    if (p === '/upload' || p === '/files') {
      const root = rootForPath(p)
      if (m === 'POST' && init?.body instanceof FormData) {
        return handleUpload(root, searchParams, init.body)
      }
      return handleFsAction(root, searchParams)
    }

    // /ext isn't backed by anything in the wasm build (no second SD-like
    // mount exists there), so it's left unintercepted -- falls through to
    // the original fetch, which will fail the same way an unhandled path
    // would on real hardware with nothing mounted there.
    if (p === '/sd' || p.startsWith('/sd/') || p.startsWith('/localfs/')) {
      return handleFileDownload(p)
    }

    return orig(input, init)
  }
}

// XHR intercept for uploadFile() (progress-tracked uploads) -- see
// src/lib/http.ts. uploadFirmware() posts to /updatefw, which isn't
// intercepted: there's no real flashing to simulate in a wasm demo, so it's
// left to fail like any other unhandled path, same as demo mode leaves it.
export function installXhrInterceptor(): void {
  const Orig = window.XMLHttpRequest

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ;(window as any).XMLHttpRequest = function InterceptedXHR() {
    const real = new Orig()
    let intercept = false
    let interceptRoot: Root = 'native_sd'
    let storedOnload: ((e: ProgressEvent) => void) | null = null
    const fakeUpload = { onprogress: null as ((e: ProgressEvent) => void) | null }

    return new Proxy(real, {
      get(target, prop) {
        if (intercept && prop === 'status') return 200
        if (intercept && prop === 'readyState') return 4
        if (intercept && prop === 'upload') return fakeUpload

        if (prop === 'open')
          return (method: string, url: string | URL, ...rest: unknown[]) => {
            // See extractRequestUrl()'s comment above -- same blob:-base
            // and empty-window.location.host issues apply here.
            const path = extractRequestUrl(String(url))?.pathname ?? ''
            intercept = path === '/upload' || path === '/files'
            interceptRoot = path === '/upload' ? 'native_sd' : 'native_localfs'
            if (!intercept) real.open.call(real, method, url, ...(rest as [boolean, string?, string?]))
          }

        if (prop === 'send')
          return (body?: unknown) => {
            if (intercept) {
              const fd = body instanceof FormData ? body : null
              const writes: Promise<unknown>[] = []
              if (fd) {
                const dir = (fd.get('path') as string) ?? '/'
                fd.forEach((val, key) => {
                  if (key === 'myfile[]' && val instanceof File) {
                    writes.push(
                      val.text().then((content) => fsRequest('write', { root: interceptRoot, path: joinPath(dir, val.name), content }))
                    )
                  }
                })
              }
              Promise.all(writes)
                .catch(() => {})
                .then(() => storedOnload?.(new ProgressEvent('load', { loaded: 100, total: 100 })))
            } else {
              real.send.call(real, body as XMLHttpRequestBodyInit | Document | null | undefined)
            }
          }

        if (prop === 'setRequestHeader')
          return (name: string, value: string) => {
            if (!intercept) real.setRequestHeader.call(real, name, value)
          }

        if (prop === 'abort') return () => real.abort.call(real)

        const val = Reflect.get(target, prop, target)
        return typeof val === 'function' ? val.bind(target) : val
      },

      set(target, prop, value) {
        if (intercept && prop === 'onload') {
          storedOnload = value
          return true
        }
        try {
          Reflect.set(target, prop, value, target)
        } catch {
          /* read-only accessor */
        }
        return true
      },
    })
  }
}
