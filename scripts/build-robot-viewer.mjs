import { build } from "esbuild";
import { copyFile } from "node:fs/promises";
// Classic IIFE works in FluidUI's opaque-origin srcdoc sandbox and avoids
// cross-origin module fetches from FluidNC's SD file server.
await build({
  stdin: {
    contents: `import { ACESFilmicToneMapping, AxesHelper, Box3, BoxGeometry, BufferGeometry,
      CanvasTexture, Color, ConeGeometry, CylinderGeometry, DirectionalLight, DoubleSide,
      Fog, GridHelper, Group, HemisphereLight, Line, LineBasicMaterial, LatheGeometry, Mesh,
      Matrix4, MeshBasicMaterial, MeshStandardMaterial, PCFSoftShadowMap,
      PerspectiveCamera, Plane, PlaneGeometry, Raycaster, RingGeometry, Scene, SphereGeometry,
      Sprite, SpriteMaterial, Vector2, Vector3, WebGLRenderer } from 'three';
      import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
      globalThis.RobotGraphics = { THREE: { ACESFilmicToneMapping, AxesHelper,
      Box3, BoxGeometry, BufferGeometry, CanvasTexture, Color, ConeGeometry, CylinderGeometry,
      DirectionalLight, DoubleSide, Fog, GridHelper, Group, HemisphereLight,
      Line, LineBasicMaterial, LatheGeometry, Matrix4, Mesh, MeshBasicMaterial, MeshStandardMaterial,
      PCFSoftShadowMap, PerspectiveCamera, Plane, PlaneGeometry, Raycaster, RingGeometry, Scene,
      SphereGeometry, Sprite, SpriteMaterial, Vector2, Vector3, WebGLRenderer }, OrbitControls };`,
    resolveDir: process.cwd(),
  },
  bundle: true,
  format: "iife",
  minify: true,
  target: "es2020",
  outfile: "plugins/robot-studio/viewer-lib.js",
  legalComments: "eof",
});
await copyFile(
  "node_modules/three/LICENSE",
  "plugins/robot-studio/THREE-LICENSE.txt",
);
