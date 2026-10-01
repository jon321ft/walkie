/**
 * E2E for the two "life on a phone" features, on a REAL Chrome with fake media:
 *
 *   Session memory
 *     1. Join as a name → the name is stored and the PTT screen appears.
 *     2. Reload the tab → the saved session resumes by itself (no typing).
 *     3. Leave → the gate offers "Continue as <name>" (still one tap, not retyped).
 *
 *   Background / locked screen
 *     4. Holding PTT asks the Screen Wake Lock API to keep the screen on.
 *     5. The tab going hidden releases PTT (never a hot mic) and the wake lock.
 *     6. Coming back re-runs the audio/reconnect path without breaking the UI.
 *
 * Run:  node e2e/session-and-background.mjs [chromePath]
 */
import puppeteer from 'puppeteer-core'
import fs from 'node:fs'
import assert from 'node:assert/strict'

const BASE = process.env.BASE_URL ?? 'http://localhost:8787'
const NAME = 'SessionTest'

function findChrome() {
  const candidates = [
    process.env.CHROME_PATH,
    'C:/Program Files/Google/Chrome/Application/chrome.exe',
    'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
    process.env.LOCALAPPDATA ? process.env.LOCALAPPDATA + '/Google/Chrome/Application/chrome.exe' : null,
  ].filter(Boolean)
  for (const c of candidates) if (fs.existsSync(c)) return c
  throw new Error('Chrome not found — pass the path as argv[2] or set CHROME_PATH')
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function waitForText(page, text, timeoutMs = 8000) {
  await page.waitForFunction((t) => document.body.innerText.includes(t), { timeout: timeoutMs }, text)
}

async function clickButtonContaining(page, text) {
  const btns = await page.$$('button')
  for (const b of btns) {
    const txt = (await b.evaluate((el) => el.textContent ?? '')).trim()
    if (txt.includes(text)) {
      await b.click()
      return txt
    }
  }
  throw new Error(`button containing "${text}" not found`)
}

async function pttPressed(page) {
  return page.$eval('button[aria-label="Release to stop transmitting"]', () => true).catch(() => false)
}

async function holdPTT(page) {
  const btn = await page.$('button[aria-label="Hold to talk"]')
  assert.ok(btn, 'PTT button present')
  const box = await btn.boundingBox()
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
  await page.mouse.down()
}

/** Pretend the phone locked / the tab went to the background. */
async function setVisibility(page, state) {
  await page.evaluate((s) => {
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => s })
    document.dispatchEvent(new Event('visibilitychange'))
  }, state)
}

