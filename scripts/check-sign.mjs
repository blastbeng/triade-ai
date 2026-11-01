// Verifica che l'eseguibile Windows abbia davvero una firma Authenticode,
// leggendo la directory certificato del PE (nessuna dipendenza esterna).
import fs from 'node:fs'
import path from 'node:path'

const dist = path.join(process.cwd(), 'dist')
const exe = fs.existsSync(path.join(dist, 'TriadeAI.exe'))
  ? path.join(dist, 'TriadeAI.exe')
  : fs
      .readdirSync(dist)
      .filter((f) => /\.exe$/i.test(f))
      .map((f) => path.join(dist, f))[0]

if (!exe) {
  console.error('[check-sign] nessun eseguibile in dist/')
  process.exit(1)
}

const fd = fs.openSync(exe, 'r')
const head = Buffer.alloc(4096)
fs.readSync(fd, head, 0, 4096, 0)
fs.closeSync(fd)

const pe = head.readUInt32LE(0x3c)
if (head.toString('latin1', pe, pe + 4) !== 'PE\0\0') {
  console.error('[check-sign] non è un PE valido')
  process.exit(1)
}
const opt = pe + 24
const magic = head.readUInt16LE(opt)
const dirBase = opt + (magic === 0x20b ? 0x70 : 0x60)
const certSize = head.readUInt32LE(dirBase + 4 * 8 + 4)

console.log(`[check-sign] ${path.basename(exe)}: certificato ${certSize} byte`)
if (certSize === 0) {
  console.error('[check-sign] ARTEFATTO NON FIRMATO: la release non deve essere pubblicata')
  process.exit(1)
}
console.log('[check-sign] firma presente: OK')
