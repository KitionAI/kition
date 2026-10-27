import { expect, test } from '@playwright/test'
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { kitEngine, openInKitFrame, openKitWorkspace, openTreeFile } from './helpers/embeddedKit'

const engine = kitEngine('html', 'kition_html_sdk')
const original = '<!doctype html><html><body><h1>Original HTML</h1></body></html>'
const edited = '<!doctype html><html><body style="background:#5645d4;color:white"><h1>Saved HTML</h1></body></html>'

test.beforeEach(() => {
  test.skip(!engine.built, 'Build the optional HTML package with scripts/build-kit-ui.sh html')
})

test('creates HTML from the workspace, edits it, and reopens the saved source', async ({ page, baseURL }, testInfo) => {
  test.setTimeout(120_000)
  const { host, saves } = await openKitWorkspace(page, baseURL!, {}, { persist: true })
  try {
    await page.locator('.document-private-heading .document-create-menu-anchor > button').click()
    await page.getByRole('group', { name: 'Documents' }).getByTestId('workspace-create-html').click()
    await expect.poll(() => saves.map((save) => save.path), { timeout: 60_000 }).toEqual(['Untitled HTML.html'])
    expect(saves[0]!.bytes.toString()).toContain('<!doctype html>')
    const kit = page.frameLocator('[data-testid="kit-frame-window"][title="Untitled HTML.html"]')
    await expect(kit.getByTestId('html-source')).toHaveValue(/Untitled HTML/, { timeout: 60_000 })
    await kit.getByTestId('html-source').fill(edited)
    // Save from the source field immediately, without waiting for rendering.
    await kit.getByTestId('html-source').press('ControlOrMeta+s')
    await expect.poll(() => saves.at(-1)?.bytes.toString(), { timeout: 30_000 }).toBe(edited)
    await expect(kit.getByTestId('html-unsaved')).toHaveCount(0)
    await expect(kit.getByTestId('html-preview').locator('canvas').first()).toBeVisible()
    await page.screenshot({ path: testInfo.outputPath('html-editor.png') })
    await page.reload()
    const reopened = await openTreeFile(page, 'Untitled HTML.html')
    await expect(reopened.getByTestId('html-source')).toHaveValue(edited, { timeout: 60_000 })
  } finally {
    await host.dispose()
  }
})

test('opens HTM, clears and restores source, and saves through the kit file API', async ({ page, baseURL }) => {
  test.setTimeout(120_000)
  const { host, saves, kit } = await openInKitFrame(page, baseURL!, 'Page.HTM', Buffer.from(original), {}, { persist: true })
  try {
    const source = kit.getByTestId('html-source')
    await expect(source).toHaveValue(original, { timeout: 60_000 })
    await source.fill('not HTML markup')
    await expect(source).toHaveValue(original)
    await source.fill('')
    await expect(kit.getByTestId('html-unsaved')).toBeVisible()
    await kit.getByTestId('html-save').click()
    await expect.poll(() => saves.at(-1)?.bytes.toString()).toBe('')
    await source.fill(edited)
    await expect(kit.getByTestId('html-unsaved')).toBeVisible()
    await kit.getByTestId('html-save').click()
    await expect.poll(() => saves.at(-1)?.bytes.toString()).toBe(edited)
    expect(saves.every((save) => save.path === 'Page.HTM')).toBe(true)
  } finally {
    await host.dispose()
  }
})

test('isolates script resources from the host and reports unavailable assets', async ({ page, baseURL }) => {
  test.setTimeout(120_000)
  const html = '<!doctype html><script>fetch("https://html-kit.invalid/script-ran")</script><img src="/assets/missing.png"><p>Script preview</p>'
  let scriptRequests = 0
  page.on('request', (request) => { if (request.url().includes('html-kit.invalid')) scriptRequests += 1 })
  const { host, kit } = await openInKitFrame(page, baseURL!, 'Static.html', Buffer.from(html))
  try {
    await expect(kit.getByTestId('html-source')).toHaveValue(html, { timeout: 60_000 })
    await expect(kit.getByTestId('html-diagnostics')).toContainText('missing', { timeout: 60_000 })
    expect(scriptRequests).toBe(0)
  } finally {
    await host.dispose()
  }
})


