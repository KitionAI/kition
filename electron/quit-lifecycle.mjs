export function createBeforeQuitHandler({ app, cleanup, onError = console.error }) {
  let state = 'idle'

  return (event) => {
    if (state === 'complete') {
      return
    }

    event.preventDefault()
    if (state === 'running') {
      return
    }

    state = 'running'
    void Promise.resolve()
      .then(() => cleanup())
      .catch((error) => {
        onError(error)
      })
      .finally(() => {
        state = 'complete'
        app.quit()
      })
  }
}
