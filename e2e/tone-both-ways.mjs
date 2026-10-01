/**
 * E2E with a REAL Chrome and FAKE media ("--use-fake-device-for-media-stream"
 * serves an animated tone instead of the mic) — so getUserMedia and every
 * permission path are the browser's real ones, while the "voice" is a
 * machine-generated tone we can assert on via getStats audioLevel.
 *
 * What it proves (nothing shimmed in-page):
 *   1. Both browsers capture mic, connect WS, become peers.
 *   2. WebRTC connects, RTP flows both directions.
 *   3. Receiver's inbound-rtp.audioLevel rises above 0.01 while the other
 *      side holds the mic button (real PTT press via puppeteer mouse),
 *   4. and falls back to ~0 on release.
 *
 * Run:  node e2e/tone-both-ways.mjs [chromePath]
 */
import puppeteer from 'puppeteer-core'
import fs from 'node:fs'
import assert from 'node:assert/strict'

const BASE = process.env.BASE_URL ?? 'http://localhost:8787'

function findChrome() {
  const candidates = [
    process.env.CHROME_PATH,
    'C:/Program Files/Google/Chrome/Application/chrome.exe',
    'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
    process.env.LOCALAPPDATA ? process.env.LOCALAPPDATA + '/Google/Chrome/Application/chrome.exe' : null,
  ].filter(Boolean)
  for (const c of candidates) {
    if (fs.existsSync(c)) return c
  }
  throw new Error('Chrome not found — pass the path as argv[2] or set CHROME_PATH')
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// Stats are read in-page, filtered to our test pair by peer NAME via
// window.__peerNames — other humans (real mics) may share the room and their
// ambient audio would contaminate a poll-all snapshot.
async function statsSnapshot(page, peerName) {
  return page.evaluate(async (name) => {
    const names = window.__peerNames ?? {}
    const out = { bytes: 0, level: -1, matched: 0 }
    for (const [id, pc] of Object.entries(window.__pcs ?? {})) {
      if (names[id] !== name) continue
      out.matched++
      const stats = await pc.getStats()
      stats.forEach((r) => {
        if (r.type === 'inbound-rtp' && r.kind === 'audio') {
          out.bytes = Math.max(out.bytes, r.bytesReceived ?? 0)
          const al = typeof r.audioLevel === 'number' ? r.audioLevel : -1
          out.level = Math.max(out.level, al)
        }
      })
    }
    return out
  }, peerName)
}

async function levelAbove(page, peerName, threshold, timeoutMs) {
  const t0 = Date.now()
  let last = null
  while (Date.now() - t0 < timeoutMs) {
    last = await statsSnapshot(page, peerName)
    if (last.level > threshold) return { ok: true, ...last }
    await sleep(250)
  }
  return { ok: false, last }
}

async function levelBelow(page, peerName, threshold, timeoutMs) {
  const t0 = Date.now()
  let last = null
  while (Date.now() - t0 < timeoutMs) {
    last = await statsSnapshot(page, peerName)
    if (last.level >= 0 && last.level < threshold) return { ok: true, ...last }
    await sleep(250)
  }
  return { ok: false, last }
}

async function clickButtonWithText(page, text) {
  const btns = await page.$$('button')
  for (const b of btns) {
    const txt = (await b.evaluate((el) => el.textContent)).trim()
    if (txt === text) {
      await b.click()
      return
    }
  }
  throw new Error(`button "${text}" not found`)
}

async function holdPTT(page) {
  const btn = await page.$('button[aria-label="Hold to talk"]')
  assert.ok(btn, 'PTT button present and enabled')
  const box = await btn.boundingBox()
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
  await page.mouse.down()
}

async function releasePTT(page) {
  await page.mouse.up()
}

async function waitForText(page, text, timeoutMs = 8000) {
  await page.waitForFunction((t) => document.body.innerText.includes(t), { timeout: timeoutMs }, text)
}

const run = async () => {
  const chromePath = process.argv[2] ?? findChrome()
  console.log('chrome:', chromePath)

  const commonArgs = [
    '--use-fake-device-for-media-stream', // fake mic = animated tone
    '--use-fake-ui-for-media-stream', // auto-grant permission (still the REAL pipeline)
    '--autoplay-policy=no-user-gesture-required',
    '--no-first-run',
  ]

  const browserA = await puppeteer.launch({
    headless: false,
    executablePath: chromePath,
    args: [...commonArgs, '--window-size=460,940', '--window-position=40,40'],
  })
  const browserP = await puppeteer.launch({
    headless: false,
    executablePath: chromePath,
    args: [...commonArgs, '--window-size=460,940', '--window-position=520,40'],
  })

  try {
    // ---- join with the real UI ----
    const A = await browserA.newPage()
    const P = await browserP.newPage()
    await A.goto(BASE, { waitUntil: 'domcontentloaded' })
    await P.goto(BASE, { waitUntil: 'domcontentloaded' })
    await A.type('input', 'Anna')
    await P.type('input', 'Piotr')
    await clickButtonWithText(A, 'Start talking')
    await clickButtonWithText(P, 'Start talking')

    await waitForText(A, 'Anna')
    await waitForText(P, 'Piotr')
    await waitForText(A, 'Piotr', 10000)
    await waitForText(P, 'Anna', 10000)
    console.log('✓ both joined, each sees the other in the roster')

    // let WebRTC connect
    await waitForText(A, 'Hold to talk to everyone', 15000)
    await waitForText(P, 'Hold to talk to everyone', 15000)
    console.log('✓ PTT enabled on both (peer connected)')

    // ---- Piotr transmits, Anna receives ----
    console.log('— Piotr holds PTT…')
    await holdPTT(P)
    const s1 = await levelAbove(A, 'Piotr', 0.01, 8000)
    assert.ok(s1.ok, `Anna should hear Piotr (audioLevel > 0.01), last snapshot: ${JSON.stringify(s1.last)}`)
    console.log(`✓ Anna receives Piotr: audioLevel=${s1.level.toFixed(3)} rx=${s1.bytes}B`)

    await releasePTT(P)
    const s2 = await levelBelow(A, 'Piotr', 0.01, 8000)
    assert.ok(s2.ok, `Anna should stop hearing Piotr after release, last: ${JSON.stringify(s2.last)}`)
    console.log(`✓ Anna hears silence after release: audioLevel=${s2.level.toFixed(3)}`)

    // ---- Anna transmits, Piotr receives ----
    console.log('— Anna holds PTT…')
    await holdPTT(A)
    const s3 = await levelAbove(P, 'Anna', 0.01, 8000)
    assert.ok(s3.ok, `Piotr should hear Anna (audioLevel > 0.01), last: ${JSON.stringify(s3.last)}`)
    console.log(`✓ Piotr receives Anna: audioLevel=${s3.level.toFixed(3)} rx=${s3.bytes}B`)
    await releasePTT(A)
    const s4 = await levelBelow(P, 'Anna', 0.01, 8000)
    assert.ok(s4.ok, `Piotr should stop hearing Anna after release, last: ${JSON.stringify(s4.last)}`)
    console.log(`✓ Piotr hears silence after release: audioLevel=${s4.level.toFixed(3)}`)

    console.log('\nE2E PASS: real Chrome → real getUserMedia → real PTT clicks → audible tone both directions.')
  } finally {
    await browserA.close().catch(() => {})
    await browserP.close().catch(() => {})
  }
}

run().catch((e) => {
  console.error('\nE2E FAIL:', e.message)
  process.exit(1)
})
