// The kit e2e specs in WebKit, the engine of the desktop app's web view (WKWebView): WebKit
// behaves differently from Chromium in ways kits meet, such as audio contexts that start
// suspended. Run with `make kit-e2e-webkit`.
import { devices } from '@playwright/test'
import base from './playwright.config'

export default { ...base, projects: [{ name: 'webkit', use: { ...devices['Desktop Safari'] } }] }
