/// <reference types="vite/client" />

declare const __CONFIG_STUDIO_BUILD__: string;

declare module '*.svg' {
  const src: string
  export default src
}
