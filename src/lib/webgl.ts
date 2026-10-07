/** Minimal WebGL renderer for 3D G-code visualization */

export interface Matrix4 {
  elements: Float32Array
}

export interface Vector3 {
  x: number
  y: number
  z: number
}

export interface Camera {
  position: Vector3
  target: Vector3
  up: Vector3
  fov: number
  aspect: number
  near: number
  far: number
  projection: 'perspective' | 'orthographic'
  orthoSize: number
}

// Matrix/vector utilities (minimal implementations)
export function createMatrix4(): Matrix4 {
  return {
    elements: new Float32Array([
      1, 0, 0, 0,
      0, 1, 0, 0,
      0, 0, 1, 0,
      0, 0, 0, 1
    ])
  }
}

export function perspectiveMatrix(fov: number, aspect: number, near: number, far: number): Matrix4 {
  const f = Math.tan(Math.PI * 0.5 - 0.5 * fov)
  const rangeInv = 1.0 / (near - far)
  const m = createMatrix4()

  m.elements[0] = f / aspect
  m.elements[5] = f
  m.elements[10] = (near + far) * rangeInv
  m.elements[11] = -1
  m.elements[14] = near * far * rangeInv * 2
  m.elements[15] = 0

  return m
}

export function orthographicMatrix(size: number, aspect: number, near: number, far: number): Matrix4 {
  const halfHeight = Math.max(size, 1e-6)
  const halfWidth = halfHeight * Math.max(aspect, 1e-6)
  const left = -halfWidth
  const right = halfWidth
  const bottom = -halfHeight
  const top = halfHeight
  const m = createMatrix4()

  m.elements[0] = 2 / (right - left)
  m.elements[5] = 2 / (top - bottom)
  m.elements[10] = -2 / (far - near)
  m.elements[12] = -(right + left) / (right - left)
  m.elements[13] = -(top + bottom) / (top - bottom)
  m.elements[14] = -(far + near) / (far - near)

  return m
}

export function lookAtMatrix(eye: Vector3, target: Vector3, up: Vector3): Matrix4 {
  const zx = eye.x - target.x
  const zy = eye.y - target.y
  const zz = eye.z - target.z
  let zlen = Math.sqrt(zx * zx + zy * zy + zz * zz)
  if (zlen === 0) zlen = 1

  const nx = zx / zlen
  const ny = zy / zlen
  const nz = zz / zlen

  const xx = up.y * nz - up.z * ny
  const xy = up.z * nx - up.x * nz
  const xz = up.x * ny - up.y * nx
  let xlen = Math.sqrt(xx * xx + xy * xy + xz * xz)
  if (xlen === 0) xlen = 1

  const ux = xx / xlen
  const uy = xy / xlen
  const uz = xz / xlen

  const yx = ny * uz - nz * uy
  const yy = nz * ux - nx * uz
  const yz = nx * uy - ny * ux

  const m = createMatrix4()
  m.elements[0] = ux
  m.elements[1] = yx
  m.elements[2] = nx
  m.elements[4] = uy
  m.elements[5] = yy
  m.elements[6] = ny
  m.elements[8] = uz
  m.elements[9] = yz
  m.elements[10] = nz
  m.elements[12] = -(ux * eye.x + uy * eye.y + uz * eye.z)
  m.elements[13] = -(yx * eye.x + yy * eye.y + yz * eye.z)
  m.elements[14] = -(nx * eye.x + ny * eye.y + nz * eye.z)

  return m
}

export function multiplyMatrices(a: Matrix4, b: Matrix4): Matrix4 {
  const result = createMatrix4()
  const ae = a.elements
  const be = b.elements
  const te = result.elements

  for (let i = 0; i < 4; i++) {
    for (let j = 0; j < 4; j++) {
      te[i * 4 + j] =
        ae[i * 4 + 0] * be[0 * 4 + j] +
        ae[i * 4 + 1] * be[1 * 4 + j] +
        ae[i * 4 + 2] * be[2 * 4 + j] +
        ae[i * 4 + 3] * be[3 * 4 + j]
    }
  }

  return result
}