test('preserves unsaved source when disk changes and respects a read-only role', async ({ page, baseURL }) => {
  test.setTimeout(120_000)
  const { host, saves, kit } = await openInKitFrame(page, baseURL!, 'Conflict.html', Buffer.from(original), {}, { persist: true })
  try {
    const source = kit.getByTestId('html-source')
    await expect(source).toHaveValue(original, { timeout: 60_000 })
    await source.fill(edited)
    await expect(kit.getByTestId('html-unsaved')).toBeVisible()
    const disk = '<!doctype html><p>Changed on disk</p>'
    await writeFile(join(host.root, 'Conflict.html'), disk)
    await expect(kit.getByTestId('html-conflict')).toBeVisible({ timeout: 15_000 })
    await expect(source).toHaveValue(edited)
    await kit.getByTestId('html-save').click()
    await expect(kit.getByTestId('html-conflict')).toBeVisible()
    expect(saves).toHaveLength(0)
    await kit.getByTestId('html-keep-mine').click()
    await expect(kit.getByTestId('html-conflict')).toHaveCount(0)
    await kit.getByTestId('html-save').click()
    await expect.poll(() => saves.at(-1)?.bytes.toString()).toBe(edited)
    await page.evaluate(() => window.__KITION_KIT_TEST__!.setReadOnlyDocuments(['Conflict.html']))
    await expect(source).toHaveAttribute('readonly', '', { timeout: 60_000 })
    await expect(kit.getByTestId('html-save')).toHaveCount(0)
  } finally {
    await host.dispose()
  }
})

test('edits and saves a large HTML source without truncating it', async ({ page, baseURL }) => {
  test.setTimeout(120_000)
  const large = `<!doctype html><html><body><h1>Large page</h1>${'<p>HTML content</p>'.repeat(2000)}<!--${'fixture '.repeat(40000)}--></body></html>`
  const changed = large.replace('<h1>Large page</h1>', '<h1>Updated large page</h1>')
  const { host, saves, kit } = await openInKitFrame(page, baseURL!, 'Large.html', Buffer.from(large), {}, { persist: true })
  try {
    const source = kit.getByTestId('html-source')
    await expect(source).toHaveValue(large, { timeout: 60_000 })
    await source.fill(changed)
    await source.press('ControlOrMeta+s')
    await expect.poll(() => saves.at(-1)?.bytes.toString(), { timeout: 30_000 }).toBe(changed)
    await expect(source).toHaveValue(changed)
  } finally {
    await host.dispose()
  }
})


test('runs JavaScript timers and repeated preview clicks while saving only source', async ({ page, baseURL }) => {
  test.setTimeout(120_000)
  const html = '<!doctype html><style>html,body{margin:0;width:100%;height:100%;background:red}</style><body><script>let clicks=0;setTimeout(()=>document.body.style.background="#5645d4",100);document.body.onclick=()=>{document.body.style.background=++clicks===1?"#1f9d4c":"#e5486a"}</script></body>'
  // A distinct initial color prevents an old frame from satisfying the edited page's timer check.
  const initial = html.replace('#5645d4', '#e9e6fb')
  const { host, saves, kit } = await openInKitFrame(page, baseURL!, 'Interactive.html', Buffer.from(initial), {}, { persist: true })
  try {
    const source = kit.getByTestId('html-source')
    await expect(source).toHaveValue(initial, { timeout: 60_000 })
    const editedSource = `${html}\n`
    await source.fill(editedSource)
    const preview = kit.getByTestId('html-preview').locator('canvas').first()
    const color = () => preview.evaluate((element) => {
      const canvas = element as HTMLCanvasElement
      return Array.from(canvas.getContext('2d')!.getImageData(Math.floor(canvas.width / 2), Math.floor(canvas.height / 2), 1, 1).data)
    })
    await expect.poll(color, { timeout: 60_000 }).toEqual([86, 69, 212, 255])
    await preview.click()
    await expect.poll(color).toEqual([31, 157, 76, 255])
    await preview.click()
    await expect.poll(color).toEqual([229, 72, 106, 255])
    await kit.getByTestId('html-save').click()
    await expect.poll(() => saves.at(-1)?.bytes.toString()).toBe(editedSource)
    await expect(source).toHaveValue(editedSource)
    await expect(kit.getByTestId('html-unsaved')).toHaveCount(0)
    await expect(kit.getByTestId('html-diagnostics')).toHaveText('No rendering diagnostics')
  } finally {
    await host.dispose()
  }
})

