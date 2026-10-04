/*
 * Icon generator — pure Node (zlib only, no native deps, no image libraries).
 * Draws the Walkie mic mark with SDF shapes and writes PNGs (RGBA).
 *
 *   node scripts/gen-icons.mjs
 *
 * Outputs into public/: icon-192.png, icon-512.png (purpose any) and
 * icon-maskable-512.png (purpose maskable).
 */
import { deflateSync } from 'node:zlib'
import { writeFileSync, mkdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const OUT = join(dirname(fileURLToPath(import.meta.url)), '..', 'public')

// ---- palette (matches the design tokens) ----------------------------------
const BG = [244, 246, 250] // #F4F6FA
const RED = [240, 68, 77] // #F0444D
const WHITE = [255, 255, 255]

// ---- tiny PNG encoder ------------------------------------------------------
const CRC_TABLE = (() => {
  const t = new Uint32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    t[n] = c >>> 0
  }
  return t
})()
function crc32(buf) {
  let c = 0xffffffff
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}
function chunk(type, data) {
  const len = Buffer.alloc(4)
  len.writeUInt32BE(data.length)
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data])
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(body))
  return Buffer.concat([len, body, crc])
}
function encodePNG(width, height, rgba) {
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(width, 0)
  ihdr.writeUInt32BE(height, 4)
  ihdr[8] = 8 // bit depth
  ihdr[9] = 6 // color type RGBA
  const raw = Buffer.alloc((width * 4 + 1) * height)
  for (let y = 0; y < height; y++) {
    raw[y * (width * 4 + 1)] = 0 // filter: none
    rgba.copy(raw, y * (width * 4 + 1) + 1, y * width * 4, (y + 1) * width * 4)
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ])
}

// ---- SDF primitives (in 512-viewBox units) ---------------------------------
const sub = (x, y, cx, cy) => [x - cx, y - cy]
const len = (x, y) => Math.hypot(x, y)
const clamp = (v, a, b) => Math.min(b, Math.max(a, v))
// signed distance, negative inside
function sdRoundedRect(x, y, cx, cy, hw, hh, r) {
  const [qx, qy] = [Math.abs(x - cx) - (hw - r), Math.abs(y - cy) - (hh - r)]
  const ox = Math.max(qx, 0)
  const oy = Math.max(qy, 0)
  return len(ox, oy) + Math.min(Math.max(qx, qy), 0) - r
}
const sdCircle = (x, y, cx, cy, r) => len(x - cx, y - cy) - r
const sdRing = (x, y, cx, cy, r, w) => Math.abs(len(x - cx, y - cy) - r) - w / 2
function sdSegment(x, y, ax, ay, bx, by, w) {
  const [px, py] = sub(x, y, ax, ay)
  const [qx, qy] = sub(bx, by, ax, ay)
  const t = clamp((px * qx + py * qy) / (qx * qx + qy * qy), 0, 1)
  return len(px - qx * t, py - qy * t) - w / 2
}
// coverage from SDF with ~1px anti-aliasing
const cover = (d) => clamp(0.5 - d, 0, 1)

/** The mic glyph: capsule body, cradle arc, stem. white on whatever is below. */
function drawGlyph(blend, x, y, s = 1) {
  // coordinates are pre-scale 512-box units; s shrinks toward the center
  const gx = 256 + (x - 256) / s
  const gy = 256 + (y - 256) / s
  const dBody = sdRoundedRect(gx, gy, 256, 216, 40, 76, 40)
  const dArc = sdRing(gx, gy, 256, 272, 70, 26) * (gy >= 272 ? 1 : 1e6) // lower half only
  const dStem = sdSegment(gx, gy, 256, 342, 256, 380, 26)
  const cov = cover(Math.min(dBody, dArc, dStem))
  blend(WHITE, cov)
}

/** Render one icon at `size` px. maskable = full-bleed red, glyph in safe zone. */
function render(size, maskable) {
  const S = maskable ? 3 : 2 // supersample factor
  const N = size * S // working resolution
  const scale = 512 / size // px per viewBox unit
  const img = Buffer.alloc(size * size * 4)
  for (let py = 0; py < size; py++) {
    for (let px = 0; px < size; px++) {
      let r = 0
      let g = 0
      let b = 0
      let a = 0
      for (let sy = 0; sy < S; sy++) {
        for (let sx = 0; sx < S; sx++) {
          const x = (px * S + sx + 0.5) * scale / S
          const y = (py * S + sy + 0.5) * scale / S
          // blend(target, alpha) in 512-viewBox space
          let cr = 0
          let cg = 0
          let cb = 0
          let ca = 0
          if (maskable) {
            ;[cr, cg, cb] = RED
            ca = 1
            // glyph at 62% (matches the SVG maskable transform)
            const gx = 256 + (x - 256) / 0.62
            const gy = 256 + (y - 256) / 0.62
            const dBody = sdRoundedRect(gx, gy, 256, 216, 40, 76, 40)
            const dArc = gy >= 272 ? sdRing(gx, gy, 256, 272, 70, 26) : 1e6
            const dStem = sdSegment(gx, gy, 256, 342, 256, 380, 26)
            const cov = cover(Math.min(dBody, dArc, dStem))
            cr = cr * (1 - cov) + WHITE[0] * cov
            cg = cg * (1 - cov) + WHITE[1] * cov
            cb = cb * (1 - cov) + WHITE[2] * cov
          } else {
            const dTile = sdRoundedRect(x, y, 256, 256, 256, 256, 112)
            const tile = cover(dTile)
            if (tile > 0) {
              ;[cr, cg, cb] = BG
              ca = tile
              const circ = cover(sdCircle(x, y, 256, 256, 150))
              if (circ > 0) {
                cr = cr * (1 - circ) + RED[0] * circ
                cg = cg * (1 - circ) + RED[1] * circ
                cb = cb * (1 - circ) + RED[2] * circ
              }
              // glyph on top
              const dBody = sdRoundedRect(x, y, 256, 216, 40, 76, 40)
              const dArc = y >= 272 ? sdRing(x, y, 256, 272, 70, 26) : 1e6
              const dStem = sdSegment(x, y, 256, 342, 256, 380, 26)
              const cov = cover(Math.min(dBody, dArc, dStem)) * tile
              cr = cr * (1 - cov) + WHITE[0] * cov
              cg = cg * (1 - cov) + WHITE[1] * cov
              cb = cb * (1 - cov) + WHITE[2] * cov
            }
          }
          // straight-alpha accumulate
          r += cr * ca
          g += cg * ca
          b += cb * ca
          a += ca
        }
      }
      const n = S * S
      const i = (py * size + px) * 4
      img[i] = a > 0 ? Math.round(r / a) : 0
      img[i + 1] = a > 0 ? Math.round(g / a) : 0
      img[i + 2] = a > 0 ? Math.round(b / a) : 0
      img[i + 3] = Math.round((a / n) * 255)
    }
  }
  return encodePNG(size, size, img)
}

mkdirSync(OUT, { recursive: true })
for (const [name, size, maskable] of [
  ['icon-192.png', 192, false],
  ['icon-512.png', 512, false],
  ['icon-maskable-512.png', 512, true],
]) {
  const png = render(size, maskable)
  writeFileSync(join(OUT, name), png)
  console.log(`wrote ${name} (${png.length} bytes)`)
}
console.log('done — note: drawGlyph kept for reference; render() inlines the SDFs')