// Minimal WebGL shader programs
const vertexShaderSource = `
attribute vec3 a_position;
attribute vec4 a_color;
uniform mat4 u_projectionMatrix;
uniform mat4 u_viewMatrix;
varying vec4 v_color;

void main() {
  gl_Position = u_projectionMatrix * u_viewMatrix * vec4(a_position, 1.0);
  v_color = a_color;
}
`

const fragmentShaderSource = `
precision mediump float;
varying vec4 v_color;

void main() {
  gl_FragColor = v_color;
}
`

export interface WebGLRenderer {
  gl: WebGLRenderingContext
  program: WebGLProgram
  staticPositionBuffer: WebGLBuffer
  staticColorBuffer: WebGLBuffer
  dynamicPositionBuffer: WebGLBuffer
  dynamicColorBuffer: WebGLBuffer
  trianglePositionBuffer: WebGLBuffer
  triangleColorBuffer: WebGLBuffer
  positionLocation: number
  colorLocation: number
  projectionMatrixLocation: WebGLUniformLocation
  viewMatrixLocation: WebGLUniformLocation
  staticVertexCount: number
}

export function createRenderer(canvas: HTMLCanvasElement): WebGLRenderer | null {
  const gl = canvas.getContext('webgl') as WebGLRenderingContext | null ||
             canvas.getContext('experimental-webgl') as WebGLRenderingContext | null
  if (!gl) return null

  // Create shaders
  const vertexShader = gl.createShader(gl.VERTEX_SHADER)!
  gl.shaderSource(vertexShader, vertexShaderSource)
  gl.compileShader(vertexShader)

  const fragmentShader = gl.createShader(gl.FRAGMENT_SHADER)!
  gl.shaderSource(fragmentShader, fragmentShaderSource)
  gl.compileShader(fragmentShader)

  // Create program
  const program = gl.createProgram()!
  gl.attachShader(program, vertexShader)
  gl.attachShader(program, fragmentShader)
  gl.linkProgram(program)

  // Get locations
  const positionLocation = gl.getAttribLocation(program, 'a_position')
  const colorLocation = gl.getAttribLocation(program, 'a_color')
  const projectionMatrixLocation = gl.getUniformLocation(program, 'u_projectionMatrix')!
  const viewMatrixLocation = gl.getUniformLocation(program, 'u_viewMatrix')!

  // Create buffers
  const staticPositionBuffer = gl.createBuffer()!
  const staticColorBuffer = gl.createBuffer()!
  const dynamicPositionBuffer = gl.createBuffer()!
  const dynamicColorBuffer = gl.createBuffer()!
  const trianglePositionBuffer = gl.createBuffer()!
  const triangleColorBuffer = gl.createBuffer()!

  // Setup WebGL state
  gl.enable(gl.DEPTH_TEST)
  gl.enable(gl.BLEND)
  gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA)
  gl.clearColor(0.0, 0.0, 0.0, 0.0)

  return {
    gl,
    program,
    staticPositionBuffer,
    staticColorBuffer,
    dynamicPositionBuffer,
    dynamicColorBuffer,
    trianglePositionBuffer,
    triangleColorBuffer,
    positionLocation,
    colorLocation,
    projectionMatrixLocation,
    viewMatrixLocation,
    staticVertexCount: 0,
  }
}

function bindLineBuffers(
  renderer: WebGLRenderer,
  positionBuffer: WebGLBuffer,
  colorBuffer: WebGLBuffer,
  byteColors = false,
) {
  const { gl } = renderer

  gl.bindBuffer(gl.ARRAY_BUFFER, positionBuffer)
  gl.enableVertexAttribArray(renderer.positionLocation)
  gl.vertexAttribPointer(renderer.positionLocation, 3, gl.FLOAT, false, 0, 0)

  gl.bindBuffer(gl.ARRAY_BUFFER, colorBuffer)
  gl.enableVertexAttribArray(renderer.colorLocation)
  if (byteColors) gl.vertexAttribPointer(renderer.colorLocation, 4, gl.UNSIGNED_BYTE, true, 0, 0)
  else gl.vertexAttribPointer(renderer.colorLocation, 4, gl.FLOAT, false, 0, 0)
}

