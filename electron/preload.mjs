import { contextBridge, ipcRenderer } from 'electron'
import {
  DESKTOP_DOCUMENT_EXTERNAL_CHANGE_EVENT,
  DESKTOP_MENU_EVENT,
  DESKTOP_UPDATES_EVENT,
  IPC_CHANNELS,
} from './channels.mjs'

const BACKEND_ORIGIN_FLAG = '--kition-backend-origin='
const backendOrigin =
  (process.argv.find((arg) => arg.startsWith(BACKEND_ORIGIN_FLAG)) || '').slice(BACKEND_ORIGIN_FLAG.length) ||
  'http://127.0.0.1:18101'

const desktopBridge = {
  shell: 'electron',
  backendOrigin,
  DesktopInfo: () => ipcRenderer.invoke(IPC_CHANNELS.desktopInfo),
  BackendStatus: () => ipcRenderer.invoke(IPC_CHANNELS.backendStatus),
  RetryBackendStart: () => ipcRenderer.invoke(IPC_CHANNELS.retryBackendStart),
  OpenExternalURL: (url) => ipcRenderer.invoke(IPC_CHANNELS.openExternalURL, url),
  ShowNotification: (title, message) => ipcRenderer.invoke(IPC_CHANNELS.showNotification, title, message),
  WindowAction: (action) => ipcRenderer.invoke(IPC_CHANNELS.windowAction, action),
  OpenRuntimePath: (kind) => ipcRenderer.invoke(IPC_CHANNELS.openRuntimePath, kind),
  BootstrapInitialize: () => ipcRenderer.invoke(IPC_CHANNELS.bootstrapInitialize),
  BootstrapCreateAttestation: (request) => ipcRenderer.invoke(IPC_CHANNELS.bootstrapCreateAttestation, request),
  BootstrapStatus: () => ipcRenderer.invoke(IPC_CHANNELS.bootstrapStatus),
  SaveTextFile: (dialogTitle, defaultFilename, content) =>
    ipcRenderer.invoke(IPC_CHANNELS.saveTextFile, { dialogTitle, defaultFilename, content }),
  SaveBinaryFile: (request) => ipcRenderer.invoke(IPC_CHANNELS.saveBinaryFile, request),
  SavePdfFile: (request) => ipcRenderer.invoke(IPC_CHANNELS.savePdfFile, request),
  CopyDocumentHtml: (request) => ipcRenderer.invoke(IPC_CHANNELS.copyDocumentHtml, request),
  CopyImage: (request) => ipcRenderer.invoke(IPC_CHANNELS.copyImage, request),
  SubmitFeedback: (request) => ipcRenderer.invoke(IPC_CHANNELS.submitFeedback, request),
  ListWorkspaceDocuments: () => ipcRenderer.invoke(IPC_CHANNELS.listWorkspaceDocuments),
  ReadWorkspaceDocument: (request) => ipcRenderer.invoke(IPC_CHANNELS.readWorkspaceDocument, request),
  StatWorkspaceDocument: (request) => ipcRenderer.invoke(IPC_CHANNELS.statWorkspaceDocument, request),
  WriteWorkspaceDocument: (request) => ipcRenderer.invoke(IPC_CHANNELS.writeWorkspaceDocument, request),
  CreateWorkspaceDocument: (request) => ipcRenderer.invoke(IPC_CHANNELS.createWorkspaceDocument, request),
  CreateWorkspaceFolder: (request) => ipcRenderer.invoke(IPC_CHANNELS.createWorkspaceFolder, request),
  MoveWorkspaceDocument: (request) => ipcRenderer.invoke(IPC_CHANNELS.moveWorkspaceDocument, request),
  MoveWorkspaceFolder: (request) => ipcRenderer.invoke(IPC_CHANNELS.moveWorkspaceFolder, request),
  DeleteWorkspaceDocument: (request) => ipcRenderer.invoke(IPC_CHANNELS.deleteWorkspaceDocument, request),
  DeleteWorkspaceFolder: (request) => ipcRenderer.invoke(IPC_CHANNELS.deleteWorkspaceFolder, request),
  OpenWorkspaceFile: (request) => ipcRenderer.invoke(IPC_CHANNELS.openWorkspaceFile, request),
  SaveWorkspaceAsset: (request) => ipcRenderer.invoke(IPC_CHANNELS.saveWorkspaceAsset, request),
  ImportWorkspaceFile: (request) => ipcRenderer.invoke(IPC_CHANNELS.importWorkspaceFile, request),
  ChooseFilesToImport: () => ipcRenderer.invoke(IPC_CHANNELS.chooseFilesToImport),
  RevealWorkspaceFolder: (request) => ipcRenderer.invoke(IPC_CHANNELS.revealWorkspaceFolder, request),
  ChooseWorkspaceFolder: () => ipcRenderer.invoke(IPC_CHANNELS.chooseWorkspaceFolder),
  SetWorkspaceFolder: (request) => ipcRenderer.invoke(IPC_CHANNELS.setWorkspaceFolder, request),
  ListVaults: () => ipcRenderer.invoke(IPC_CHANNELS.listVaults),
  AddVault: (request) => ipcRenderer.invoke(IPC_CHANNELS.addVault, request),
  RemoveVault: (request) => ipcRenderer.invoke(IPC_CHANNELS.removeVault, request),
  RenameVault: (request) => ipcRenderer.invoke(IPC_CHANNELS.renameVault, request),
  SetActiveVault: (request) => ipcRenderer.invoke(IPC_CHANNELS.setActiveVault, request),
  ChooseDirectory: (request) => ipcRenderer.invoke(IPC_CHANNELS.chooseDirectory, request),
  StoreSecureValue: (key, value) => ipcRenderer.invoke(IPC_CHANNELS.storeSecureValue, key, value),
  ReadSecureValue: (key) => ipcRenderer.invoke(IPC_CHANNELS.readSecureValue, key),
  DeleteSecureValue: (key) => ipcRenderer.invoke(IPC_CHANNELS.deleteSecureValue, key),
  BrowserSessionStatus: (request) => ipcRenderer.invoke(IPC_CHANNELS.browserSessionStatus, request),
  EnsureBrowserSessionWindow: (request) => ipcRenderer.invoke(IPC_CHANNELS.ensureBrowserSessionWindow, request),
  OpenBrowserSessionHome: (request) => ipcRenderer.invoke(IPC_CHANNELS.openBrowserSessionHome, request),
  HideBrowserSessionPanel: (request) => ipcRenderer.invoke(IPC_CHANNELS.hideBrowserSessionPanel, request),
  GoBackBrowserSession: (request) => ipcRenderer.invoke(IPC_CHANNELS.goBackBrowserSession, request),
  GoForwardBrowserSession: (request) => ipcRenderer.invoke(IPC_CHANNELS.goForwardBrowserSession, request),
  ReloadBrowserSession: (request) => ipcRenderer.invoke(IPC_CHANNELS.reloadBrowserSession, request),
  StopBrowserSession: (request) => ipcRenderer.invoke(IPC_CHANNELS.stopBrowserSession, request),
  SetBrowserSessionHostLayout: (request) => ipcRenderer.invoke(IPC_CHANNELS.setBrowserSessionHostLayout, request),
  ExtractBrowserPageContext: (request) => ipcRenderer.invoke(IPC_CHANNELS.extractBrowserPageContext, request),
  SetTestBrowserSessionMock: (request) => ipcRenderer.invoke(IPC_CHANNELS.setBrowserSessionTestMock, request),
  ListBrowserSites: () => ipcRenderer.invoke(IPC_CHANNELS.listBrowserSites),
  ForgetBrowserSite: (request) => ipcRenderer.invoke(IPC_CHANNELS.forgetBrowserSite, request),
  RefreshBrowserSiteLoginStatus: (request) => ipcRenderer.invoke(IPC_CHANNELS.refreshBrowserSiteLoginStatus, request),
  UpdatesGetState:       ()        => ipcRenderer.invoke(IPC_CHANNELS.updatesGetState),
  UpdatesCheck:          ()        => ipcRenderer.invoke(IPC_CHANNELS.updatesCheck),
  UpdatesDownload:       ()        => ipcRenderer.invoke(IPC_CHANNELS.updatesDownload),
  UpdatesInstall:        ()        => ipcRenderer.invoke(IPC_CHANNELS.updatesInstall),
  UpdatesSetBetaChannel: (enabled) => ipcRenderer.invoke(IPC_CHANNELS.updatesSetBetaChannel, Boolean(enabled)),
  UpdatesSetAutoCheck:   (enabled) => ipcRenderer.invoke(IPC_CHANNELS.updatesSetAutoCheck, Boolean(enabled)),
  ProxyGet:              ()        => ipcRenderer.invoke(IPC_CHANNELS.proxyGet),
  ProxySave:             (payload) => ipcRenderer.invoke(IPC_CHANNELS.proxySave, payload),
  ProxyTest:             (payload) => ipcRenderer.invoke(IPC_CHANNELS.proxyTest, payload),
  ProxyRestartBackend:   ()        => ipcRenderer.invoke(IPC_CHANNELS.proxyRestartBackend),
  EventsOn: (eventName, callback) => {
    const wrapper = (_event, payload) => callback(payload)
    ipcRenderer.on(eventName, wrapper)
    return () => ipcRenderer.removeListener(eventName, wrapper)
  },
  BrowserOpenURL: (url) => ipcRenderer.invoke(IPC_CHANNELS.openExternalURL, url),
}

contextBridge.exposeInMainWorld('kitionDesktop', {
  ...desktopBridge,
  menuEvent: DESKTOP_MENU_EVENT,
  updatesEvent: DESKTOP_UPDATES_EVENT,
  documentExternalChangeEvent: DESKTOP_DOCUMENT_EXTERNAL_CHANGE_EVENT,
})
