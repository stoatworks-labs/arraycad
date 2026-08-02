/**
 * Take the documentation screenshots, from the real application.
 *
 *   npm run dev            # in another shell, on 5182
 *   node scripts/shoot.mjs [--url http://localhost:5182] [--out docs/screenshots]
 *
 * Headless Chrome over CDP, same shape as simpleRTA's. Nothing is composited or
 * mocked: a real venue file is dropped into the running app and the frame is
 * captured. What is in the PNG is what the app drew.
 *
 * Two things make this less obvious than "load a page and screenshot it":
 *
 *  - **The app's only input is a dropped file**, and a DataTransfer cannot be
 *    synthesised from outside the page. So the fixture is fetched by the page
 *    itself from the dev server and dispatched as a real `drop` event. That is
 *    also why this needs `npm run dev` rather than the deployed site: the
 *    deployed site does not serve `test/fixtures/`.
 *
 *  - **The viewport is WebGL**, so the shot has to wait for three.js to have
 *    drawn at least one frame, not merely for React to have mounted. Waiting on
 *    the canvas existing is not enough — it exists before anything is in it.
 */
import { spawn } from 'node:child_process'
import { mkdir, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
const PORT = '9225' // not 9222/9223 (video pipeline) and not 9224 (simpleRTA)
const WIDTH = 1920
const HEIGHT = 1080

function opt(name, fallback) {
  const at = process.argv.indexOf(`--${name}`)
  return at === -1 ? fallback : process.argv[at + 1]
}

const URL_ = opt('url', 'http://localhost:5182')
const OUT = opt('out', 'docs/screenshots')

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/** Minimal CDP client over the WebSocket the browser advertises. */
async function connect() {
  const targets = await (await fetch(`http://127.0.0.1:${PORT}/json`)).json()
  const page = targets.find((t) => t.type === 'page' && t.url.includes(new URL(URL_).host))
  if (!page) throw new Error('no page target matching the app URL')

  const ws = new WebSocket(page.webSocketDebuggerUrl)
  await new Promise((res, rej) => {
    ws.addEventListener('open', res, { once: true })
    ws.addEventListener('error', rej, { once: true })
  })

  let id = 0
  const pending = new Map()
  ws.addEventListener('message', (e) => {
    const msg = JSON.parse(e.data)
    const waiter = pending.get(msg.id)
    if (!waiter) return
    pending.delete(msg.id)
    if (msg.error) waiter.reject(new Error(JSON.stringify(msg.error)))
    else waiter.resolve(msg.result)
  })

  const send = (method, params = {}) =>
    new Promise((resolve, reject) => {
      const mid = ++id
      pending.set(mid, { resolve, reject })
      ws.send(JSON.stringify({ id: mid, method, params }))
    })

  return { send, close: () => ws.close() }
}

const evaluate = async (send, expression) => {
  const { result, exceptionDetails } = await send('Runtime.evaluate', {
    expression,
    awaitPromise: true,
    returnByValue: true,
  })
  if (exceptionDetails) throw new Error(exceptionDetails.text ?? 'evaluate failed')
  return result.value
}

/**
 * Poll @p expression until it is truthy.
 *
 * A page target exists from navigation commit, not from load, so connecting
 * successfully says nothing about whether the application is there yet.
 */
async function waitFor(send, expression, what, timeout = 30000) {
  const deadline = Date.now() + timeout
  for (;;) {
    try {
      if (await evaluate(send, expression)) return
    } catch {
      /* the document may still be swapping under us */
    }
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`)
    await sleep(200)
  }
}

/** A real gesture at the centre of the button whose visible text is @p label. */
async function clickText(send, label) {
  const found = await evaluate(
    send,
    `(() => { const b = [...document.querySelectorAll('button')]
        .find(el => el.textContent.trim() === ${JSON.stringify(label)});
      if (!b) return null;
      const r = b.getBoundingClientRect();
      return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()`,
  )
  if (!found) throw new Error(`no button labelled ${label}`)
  const common = { x: found.x, y: found.y, button: 'left', clickCount: 1 }
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', ...common })
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', ...common })
  await sleep(400)
}

/** Click a row in the object tree by the name it shows. */
async function clickTreeRow(send, prefix) {
  const found = await evaluate(
    send,
    `(() => { const r = [...document.querySelectorAll('.tree-row')]
        .find(el => el.innerText.trim().startsWith(${JSON.stringify(prefix)}));
      if (!r) return null;
      const b = r.getBoundingClientRect();
      return { x: b.left + b.width * 0.6, y: b.top + b.height / 2 }; })()`,
  )
  if (!found) throw new Error(`no tree row starting ${prefix}`)
  const common = { x: found.x, y: found.y, button: 'left', clickCount: 1 }
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', ...common })
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', ...common })
  await sleep(400)
}

/** Fetch a fixture from the dev server and drop it into the app, as a real event. */
async function dropFixture(send, path, filename) {
  const ok = await evaluate(
    send,
    `(async () => {
      const res = await fetch(${JSON.stringify(path)});
      if (!res.ok) return 'fetch failed: ' + res.status;
      const text = await res.text();
      const dt = new DataTransfer();
      dt.items.add(new File([text], ${JSON.stringify(filename)}, { type: 'application/xml' }));
      const zone = document.querySelector('.dropzone');
      if (!zone) return 'no dropzone';
      zone.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: dt }));
      return true;
    })()`,
  )
  if (ok !== true) throw new Error(`drop failed: ${ok}`)
  // The conversion is debounced, then three.js has to draw. Wait for the stats to
  // report a finished conversion rather than guessing at a delay.
  await waitFor(
    send,
    `(() => { const s = document.querySelector('.stats'); return !!s && !s.innerText.includes('…'); })()`,
    'the conversion to settle',
  )
  await sleep(1200)
}

async function shoot(send, path) {
  const { data } = await send('Page.captureScreenshot', { format: 'png' })
  await writeFile(path, Buffer.from(data, 'base64'))
  console.log(`  ${path}`)
}

async function main() {
  await mkdir(OUT, { recursive: true })
  const profile = join(tmpdir(), `arraycad-shoot-${process.pid}`)

  const chrome = spawn(
    CHROME,
    [
      '--headless=new',
      `--remote-debugging-port=${PORT}`,
      `--user-data-dir=${profile}`,
      `--window-size=${WIDTH},${HEIGHT}`,
      '--hide-scrollbars',
      '--no-first-run',
      '--no-default-browser-check',
      // The viewport is WebGL. Headless Chrome falls back to SwiftShader, which is
      // slow but correct; without this the canvas can come out empty.
      '--enable-unsafe-swiftshader',
      '--disable-background-timer-throttling',
      '--disable-backgrounding-occluded-windows',
      '--disable-renderer-backgrounding',
      URL_,
    ],
    { stdio: 'ignore' },
  )

  let cdp
  try {
    for (let i = 0; i < 60; i++) {
      try {
        cdp = await connect()
        break
      } catch {
        await sleep(250)
      }
    }
    if (!cdp) throw new Error('chrome never came up on the debug port')
    const { send } = cdp

    await send('Page.enable')
    await send('Runtime.enable')
    // Pin the viewport. `--window-size` includes the browser's own chrome even in
    // headless, so it yields 1600x813 rather than the size asked for; the website's
    // thumbnail generator wants a 16:9 source.
    await send('Emulation.setDeviceMetricsOverride', {
      width: WIDTH,
      height: HEIGHT,
      deviceScaleFactor: 1,
      mobile: false,
    })
    await waitFor(send, `!!document.querySelector('.dropzone')`, 'the drop zone')

    // 1 — the empty state, which is the whole of the app's front door
    await sleep(600)
    await shoot(send, join(OUT, 'dropzone.png'))

    // 2 — a real venue loaded, rectangle fit, an object selected so the inspector
    //     shows its plane type. This is the picture of the tool.
    await dropFixture(send, '/test/fixtures/theatre.dbacv', 'theatre.dbacv')
    await clickText(send, 'Rectangle')
    await sleep(1200)
    await clickTreeRow(send, 'STALLS - MAIN 1')
    await shoot(send, join(OUT, 'arraycad.png'))

    // 3 — plan view, where a theatre is unmistakably a theatre
    await clickText(send, 'Plan')
    await sleep(1500)
    await shoot(send, join(OUT, 'plan.png'))

    // 4 — the converted planes alone, without the source geometry over them
    await clickText(send, 'Iso')
    await sleep(800)
    await clickText(send, 'Planes')
    await sleep(1500)
    await shoot(send, join(OUT, 'planes.png'))
  } finally {
    cdp?.close()
    chrome.kill()
    // Chrome is still flushing its profile as it exits, so a removal here races it
    // and throws ENOTEMPTY. Thrown from `finally`, that would replace whatever
    // actually went wrong in the body.
    await sleep(750)
    await rm(profile, { recursive: true, force: true }).catch(() => {})
  }
}

await main()