test('renders Canvas images and activates a label without persisting runtime pixels', async ({ page, baseURL }) => {
  test.setTimeout(120_000)
  const html = '<!doctype html><style>html,body{margin:0;width:100%;height:100%}canvas{display:block;width:100vw;height:100vh}</style><label><canvas id="art" width="64" height="64"></canvas><input id="toggle" type="checkbox" hidden></label><script>const art=document.getElementById("art"),ctx=art.getContext("2d"),source=document.createElement("canvas");source.width=8;source.height=8;const brush=source.getContext("2d");brush.fillStyle="#5645d4";brush.fillRect(0,0,8,8);ctx.drawImage(source,0,0,64,64);document.getElementById("toggle").onchange=event=>{ctx.fillStyle=event.target.checked?"#1f9d4c":"#e5486a";const shape=new Path2D();shape.roundRect(0,0,64,64,8);ctx.fill(shape)}</script>'
  const { host, saves, kit } = await openInKitFrame(page, baseURL!, 'Canvas.html', Buffer.from(html), {}, { persist: true })
  try {
    const source = kit.getByTestId('html-source')
    await expect(source).toHaveValue(html, { timeout: 60_000 })
    const editedSource = `${html}\n`
    await source.fill(editedSource)
    const preview = kit.getByTestId('html-preview').locator('canvas').first()
    const color = () => preview.evaluate((element) => {
      const canvas = element as HTMLCanvasElement
      return Array.from(canvas.getContext('2d')!.getImageData(Math.floor(canvas.width / 2), Math.floor(canvas.height / 2), 1, 1).data)
    })
    await expect.poll(color, { timeout: 60_000 }).toEqual([86, 69, 212, 255])
    await preview.click()
    await expect.poll(color).toEqual([31, 157, 76, 255])
    await preview.click()
    await expect.poll(color).toEqual([229, 72, 106, 255])
    await kit.getByTestId('html-save').click()
    await expect.poll(() => saves.at(-1)?.bytes.toString()).toBe(editedSource)
    await expect(source).toHaveValue(editedSource)
    await expect(kit.getByTestId('html-diagnostics')).toHaveText('No rendering diagnostics')
  } finally {
    await host.dispose()
  }
})

test('renders selected options and Canvas text with cancelable event subscriptions', async ({ page, baseURL }) => {
  test.setTimeout(120_000)
  const html = `<!doctype html><style>html,body{margin:0;width:100%;height:100%;background:red}select{display:block;width:200px;height:40px;font:20px Inter;appearance:none;border:0;color:#1a1a1a;background:white}canvas{display:block;background:white}</style><select id="choice"><option value="initial">Initial</option><option value="ready">Ready</option></select><canvas id="art" width="200" height="60"></canvas><script>
const choice=document.getElementById('choice'),ctx=document.getElementById('art').getContext('2d');
choice.value='ready';ctx.font='24px Inter';ctx.fillText('Canvas text',8,36);
const bus=new EventTarget(),controller=new AbortController();let canceledCalls=0;
bus.addEventListener('paint',()=>canceledCalls++,{signal:controller.signal});
controller.abort();
bus.addEventListener('paint',event=>{if(canceledCalls===0&&event.target===bus&&event.composedPath()[0]===bus)document.body.style.background='#1f9d4c'});
document.body.addEventListener('click',()=>bus.dispatchEvent(new Event('paint')));
if(choice.value==='ready'&&ctx.measureText('Canvas text').width>20)document.body.style.background='#5645d4';
</script>`
  const { host, saves, kit } = await openInKitFrame(page, baseURL!, 'Events.html', Buffer.from(html), {}, { persist: true })
  try {
    const source = kit.getByTestId('html-source')
    await expect(source).toHaveValue(html, { timeout: 60_000 })
    const preview = kit.getByTestId('html-preview').locator('canvas').first()
    const pixels = () => preview.evaluate((element) => {
      const canvas = element as HTMLCanvasElement
      const context = canvas.getContext('2d')!
      // The shared canvas fits and centers the document inside its viewport.
      // Locate the document background before reading its two text regions.
      const raster = context.getImageData(0, 0, canvas.width, canvas.height).data
      let left = canvas.width, right = 0, originY = canvas.height
      for (let y = 0; y < canvas.height; y += 1) {
        for (let x = 0; x < canvas.width; x += 1) {
          const index = (y * canvas.width + x) * 4
          if ((raster[index] === 86 && raster[index + 1] === 69 && raster[index + 2] === 212)
              || (raster[index] === 31 && raster[index + 1] === 157 && raster[index + 2] === 76)) {
            left = Math.min(left, x)
            right = Math.max(right, x)
            originY = Math.min(originY, y)
          }
        }
      }
      const scale = Math.max(1, right - left + 1) / 640
      const darkPixels = (top: number, bottom: number) => {
        if (left >= canvas.width) return 0
        const data = context.getImageData(left, originY + Math.round(top * scale), Math.max(1, Math.round(160 * scale)), Math.max(1, Math.round((bottom - top) * scale))).data
        let count = 0
        for (let index = 0; index < data.length; index += 4) {
          if (data[index]! < 100 && data[index + 1]! < 100 && data[index + 2]! < 100) count += 1
        }
        return count
      }
      return {
        color: Array.from(context.getImageData(Math.floor(canvas.width / 2), Math.floor(canvas.height / 2), 1, 1).data),
        option: darkPixels(0, 40),
        text: darkPixels(40, 100),
      }
    })
    await expect.poll(async () => (await pixels()).color, { timeout: 60_000 }).toEqual([86, 69, 212, 255])
    expect((await pixels()).option).toBeGreaterThan(20)
    expect((await pixels()).text).toBeGreaterThan(20)
    await preview.click()
    await expect.poll(async () => (await pixels()).color).toEqual([31, 157, 76, 255])
    await source.fill(`${html}\n`)
    await kit.getByTestId('html-save').click()
    await expect.poll(() => saves.at(-1)?.bytes.toString()).toBe(`${html}\n`)
    await expect(kit.getByTestId('html-diagnostics')).toHaveText('No rendering diagnostics')
  } finally {
    await host.dispose()
  }
})

