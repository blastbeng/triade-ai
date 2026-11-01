#!/usr/bin/env node
/**
 * Firma gli artefatti Windows con jsign (Java), che supporta sia un PFX sia
 * Azure Artifact Signing (ex Trusted Signing).
 *
 *   jsign --keystore cert.pfx --alias ... --storepass ... dist/app.exe
 *   jsign --tsaurl http://timestamp.digicert.com ...
 *
 * Variabili d'ambiente:
 *   CSC_LINK / CSC_KEY_PASSWORD              → PFX (OV/EV) acquistato
 *   AZURE_SIGNING_ENDPOINT                   → es. https://weu.codesigning.azure.net/
 *   AZURE_SIGNING_ACCOUNT / AZURE_SIGNING_PROFILE
 *   AZURE_TENANT_ID / AZURE_CLIENT_ID / AZURE_CLIENT_SECRET
 *
 * Senza credenziali lo script NON fallisce: avvisa e lascia gli artefatti non firmati.
 */
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'

const dist = path.join(process.cwd(), 'dist')
const targets = fs.existsSync(dist)
  ? fs.readdirSync(dist).filter((f) => /\.(exe|msi|msix)$/i.test(f)).map((f) => path.join(dist, f))
  : []

if (!targets.length) {
  console.log('[sign] nessun artefatto Windows in dist/')
  process.exit(0)
}

const hasPfx = Boolean(process.env.CSC_LINK)
const hasAzure = Boolean(
  process.env.AZURE_SIGNING_ENDPOINT &&
    process.env.AZURE_SIGNING_ACCOUNT &&
    process.env.AZURE_SIGNING_PROFILE
)

if (!hasPfx && !hasAzure) {
  console.log(
    '[sign] nessuna credenziale: gli eseguibili restano NON firmati.\n' +
      '       PFX:   CSC_LINK + CSC_KEY_PASSWORD\n' +
      '       Azure: AZURE_SIGNING_ENDPOINT + ACCOUNT + PROFILE (+ credenziali Azure)\n' +
      '       Vedi README → "Windows trust".'
  )
  process.exit(0)
}

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

for (const file of targets) {
  try {
    execFileSync('java', [...args, file], { stdio: 'inherit' })
    console.log(`[sign] firmato: ${path.basename(file)}`)
  } catch (err) {
    console.error(`[sign] firma fallita per ${path.basename(file)}: ${err.message}`)
    process.exitCode = 1
  }
}
