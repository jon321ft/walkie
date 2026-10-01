/**
 * Diagnostic: two real browsers, join, wait connected, then dump
 * __meshDebug + transceiver/sender + rtp stats from BOTH sides.
 */
import puppeteer from 'puppeteer-core'
import fs from 'node:fs'

const BASE = process.env.BASE_URL ?? 'http://localhost:8787'
const chromePath = process.argv[2] ?? 'C:/Program Files/Google/Chrome/Application/chrome.exe'
if (!fs.existsSync(chromePath)) throw new Error('chrome not found: ' + chromePath)

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const args = [
  '--use-fake-device-for-media-stream',
  '--use-fake-ui-for-media-stream',
  '--autoplay-policy=no-user-gesture-required',
  '--no-first-run',
]

const browserA = await puppeteer.launch({ headless: false, executablePath: chromePath, args: [...args, '--window-size=460,940', '--window-position=40,40'] })
const browserP = await puppeteer.launch({ headless: false, executablePath: chromePath, args: [...args, '--window-size=460,940', '--window-position=520,40'] })

async function clickButtonWithText(page, text) {
  for (const b of await page.$$('button')) {
    if ((await b.evaluate((el) => el.textContent)).trim() === text) return b.click()
  }
  throw new Error('no button ' + text)
}

try {
  const A = await browserA.newPage()
  const P = await browserP.newPage()
  await A.goto(BASE, { waitUntil: 'networkidle2' })
  await P.goto(BASE, { waitUntil: 'networkidle2' })
  await A.type('input', 'Anna')
  await P.type('input', 'Piotr')
  await clickButtonWithText(A, 'Start talking')
  await clickButtonWithText(P, 'Start talking')
  await A.waitForFunction((t) => document.body.innerText.includes(t), { timeout: 15000 }, 'Hold to talk to everyone')
  await P.waitForFunction((t) => document.body.innerText.includes(t), { timeout: 15000 }, 'Hold to talk to everyone')
  await sleep(1500)

  const dump = (page) =>
    page.evaluate(async () => {
      const pc = Object.values(window.__pcs ?? {})[0]
      if (!pc) return { err: 'no pc' }
      const stats = await pc.getStats()
      const rtp = []
      stats.forEach((r) => {
        if (r.type === 'inbound-rtp' || r.type === 'outbound-rtp')
          rtp.push({ type: r.type, kind: r.kind, bytes: r.bytesSent ?? r.bytesReceived, level: r.audioLevel })
      })
      return {
        dbg: window.__meshDebug,
        conn: pc.connectionState,
        transceivers: pc.getTransceivers().map((t) => ({
          mid: t.mid,
          dir: t.direction,
          curDir: t.currentDirection,
          senderTrack: t.sender.track ? { kind: t.sender.track.kind, enabled: t.sender.track.enabled, muted: t.sender.track.muted, readyState: t.sender.track.readyState } : null,
          recvTrack: t.receiver.track ? { kind: t.receiver.track.kind, muted: t.receiver.track.muted } : null,
        })),
        rtp,
      }
    })

  for (const [name, page] of [['Anna(initiator?)', A], ['Piotr', P]]) {
    const d = await dump(page)
    console.log(`\n===== ${name} =====\n` + JSON.stringify(d, null, 1))
  }
} finally {
  await browserA.close().catch(() => {})
  await browserP.close().catch(() => {})
}