test('renders Canvas kerning in the Worker and saves only the source', async ({ page, baseURL }) => {
  test.setTimeout(120_000)
  const html = `<!doctype html><style>html,body{margin:0;width:100%;height:100%;background:red}canvas{display:block}</style><canvas id="art" width="240" height="100"></canvas><script>
const ctx=document.getElementById('art').getContext('2d');ctx.font='32px Inter';
const normal=ctx.measureText('AVATAR').width;
ctx.fontKerning='none';const wide=ctx.measureText('AVATAR').width;
ctx.save();ctx.fontKerning='normal';ctx.restore();ctx.fillText('AVATAR',8,48);
const ink=ctx.getImageData(0,0,240,100).data.some((value,index)=>index%4===3&&value>0);
if(wide>normal+5&&ctx.fontKerning==='none'&&ink)document.body.style.background='#5645d4';
document.body.onclick=()=>{ctx.fontKerning='auto';if(ctx.measureText('AVATAR').width===normal)document.body.style.background='#1f9d4c'};
</script>`
  const { host, saves, kit } = await openInKitFrame(page, baseURL!, 'Kerning.html', Buffer.from(html), {}, { persist: true })
  try {
    const source = kit.getByTestId('html-source')
    await expect(source).toHaveValue(html, { timeout: 60_000 })
    const preview = kit.getByTestId('html-preview').locator('canvas').first()
    const color = () => preview.evaluate((element) => {
      const canvas = element as HTMLCanvasElement
      return Array.from(canvas.getContext('2d')!.getImageData(Math.floor(canvas.width / 2), Math.floor(canvas.height / 2), 1, 1).data)
    })
    await expect.poll(color, { timeout: 60_000 }).toEqual([86, 69, 212, 255])
    await preview.click()
    await expect.poll(color).toEqual([31, 157, 76, 255])
    await expect(source).toHaveValue(html)
    await expect(kit.getByTestId('html-unsaved')).toHaveCount(0)
    await source.fill(`${html}\n`)
    await kit.getByTestId('html-save').click()
    await expect.poll(() => saves.at(-1)?.bytes.toString()).toBe(`${html}\n`)
    await expect(kit.getByTestId('html-diagnostics')).toHaveText('No rendering diagnostics')
  } finally {
    await host.dispose()
  }
})