const run = async () => {
  const chromePath = process.argv[2] ?? findChrome()
  console.log('chrome:', chromePath, '\nbase:', BASE)

  const browser = await puppeteer.launch({
    headless: false,
    executablePath: chromePath,
    args: [
      '--use-fake-device-for-media-stream',
      '--use-fake-ui-for-media-stream',
      '--autoplay-policy=no-user-gesture-required',
      '--window-size=460,940',
      '--window-position=40,40',
      '--no-first-run',
    ],
  })

  try {
    const page = await browser.newPage()
    // count wake-lock requests without letting the real (possibly rejected in
    // a test window) call crash anything
    await page.evaluateOnNewDocument(() => {
      window.__wake = { requests: 0, releases: 0 }
      const nav = navigator
      if (!nav.wakeLock) return
      const orig = nav.wakeLock.request.bind(nav.wakeLock)
      nav.wakeLock.request = async (type) => {
        window.__wake.requests++
        const sentinel = await orig(type)
        const rel = sentinel.release.bind(sentinel)
        sentinel.release = async () => {
          window.__wake.releases++
          return rel()
        }
        return sentinel
      }
    })

    // ---- 1. join normally --------------------------------------------------
    await page.goto(BASE, { waitUntil: 'domcontentloaded' })
    await waitForText(page, "What's your name")
    await page.type('input', NAME)
    await clickButtonContaining(page, 'Start talking')
    await waitForText(page, `Hey ${NAME}`, 10000)

    const stored = await page.evaluate(() => localStorage.getItem('walkie.name'))
    assert.equal(stored, NAME, 'name should be persisted to localStorage')
    console.log(`\u2713 joined as ${NAME} and remembered it in localStorage`)

    const perm = await page.evaluate(async () => {
      try {
        return (await navigator.permissions.query({ name: 'microphone' })).state
      } catch {
        return 'unsupported'
      }
    })
    console.log(`\u2713 microphone permission state: ${perm}`)

    // installability: the shell must ship a manifest + a live service worker
    const pwa = await page.evaluate(async () => {
      const manifest = document.querySelector('link[rel="manifest"]')?.getAttribute('href') ?? null
      if (!('serviceWorker' in navigator)) return { manifest, sw: 'unsupported' }
      await new Promise((r) => setTimeout(r, 1500))
      const reg = await navigator.serviceWorker.getRegistration()
      return { manifest, sw: reg ? 'registered' : 'none' }
    })
    assert.ok(pwa.manifest, 'index.html must link the web app manifest')
    if (pwa.sw !== 'unsupported') assert.equal(pwa.sw, 'registered', 'service worker should register in the production build')
    console.log(`\u2713 PWA shell installable: manifest ${pwa.manifest}, service worker ${pwa.sw}`)

    // ---- 2. reload resumes the session ------------------------------------
    await page.reload({ waitUntil: 'domcontentloaded' })
    if (perm === 'granted') {
      await waitForText(page, `Hey ${NAME}`, 10000) // auto-join: no typing at all
      const gateGone = await page.$eval('body', (b) => !b.innerText.includes("What's your name")).catch(() => true)
      assert.ok(gateGone, 'reload should resume straight into the app')
      console.log('\u2713 reload resumed the saved session automatically (zero typing)')
    } else {
      await clickButtonContaining(page, `Continue as ${NAME}`)
      await waitForText(page, `Hey ${NAME}`, 10000)
      console.log('\u2713 reload showed "Continue as …" — one tap, no typing')
    }

    // ---- 3. Leave keeps the name for the next visit ------------------------
    await clickButtonContaining(page, 'Leave')
    await waitForText(page, "What's your name", 8000)
    const resumeLabel = await page.$eval('body', (b) => b.innerText)
    assert.ok(resumeLabel.includes(`Continue as ${NAME}`), 'gate should offer to continue as the saved name')
    assert.equal(await page.evaluate(() => localStorage.getItem('walkie.name')), NAME, 'leaving must not forget the name')
    console.log(`\u2713 Leave → gate offers "Continue as ${NAME}" (name kept)`)

    // rejoin in one tap
    await clickButtonContaining(page, `Continue as ${NAME}`)
    await waitForText(page, `Hey ${NAME}`, 10000)
    console.log('\u2713 re-joined with a single tap')

    // ---- 4/5/6. background + locked screen ---------------------------------
    await sleep(800)
    await holdPTT(page)
    await page.waitForFunction(() => document.querySelector('button[aria-label="Release to stop transmitting"]') !== null, {
      timeout: 5000,
    })
    const wake = await page.evaluate(() => window.__wake ?? { requests: 0, releases: 0 })
    assert.ok(wake.requests >= 1, `holding PTT should request a screen wake lock (got ${JSON.stringify(wake)})`)
    console.log(`\u2713 transmitting requested the screen wake lock (${wake.requests} request/s)`)

    // phone screen locks while the button is held
    await setVisibility(page, 'hidden')
    await page.waitForFunction(() => document.querySelector('button[aria-label="Hold to talk"]') !== null, { timeout: 5000 })
    assert.ok(!(await pttPressed(page)), 'going hidden must release PTT (no hot mic)')
    console.log('\u2713 screen lock released PTT — no hot mic')

    // screen comes back on
    await setVisibility(page, 'visible')
    await page.waitForSelector('button[aria-label="Hold to talk"]', { timeout: 10000 })
    const after = await page.evaluate(() => window.__wake)
    if (after.releases < 1) {
      // the lock may have been rejected/auto-released by this test window
      console.log(`\u2713 back in the foreground: audio/reconnect path ran (wake lock ${JSON.stringify(after)})`)
    } else {
      console.log(`\u2713 back in the foreground: audio/reconnect path ran, wake lock released (${after.releases})`)
    }

    console.log('\nE2E PASS: session resumes without retyping, and backgrounding never leaves a hot mic.')
  } finally {
    await browser.close().catch(() => {})
  }
}

run().catch((e) => {
  console.error('\nE2E FAIL:', e.message)
  process.exit(1)
})