/** Uploads the toolpath once; `colors` holds four normalized bytes (RGBA) per vertex. */
export function setStaticLineData(
  renderer: WebGLRenderer,
  vertices: Float32Array,
  colors: Uint8Array,
) {
  const { gl } = renderer

  gl.bindBuffer(gl.ARRAY_BUFFER, renderer.staticPositionBuffer)
  gl.bufferData(gl.ARRAY_BUFFER, vertices, gl.STATIC_DRAW)

  gl.bindBuffer(gl.ARRAY_BUFFER, renderer.staticColorBuffer)
  gl.bufferData(gl.ARRAY_BUFFER, colors, gl.STATIC_DRAW)

  renderer.staticVertexCount = vertices.length / 3
}

export function renderLines(
  renderer: WebGLRenderer,
  camera: Camera,
  dynamicVertices: Float32Array,
  dynamicColors: Float32Array,
  toolVertexStart?: number,  // vertex index where tool-marker lines begin
  toolLineWidth = 3,
  triangleVertices?: Float32Array,
  triangleColors?: Float32Array,
) {
  const { gl } = renderer

  gl.viewport(0, 0, gl.drawingBufferWidth, gl.drawingBufferHeight)
  gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT)
  gl.useProgram(renderer.program)

  const projMatrix = camera.projection === 'orthographic'
    ? orthographicMatrix(camera.orthoSize, camera.aspect, camera.near, camera.far)
    : perspectiveMatrix(camera.fov, camera.aspect, camera.near, camera.far)
  const viewMatrix = lookAtMatrix(camera.position, camera.target, camera.up)
  gl.uniformMatrix4fv(renderer.projectionMatrixLocation, false, projMatrix.elements)
  gl.uniformMatrix4fv(renderer.viewMatrixLocation, false, viewMatrix.elements)

  if (renderer.staticVertexCount > 0) {
    bindLineBuffers(renderer, renderer.staticPositionBuffer, renderer.staticColorBuffer, true)
    gl.lineWidth(1)
    gl.drawArrays(gl.LINES, 0, renderer.staticVertexCount)
  }

  if (triangleVertices && triangleColors && triangleVertices.length > 0) {
    gl.depthMask(false)

    gl.bindBuffer(gl.ARRAY_BUFFER, renderer.trianglePositionBuffer)
    gl.bufferData(gl.ARRAY_BUFFER, triangleVertices, gl.STATIC_DRAW)
    gl.enableVertexAttribArray(renderer.positionLocation)
    gl.vertexAttribPointer(renderer.positionLocation, 3, gl.FLOAT, false, 0, 0)

    gl.bindBuffer(gl.ARRAY_BUFFER, renderer.triangleColorBuffer)
    gl.bufferData(gl.ARRAY_BUFFER, triangleColors, gl.STATIC_DRAW)
    gl.enableVertexAttribArray(renderer.colorLocation)
    gl.vertexAttribPointer(renderer.colorLocation, 4, gl.FLOAT, false, 0, 0)

    gl.drawArrays(gl.TRIANGLES, 0, triangleVertices.length / 3)
    gl.depthMask(true)
  }

  if (dynamicVertices.length === 0 || dynamicColors.length === 0) return

  gl.bindBuffer(gl.ARRAY_BUFFER, renderer.dynamicPositionBuffer)
  gl.bufferData(gl.ARRAY_BUFFER, dynamicVertices, gl.STATIC_DRAW)

  gl.bindBuffer(gl.ARRAY_BUFFER, renderer.dynamicColorBuffer)
  gl.bufferData(gl.ARRAY_BUFFER, dynamicColors, gl.STATIC_DRAW)

  bindLineBuffers(renderer, renderer.dynamicPositionBuffer, renderer.dynamicColorBuffer)

  const totalVerts = dynamicVertices.length / 3

  if (toolVertexStart === undefined || toolVertexStart >= totalVerts) {
    gl.lineWidth(1)
    gl.drawArrays(gl.LINES, 0, totalVerts)
  } else {
    // Path lines
    gl.lineWidth(1)
    gl.drawArrays(gl.LINES, 0, toolVertexStart)
    // Tool-marker lines — thicker where supported
    gl.lineWidth(toolLineWidth)
    gl.drawArrays(gl.LINES, toolVertexStart, totalVerts - toolVertexStart)
    gl.lineWidth(1)
  }
}