test('renders Canvas spacing in the Worker and saves only the source', async ({ page, baseURL }) => {
  test.setTimeout(120_000)
  const html = `<!doctype html><style>html,body{margin:0;width:100%;height:100%;background:red}canvas{display:block}</style><canvas id="art" width="240" height="100"></canvas><script>
const ctx=document.getElementById('art').getContext('2d');ctx.font='32px Inter';
const normal=ctx.measureText('A B').width;
ctx.letterSpacing='2px';ctx.wordSpacing='4px';const wide=ctx.measureText('A B').width;
ctx.save();ctx.letterSpacing='0px';ctx.wordSpacing='0px';ctx.restore();ctx.fillText('A B',8,48);ctx.strokeText('A B',8,88);
const ink=ctx.getImageData(0,0,240,100).data.some((value,index)=>index%4===3&&value>0);
if(Math.abs(wide-normal-10)<.001&&ctx.letterSpacing==='2px'&&ctx.wordSpacing==='4px'&&ink)document.body.style.background='#5645d4';
document.body.onclick=()=>{ctx.reset();ctx.font='32px Inter';if(ctx.letterSpacing==='0px'&&ctx.wordSpacing==='0px'&&ctx.measureText('A B').width===normal)document.body.style.background='#1f9d4c'};
</script>`
  const { host, saves, kit } = await openInKitFrame(page, baseURL!, 'Spacing.html', Buffer.from(html), {}, { persist: true })
  try {
    const source = kit.getByTestId('html-source')
    await expect(source).toHaveValue(html, { timeout: 60_000 })
    const preview = kit.getByTestId('html-preview').locator('canvas').first()
    const color = () => preview.evaluate((element) => {
      const canvas = element as HTMLCanvasElement
      return Array.from(canvas.getContext('2d')!.getImageData(Math.floor(canvas.width / 2), Math.floor(canvas.height / 2), 1, 1).data)
    })
    await expect.poll(color, { timeout: 60_000 }).toEqual([86, 69, 212, 255])
    await preview.click()
    await expect.poll(color).toEqual([31, 157, 76, 255])
    await expect(source).toHaveValue(html)
    await expect(kit.getByTestId('html-unsaved')).toHaveCount(0)
    await source.fill(`${html}\n`)
    await kit.getByTestId('html-save').click()
    await expect.poll(() => saves.at(-1)?.bytes.toString()).toBe(`${html}\n`)
    await expect(kit.getByTestId('html-diagnostics')).toHaveText('No rendering diagnostics')
  } finally {
    await host.dispose()
  }
})

test('preserves reentrant Canvas text assignments in the Worker and saves only the source', async ({ page, baseURL }) => {
  test.setTimeout(120_000)
  const html = `<!doctype html><style>html,body{margin:0;width:100%;height:100%;background:red}canvas{display:block}</style><canvas id="art" width="240" height="100"></canvas><script>
const canvas=document.getElementById('art'),ctx=canvas.getContext('2d');
ctx.font={toString(){canvas.width=canvas.width;return '32px Inter'}};
const normal=ctx.measureText('AVATAR').width;
ctx.fontKerning={toString(){canvas.width=canvas.width;return 'none'}};
ctx.font='32px Inter';const wide=ctx.measureText('AVATAR').width;
let rejected=false;try{ctx.font=Symbol('font')}catch(e){rejected=e instanceof TypeError}
ctx.fillText('AVATAR',8,48);
if(normal>100&&wide>normal+5&&ctx.fontKerning==='none'&&rejected)document.body.style.background='#5645d4';
document.body.onclick=()=>{ctx.font={toString(){canvas.height=canvas.height;return '48px Inter'}};if(ctx.font==='48px Inter'&&ctx.fontKerning==='auto'&&ctx.measureText('AVATAR').width>wide)document.body.style.background='#1f9d4c'};
</script>`
  const { host, saves, kit } = await openInKitFrame(page, baseURL!, 'TextCoercion.html', Buffer.from(html), {}, { persist: true })
  try {
    const source = kit.getByTestId('html-source')
    await expect(source).toHaveValue(html, { timeout: 60_000 })
    const preview = kit.getByTestId('html-preview').locator('canvas').first()
    const color = () => preview.evaluate((element) => {
      const canvas = element as HTMLCanvasElement
      return Array.from(canvas.getContext('2d')!.getImageData(Math.floor(canvas.width / 2), Math.floor(canvas.height / 2), 1, 1).data)
    })
    await expect.poll(color, { timeout: 60_000 }).toEqual([86, 69, 212, 255])
    await preview.click()
    await expect.poll(color).toEqual([31, 157, 76, 255])
    await expect(source).toHaveValue(html)
    await expect(kit.getByTestId('html-unsaved')).toHaveCount(0)
    await source.fill(`${html}\n`)
    await kit.getByTestId('html-save').click()
    await expect.poll(() => saves.at(-1)?.bytes.toString()).toBe(`${html}\n`)
    await expect(kit.getByTestId('html-diagnostics')).toHaveText('No rendering diagnostics')
  } finally {
    await host.dispose()
  }
})

