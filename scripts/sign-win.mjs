#!/usr/bin/env node
/**
 * Firma gli artefatti Windows in dist/.
 *
 * Modalità, in ordine di priorità:
 *  1. certificato reale PFX        → CSC_LINK + CSC_KEY_PASSWORD (jsign)
 *  2. Azure Artifact Signing       → AZURE_SIGNING_* (jsign)
 *  3. certificato self-signed      → generato in build/selfsign/ (default)
 *
 * Self-signed: su Windows usa PowerShell (New-SelfSignedCertificate +
 * Set-AuthenticodeSignature), su Linux usa openssl + osslsigncode.
 * Nota: un certificato self-signed NON è fidato su altre macchine: SmartScreen
 * continuerà ad avvisare. Serve per avere un eseguibile firmato e verificabile.
 */
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'

const dist = path.join(process.cwd(), 'dist')
const certDir = path.join(process.cwd(), 'build', 'selfsign')
const pfx = path.join(certDir, 'triade-selfsigned.pfx')
const cer = path.join(certDir, 'triade-selfsigned.cer')
const password = process.env.SELFSIGN_PASSWORD ?? 'triade-ai'

const files = fs.existsSync(dist)
  ? fs.readdirSync(dist).filter((f) => /\.(exe|msi|msix)$/i.test(f)).map((f) => path.join(dist, f))
  : []

if (!files.length) {
  console.log('[sign] nessun artefatto Windows in dist/')
  process.exit(0)
}

/* ---------- 1/2: certificato reale ---------- */
const hasPfx = Boolean(process.env.CSC_LINK)
const hasAzure = Boolean(
  process.env.AZURE_SIGNING_ENDPOINT &&
    process.env.AZURE_SIGNING_ACCOUNT &&
    process.env.AZURE_SIGNING_PROFILE
)

if (hasPfx || hasAzure) {
  const jsign = process.env.JSIGN_JAR ?? 'jsign.jar'
  const args = ['-jar', jsign, '--tsaurl', process.env.TSA_URL ?? 'http://timestamp.digicert.com']
  if (hasAzure) {
    args.push(
      '--storetype', 'TRUSTEDSIGNING',
      '--keystore', process.env.AZURE_SIGNING_ENDPOINT,
      '--storepass', `${process.env.AZURE_SIGNING_ACCOUNT}/${process.env.AZURE_SIGNING_PROFILE}`
    )
  } else {
    args.push(
      '--keystore', process.env.CSC_LINK,
      '--storetype', 'PKCS12',
      '--storepass', process.env.CSC_KEY_PASSWORD ?? ''
    )
  }
  for (const file of files) {
    execFileSync('java', [...args, file], { stdio: 'inherit' })
    console.log(`[sign] firmato (certificato reale): ${path.basename(file)}`)
  }
  process.exit(0)
}

/* ---------- 3: self-signed ---------- */
function ensureCertLinux() {
  fs.mkdirSync(certDir, { recursive: true })
  if (fs.existsSync(pfx)) return
  execFileSync('openssl', [
    'req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '730',
    '-keyout', path.join(certDir, 'key.pem'),
    '-out', cer,
    '-subj', '/CN=TriadeAI/O=TriadeAI/C=IT',
    '-addext', 'extendedKeyUsage=codeSigning',
    '-addext', 'keyUsage=digitalSignature'
  ], { stdio: 'inherit' })
  execFileSync('openssl', [
    'pkcs12', '-export',
    '-inkey', path.join(certDir, 'key.pem'),
    '-in', cer,
    '-out', pfx,
    '-passout', `pass:${password}`,
    '-name', 'TriadeAI self-signed'
  ], { stdio: 'inherit' })
  console.log(`[sign] certificato self-signed creato in ${path.relative(process.cwd(), certDir)}`)
}

function signLinux() {
  ensureCertLinux()
  if (!execFileSync('which', ['osslsigncode']).toString().trim()) {
    throw new Error('osslsigncode mancante: apt-get install osslsigncode')
  }
  for (const file of files) {
    const out = `${file}.signed`
    execFileSync('osslsigncode', [
      'sign', '-pkcs12', pfx, '-pass', password,
      '-h', 'sha256',
      '-ts', process.env.TSA_URL ?? 'http://timestamp.digicert.com',
      '-in', file, '-out', out
    ], { stdio: 'inherit' })
    fs.renameSync(out, file)
    console.log(`[sign] firmato (self-signed): ${path.basename(file)}`)
  }
}

function signWindows() {
  fs.mkdirSync(certDir, { recursive: true })
  const script = `
$ErrorActionPreference = 'Stop'
$cert = Get-ChildItem Cert:\\CurrentUser\\My | Where-Object { $_.Subject -eq 'CN=TriadeAI' } | Select-Object -First 1
if (-not $cert) {
  $cert = New-SelfSignedCertificate -Type CodeSigningCert -Subject 'CN=TriadeAI' \
    -KeyUsage DigitalSignature -FriendlyName 'TriadeAI self-signed' \
    -CertStoreLocation 'Cert:\\CurrentUser\\My' -NotAfter (Get-Date).AddYears(2)
}
$files = Get-ChildItem -Path '${dist.replace(/\\/g, '\\\\')}' -Include *.exe,*.msi,*.msix -File -Recurse
foreach ($f in $files) {
  $res = Set-AuthenticodeSignature -FilePath $f.FullName -Certificate $cert \
    -TimestampServer 'http://timestamp.digicert.com' -HashAlgorithm SHA256
  Write-Output ("[sign] " + $f.Name + " -> " + $res.Status)
}
`
  execFileSync('powershell', ['-NoProfile', '-NonInteractive', '-Command', script], {
    stdio: 'inherit'
  })
}

try {
  if (process.platform === 'win32') signWindows()
  else signLinux()
  console.log('[sign] completato (self-signed: SmartScreen avviserà comunque su altre macchine)')
} catch (err) {
  console.error(`[sign] firma fallita: ${err.message}`)
  process.exitCode = 1
}
