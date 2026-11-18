import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs/promises'
import path from 'node:path'

// H.264 is lossy. Check both the whole frame and foreground so white margins
// cannot conceal lost text. Values are absolute differences in 8-bit RGB.
export const limits = { mean: 4, foregroundMean: 12, p99: 32 }

export function compareFrame(expected, actual) {
  assert.equal(actual.length, expected.length, 'Decoded frame dimensions must match')
  const histogram = new Uint32Array(256)
  let total = 0; let foreground = 0; let foregroundChannels = 0
  for (let i = 0; i < expected.length; i += 4) {
    const active = Math.min(...expected.subarray(i, i + 3), ...actual.subarray(i, i + 3)) < 240
    for (let channel = 0; channel < 3; channel++) {
      const delta = Math.abs(expected[i + channel] - actual[i + channel])
      total += delta; histogram[delta]++
      if (active) { foreground += delta; foregroundChannels++ }
    }
  }
  const channels = expected.length / 4 * 3
  let count = 0; let p99 = 0
  for (; p99 < 255; p99++) {
    count += histogram[p99]
    if (count >= channels * 0.99) break
  }
  return { mean: total / channels, foregroundMean: foregroundChannels ? foreground / foregroundChannels : 0, p99 }
}

export function assertFrame(metrics, label) {
  for (const [key, limit] of Object.entries(limits)) assert.ok(metrics[key] <= limit, `${label}: ${key} ${metrics[key]} exceeds ${limit}`)
}

export function decodeSamples(moviePath, snapshots, recipe) {
  const frames = snapshots.map(({ time }) => Math.round(time * recipe.frameRate))
  const frameBytes = recipe.width * recipe.height * 4
  const decoded = execFileSync('ffmpeg', [
    '-v', 'error', '-i', moviePath, '-vf', `select=${frames.map(n => `eq(n\\,${n})`).join('+')}`,
    '-fps_mode', 'passthrough', '-f', 'rawvideo', '-pix_fmt', 'rgba', 'pipe:1',
  ], { maxBuffer: (snapshots.length + 1) * frameBytes })
  assert.equal(decoded.length, snapshots.length * frameBytes, 'Every requested encoded frame must exist')
  return snapshots.map((snapshot, index) => {
    const rgba = decoded.subarray(index * frameBytes, (index + 1) * frameBytes)
    const metrics = compareFrame(snapshot.rgba, rgba)
    assertFrame(metrics, `Encoded frame ${frames[index]}`)
    return { ...snapshot, rgba, metrics, frame: frames[index] }
  })
}

export async function writeContactSheet(browser, directory, name, snapshots, recipe) {
  const columns = recipe.orientation === 'portrait' ? 3 : 2
  const page = await browser.newPage({ viewport: { width: recipe.width * columns, height: recipe.height + 36 }, deviceScaleFactor: 1 })
  try {
    await page.setContent(`<style>body{margin:0;background:#ecebea;font:14px sans-serif;display:grid;grid-template-columns:repeat(${columns},${recipe.width}px)}.shot{background:white}canvas{display:block}p{margin:8px 12px}</style>`)
    for (const [index, snapshot] of snapshots.entries()) {
      const png = await page.evaluate(({ rgba, width, height, time }) => {
        const wrapper = document.createElement('div'); wrapper.className = 'shot'
        const canvas = document.createElement('canvas'); canvas.width = width; canvas.height = height
        canvas.getContext('2d').putImageData(new ImageData(new Uint8ClampedArray(rgba), width, height), 0, 0)
        const label = document.createElement('p'); label.textContent = `${time.toFixed(3)} seconds`
        wrapper.append(canvas, label); document.body.append(wrapper)
        return canvas.toDataURL('image/png').split(',')[1]
      }, { rgba: [...snapshot.rgba], width: recipe.width, height: recipe.height, time: snapshot.time })
      await fs.writeFile(path.join(directory, `${name}-${index + 1}.png`), Buffer.from(png, 'base64'))
    }
    await page.screenshot({ path: path.join(directory, `${name}.png`), fullPage: true })
  } finally { await page.close() }
}
