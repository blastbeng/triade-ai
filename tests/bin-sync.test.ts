import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import {
  describeSync,
  foreignBinaries,
  planBinarySync,
  scanBinaries
} from '../src/main/bin-sync'

const mapOf = (entries: Record<string, number>): Map<string, number> => new Map(Object.entries(entries))

describe('planBinarySync', () => {
  it('binari identici: nessuna copia (niente 200 MB a ogni avvio)', () => {
    const source = mapOf({ 'llama-server.exe': 10, 'ggml.dll': 20, 'whisper/ggml.dll': 15 })
    const plan = planBinarySync(source, mapOf({ 'llama-server.exe': 10, 'ggml.dll': 20, 'whisper/ggml.dll': 15 }))
    expect(plan.needed).toBe(false)
    expect(describeSync(plan)).toBe('')
  })

  it('DLL sovrascritta da un\'altra build: dimensione diversa = da riallineare', () => {
    const source = mapOf({ 'ggml.dll': 20, 'mtmd.dll': 30 })
    const plan = planBinarySync(source, mapOf({ 'ggml.dll': 20, 'mtmd.dll': 999 }))
    expect(plan.needed).toBe(true)
    expect(plan.changed).toEqual(['mtmd.dll'])
  })

  it('file estranei nella radice (whisper in dati/bin): vanno rimossi', () => {
    const source = mapOf({ 'llama-server.exe': 10, 'ggml.dll': 20 })
    const plan = planBinarySync(
      source,
      mapOf({ 'llama-server.exe': 10, 'ggml.dll': 20, 'whisper.dll': 1, 'parakeet.dll': 1 })
    )
    expect(plan.needed).toBe(true)
    expect(plan.extra).toEqual(['parakeet.dll', 'whisper.dll'])
    expect(describeSync(plan)).toBe('estranei: parakeet.dll, whisper.dll')
  })

  it('file mancanti', () => {
    const plan = planBinarySync(mapOf({ 'a.dll': 1, 'b.dll': 2 }), mapOf({ 'a.dll': 1 }))
    expect(plan.missing).toEqual(['b.dll'])
    expect(describeSync(plan)).toBe('mancanti: b.dll')
  })

  it('elenca al massimo `limit` voci per riga', () => {
    const source = mapOf({ 'a.dll': 1 })
    const target = mapOf({ 'a.dll': 1, 'x1.dll': 1, 'x2.dll': 1, 'x3.dll': 1 })
    expect(describeSync(planBinarySync(source, target), 2)).toBe('estranei: x1.dll, x2.dll (+1)')
  })
})

describe('foreignBinaries', () => {
  it('riconosce i file di whisper.cpp e CUDA', () => {
    expect(
      foreignBinaries([
        'whisper.dll',
        'whisper-cli.exe',
        'main.exe',
        'parakeet.dll',
        'SDL2.dll',
        'ggml-cpu.dll',
        'ggml-cuda.dll',
        'ggml-cuda-zen4.dll'
      ])
    ).toEqual([
      'SDL2.dll',
      'ggml-cpu.dll',
      'ggml-cuda-zen4.dll',
      'ggml-cuda.dll',
      'main.exe',
      'parakeet.dll',
      'whisper-cli.exe',
      'whisper.dll'
    ])
  })

  it('non segnala i file legittimi di llama.cpp', () => {
    expect(
      foreignBinaries([
        'llama-server.exe',
        'llama-mtmd-cli.exe',
        'llama.dll',
        'mtmd.dll',
        'ggml.dll',
        'ggml-base.dll',
        'ggml-vulkan.dll',
        'ggml-cpu-zen4.dll',
        'ggml-cpu-alderlake.dll',
        'ffmpeg.exe',
        'ffprobe.exe'
      ])
    ).toEqual([])
  })
})

describe('scanBinaries', () => {
  const dirs: string[] = []
  afterAll(() => {
    for (const dir of dirs) fs.rmSync(dir, { recursive: true, force: true })
  })

  it('legge percorsi relativi con /, sottocartelle comprese, e ignora i dot-file', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'triade-bin-'))
    dirs.push(dir)
    fs.mkdirSync(path.join(dir, 'whisper'), { recursive: true })
    fs.writeFileSync(path.join(dir, 'llama-server.exe'), 'x'.repeat(7))
    fs.writeFileSync(path.join(dir, 'ggml.dll'), 'x'.repeat(3))
    fs.writeFileSync(path.join(dir, 'whisper', 'whisper.dll'), 'x'.repeat(5))
    fs.writeFileSync(path.join(dir, '.stamp'), 'ignorami')

    const map = scanBinaries(dir)
    expect([...map.keys()].sort()).toEqual(['ggml.dll', 'llama-server.exe', 'whisper/whisper.dll'])
    expect(map.get('llama-server.exe')).toBe(7)
    expect(map.get('whisper/whisper.dll')).toBe(5)
  })
})
