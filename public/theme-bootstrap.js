(() => {
  const root = document.documentElement
  let themeMode = 'dark'

  try {
    const cachedTheme = localStorage.getItem('kition.desktop.theme.bootstrap.v1')
    if (cachedTheme === 'light' || cachedTheme === 'dark' || cachedTheme === 'auto') {
      themeMode = cachedTheme
    } else {
      const backup = JSON.parse(localStorage.getItem('kition.desktop.settings.backup.v1') || 'null')
      const backupTheme = backup && backup.general && backup.general.theme
      if (backupTheme === 'light' || backupTheme === 'dark' || backupTheme === 'auto') {
        themeMode = backupTheme
      }
    }
  } catch {
    // A blocked or malformed local cache falls back to the product default.
  }

  const resolvedTheme = themeMode === 'auto'
    ? (window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light')
    : themeMode

  root.dataset.desktopThemeMode = themeMode
  root.dataset.desktopTheme = resolvedTheme
  root.classList.toggle('dark', resolvedTheme === 'dark')
  root.style.colorScheme = resolvedTheme
  document.querySelector('meta[name="theme-color"]')?.setAttribute(
    'content',
    resolvedTheme === 'dark' ? '#1b1e22' : '#ffffff',
  )
})()
