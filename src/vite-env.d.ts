/// <reference types="vite/client" />
/// <reference types="node" />

interface ImportMetaEnv {
  /** The default co-editing sync server (`wss://…/v1/sync`) baked into this build; empty: none. */
  readonly VITE_KITION_SYNC_URL?: string
}

declare const __APP_VERSION__: string
declare const __APP_COMMIT__: string
declare const __APP_BUILD_AT__: string
declare const __APP_BUILD_IDENTITY__: string
declare const __APP_ANALYTICS_ENDPOINT__: string
declare const __APP_WEB_PREVIEW__: boolean
