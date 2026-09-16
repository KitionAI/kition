export function applyLinuxChromiumFlags(commandLine, platform = process.platform) {
  if (platform !== 'linux' || !commandLine || typeof commandLine.appendSwitch !== 'function') {
    return []
  }

  // AppImage cannot ship a SUID chrome-sandbox, so Chromium's GPU process
  // cannot open host Mesa GBM libraries (EACCES on dri_gbm.so). Keep the
  // renderer sandbox; only the GPU process sandbox is relaxed.
  commandLine.appendSwitch('disable-gpu-sandbox')
  return ['disable-gpu-sandbox']
}
