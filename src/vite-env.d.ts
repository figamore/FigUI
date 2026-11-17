/// <reference types="vite/client" />

declare const __CONFIG_STUDIO_BUILD__: string;
declare const __FIGUI_LOCALE__: string;
declare const __FIGUI_LANGUAGES__: readonly { code: string; name: string }[];

declare module '*.svg' {
  const src: string
  export default src
}