test('converts Canvas text method arguments in the Worker and saves only the source', async ({ page, baseURL }) => {
  test.setTimeout(120_000)
  const html = `<!doctype html><style>html,body{margin:0;width:100%;height:100%;background:red}canvas{display:block}</style><canvas id="art" width="240" height="100"></canvas><script>
const canvas=document.getElementById('art'),ctx=canvas.getContext('2d');
ctx.font='32px Inter';const wide=ctx.measureText('Canvas').width;
const reset=ctx.measureText({toString(){canvas.width=canvas.width;return 'Canvas'}}).width;
let errors=0;for(const action of [()=>ctx.measureText(),()=>ctx.fillText('A'),()=>ctx.strokeText(Symbol('text'),0,40),()=>ctx.fillText('A',1n,40)])try{action()}catch(e){if(e instanceof TypeError)errors++}
if(reset<wide/2&&ctx.font==='10px sans-serif'&&errors===4)document.body.style.background='#5645d4';
document.body.onclick=()=>{ctx.font='32px Inter';ctx.fillStyle='#5645d4';ctx.fillText('Canvas',{valueOf(){canvas.width=canvas.width;return 8}},48);const data=ctx.getImageData(0,0,240,100).data;let black=0,purple=0;for(let i=0;i<data.length;i+=4)if(data[i+3]){if(data[i]===0&&data[i+1]===0&&data[i+2]===0)black++;if(data[i]===86&&data[i+1]===69&&data[i+2]===212)purple++}if(black>10&&purple===0)document.body.style.background='#1f9d4c'};
</script>`
  const { host, saves, kit } = await openInKitFrame(page, baseURL!, 'TextArguments.html', Buffer.from(html), {}, { persist: true })
  try {
    const source = kit.getByTestId('html-source')
    await expect(source).toHaveValue(html, { timeout: 60_000 })
    const preview = kit.getByTestId('html-preview').locator('canvas').first()
    const color = () => preview.evaluate((element) => {
      const canvas = element as HTMLCanvasElement
      return Array.from(canvas.getContext('2d')!.getImageData(Math.floor(canvas.width / 2), Math.floor(canvas.height / 2), 1, 1).data)
    })
    await expect.poll(color, { timeout: 60_000 }).toEqual([86, 69, 212, 255])
    await preview.click()
    await expect.poll(color).toEqual([31, 157, 76, 255])
    await expect(source).toHaveValue(html)
    await expect(kit.getByTestId('html-unsaved')).toHaveCount(0)
    await source.fill(`${html}\n`)
    await kit.getByTestId('html-save').click()
    await expect.poll(() => saves.at(-1)?.bytes.toString()).toBe(`${html}\n`)
    await expect(kit.getByTestId('html-diagnostics')).toHaveText('No rendering diagnostics')
  } finally {
    await host.dispose()
  }
})

test('converts Canvas rectangle and transform arguments in the Worker and saves only the source', async ({ page, baseURL }) => {
  test.setTimeout(120_000)
  const html = `<!doctype html><style>html,body{margin:0;width:100%;height:100%;background:red}canvas{display:block}</style><canvas id="art" width="240" height="100"></canvas><script>
const canvas=document.getElementById('art'),ctx=canvas.getContext('2d');
ctx.fillStyle='#5645d4';ctx.translate(40,30);ctx.fillRect({valueOf(){canvas.width=canvas.width;return 8}},8,24,24);
let errors=0;for(const action of [()=>ctx.fillRect(),()=>ctx.clearRect(1n,0,8,8),()=>ctx.transform(1,0)])try{action()}catch(e){if(e instanceof TypeError)errors++}
if(errors===3&&ctx.getImageData(16,16,1,1).data.join(',')==='0,0,0,255')document.body.style.background='#5645d4';
document.body.onclick=()=>{ctx.translate({valueOf(){canvas.width=canvas.width;return 24}},16);let calls=0;ctx.transform=()=>calls++;ctx.scale(2,2);ctx.fillRect(0,0,16,16);const m=ctx.getTransform();if(calls===0&&m.a===2&&m.d===2&&m.e===24&&m.f===16&&ctx.getImageData(32,24,1,1).data.join(',')==='0,0,0,255')document.body.style.background='#1f9d4c'};
</script>`
  const { host, saves, kit } = await openInKitFrame(page, baseURL!, 'NumericCanvas.html', Buffer.from(html), {}, { persist: true })
  try {
    const source = kit.getByTestId('html-source')
    await expect(source).toHaveValue(html, { timeout: 60_000 })
    const preview = kit.getByTestId('html-preview').locator('canvas').first()
    const color = () => preview.evaluate((element) => {
      const canvas = element as HTMLCanvasElement
      return Array.from(canvas.getContext('2d')!.getImageData(Math.floor(canvas.width / 2), Math.floor(canvas.height / 2), 1, 1).data)
    })
    await expect.poll(color, { timeout: 60_000 }).toEqual([86, 69, 212, 255])
    await preview.click()
    await expect.poll(color).toEqual([31, 157, 76, 255])
    await expect(source).toHaveValue(html)
    await expect(kit.getByTestId('html-unsaved')).toHaveCount(0)
    await source.fill(`${html}\n`)
    await kit.getByTestId('html-save').click()
    await expect.poll(() => saves.at(-1)?.bytes.toString()).toBe(`${html}\n`)
    await expect(kit.getByTestId('html-diagnostics')).toHaveText('No rendering diagnostics')
  } finally {
    await host.dispose()
  }
})

test('converts Canvas numeric state and dash sequences in the Worker and saves only the source', async ({ page, baseURL }) => {
  test.setTimeout(120_000)
  const html = `<!doctype html><style>html,body{margin:0;width:100%;height:100%;background:red}canvas{display:block}</style><canvas id="art" width="240" height="100"></canvas><script>
const canvas=document.getElementById('art'),ctx=canvas.getContext('2d');
ctx.globalAlpha=0.5;ctx.lineWidth=8;
let errors=0;for(const action of [()=>ctx.globalAlpha=1n,()=>ctx.lineWidth=1n,()=>ctx.setLineDash({0:2,length:1})])try{action()}catch(e){if(e instanceof TypeError)errors++}
if(errors===3&&ctx.globalAlpha===0.5&&ctx.lineWidth===8)document.body.style.background='#5645d4';
document.body.onclick=()=>{const seen=[];ctx.setLineDash({[Symbol.iterator](){let i=0;return {next(){seen.push('next'+i);if(i===2)return {done:true};const n=++i;return {done:false,value:{valueOf(){seen.push('value'+n);if(n===1)canvas.width=canvas.width;return n*2}}}}}}});if(seen.join(',')==='next0,value1,next1,value2,next2'&&ctx.getLineDash().join(',')==='2,4'&&ctx.globalAlpha===1&&ctx.lineWidth===1)document.body.style.background='#1f9d4c'};
</script>`
  const { host, saves, kit } = await openInKitFrame(page, baseURL!, 'StateCanvas.html', Buffer.from(html), {}, { persist: true })
  try {
    const source = kit.getByTestId('html-source')
    await expect(source).toHaveValue(html, { timeout: 60_000 })
    const preview = kit.getByTestId('html-preview').locator('canvas').first()
    const color = () => preview.evaluate((element) => {
      const canvas = element as HTMLCanvasElement
      return Array.from(canvas.getContext('2d')!.getImageData(Math.floor(canvas.width / 2), Math.floor(canvas.height / 2), 1, 1).data)
    })
    await expect.poll(color, { timeout: 60_000 }).toEqual([86, 69, 212, 255])
    await preview.click()
    await expect.poll(color).toEqual([31, 157, 76, 255])
    await expect(source).toHaveValue(html)
    await expect(kit.getByTestId('html-unsaved')).toHaveCount(0)
    await source.fill(`${html}\n`)
    await kit.getByTestId('html-save').click()
    await expect.poll(() => saves.at(-1)?.bytes.toString()).toBe(`${html}\n`)
    await expect(kit.getByTestId('html-diagnostics')).toHaveText('No rendering diagnostics')
  } finally {
    await host.dispose()
  }
})
