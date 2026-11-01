/**
 * Generatore dello script PowerShell che installa un aggiornamento su Windows.
 *
 * È un modulo puro (nessun import di Electron): così lo script che finisce sul
 * disco è esattamente quello verificato dai test, su Windows compresi. Deve
 * restare tale — niente `dataDir()`/`app` qui dentro, i percorsi arrivano come
 * parametri.
 */

export interface UpdateScriptOptions {
  /** eseguibile da sostituire (sul portable: PORTABLE_EXECUTABLE_FILE) */
  target: string
  /** eseguibile nuovo, già scaricato */
  newExe: string
  /** file che l'app scrive quando è partita davvero (vedi bootMarker) */
  marker: string
  version: string
  /** pid dell'app che ha lanciato il supervisore */
  pid: number
  /** pid del padre (il launcher portable, che tiene aperta l'estrazione) */
  parentPid: number
  pending: string
  esito: string
  logFile: string
  /** secondi di attesa della chiusura dell'app (default 120) */
  exitWaitSec?: number
  /** tentativi di sostituzione del file (default 60, uno al secondo) */
  swapRetries?: number
  /** secondi di attesa del marker di avvio prima del rollback (default 300) */
  markerWaitSec?: number
  /** secondi senza alcun processo vivo prima di rinunciare (default 45) */
  deadGraceSec?: number
}

/** Letterale PowerShell fra apici singoli (raddoppia gli apici interni). */
export function psLiteral(value: string): string {
  return `'${value.replace(/'/g, "''")}'`
}

/**
 * Supervisore PowerShell dell'aggiornamento su Windows.
 *
 * Attende la chiusura dell'app, sostituisce il file, avvia la nuova versione e
 * aspetta il marker di avvio. Regola unica: si torna indietro SOLO se il marker
 * non arriva — nessun rollback a tempo mentre l'app sta ancora partendo (il
 * primo avvio dopo un aggiornamento copia ~200 MB di binari in `dati/bin` e può
 * metterci molto su un disco con antivirus attivo).
 */
export function powershellSupervisor(o: UpdateScriptOptions): string {
  const exitWait = o.exitWaitSec ?? 120
  const swapRetries = o.swapRetries ?? 60
  const markerWait = o.markerWaitSec ?? 300
  const deadGrace = o.deadGraceSec ?? 45
  return [
    '$ErrorActionPreference = "Continue"',
    `$target = ${psLiteral(o.target)}`,
    `$newExe = ${psLiteral(o.newExe)}`,
    `$marker = ${psLiteral(o.marker)}`,
    `$backup = ${psLiteral(`${o.target}.old`)}`,
    `$pending = ${psLiteral(o.pending)}`,
    `$esito = ${psLiteral(o.esito)}`,
    `$version = ${psLiteral(o.version)}`,
    `$log = ${psLiteral(o.logFile)}`,
    `$pid0 = ${o.pid}`,
    `$parent0 = ${o.parentPid}`,
    `$exitTries = ${Math.max(1, Math.round(exitWait * 2))}`,
    `$swapTries = ${Math.max(1, Math.round(swapRetries))}`,
    `$markerWait = ${Math.max(1, Math.round(markerWait))}`,
    `$deadGrace = ${Math.max(1, Math.round(deadGrace))}`,
    'function Log($m) { try { Add-Content -LiteralPath $log -Value ("[{0}] {1}" -f (Get-Date -Format o), $m) } catch {} }',
    'function Test-Marker {',
    '  if ($version -eq "") { return (Test-Path -Path (Join-Path (Split-Path -Parent $marker) "boot-*.ok")) }',
    '  return (Test-Path -LiteralPath $marker)',
    '}',
    'function WriteEsito($result, $reason) {',
    '  try {',
    '    $json = @{ result = $result; version = $version; reason = $reason; at = (Get-Date).ToString("o") } | ConvertTo-Json -Compress',
    '    [IO.File]::WriteAllText($esito, $json, (New-Object System.Text.UTF8Encoding($false)))',
    '  } catch {}',
    '}',
    'Log "avvio: attendo la chiusura dell app (pid $pid0)"',
    'for ($i = 0; $i -lt $exitTries; $i++) {',
    '  if (-not (Get-Process -Id $pid0 -ErrorAction SilentlyContinue)) { break }',
    '  Start-Sleep -Milliseconds 500',
    '}',
    '# il launcher portable (nostro processo padre) tiene aperta la sua estrazione',
    '# con ExecWait e poi fa RMDir /r della cartella: se avviassimo la nuova',
    '# versione troppo presto, la sua estrazione verrebbe cancellata a metà',
    'if ($parent0 -gt 0) {',
    '  $pp = Get-Process -Id $parent0 -ErrorAction SilentlyContinue',
    '  if ($pp -and $pp.ProcessName -eq [IO.Path]::GetFileNameWithoutExtension($target)) {',
    '    Log "attendo anche il launcher portable (pid $parent0)"',
    '    for ($i = 0; $i -lt $exitTries; $i++) {',
    '      if (-not (Get-Process -Id $parent0 -ErrorAction SilentlyContinue)) { break }',
    '      Start-Sleep -Milliseconds 500',
    '    }',
    '  }',
    '}',
    'Start-Sleep -Seconds 2',
    '$swapped = $false',
    'for ($i = 0; $i -lt $swapTries; $i++) {',
    '  try {',
    '    if (Test-Path -LiteralPath $target) {',
    '      if (Test-Path -LiteralPath $backup) { Remove-Item -LiteralPath $backup -Force -ErrorAction Stop }',
    '      Move-Item -LiteralPath $target -Destination $backup -Force -ErrorAction Stop',
    '    }',
    '    if (-not (Test-Path -LiteralPath $newExe)) { throw "nuovo eseguibile assente" }',
    '    Move-Item -LiteralPath $newExe -Destination $target -Force -ErrorAction Stop',
    '    $swapped = $true',
    '    break',
    '  } catch {',
    '    Log ("sostituzione, tentativo {0}: {1}" -f $i, $_.Exception.Message)',
    '    if ((Test-Path -LiteralPath $backup) -and -not (Test-Path -LiteralPath $target)) {',
    '      try { Move-Item -LiteralPath $backup -Destination $target -Force -ErrorAction Stop } catch {}',
    '    }',
    '    Start-Sleep -Seconds 1',
    '  }',
    '}',
    'if (-not $swapped) {',
    '  Log "sostituzione non riuscita: ripristino"',
    '  WriteEsito "swap-failed" "il file non era sostituibile"',
    '  if ((Test-Path -LiteralPath $backup) -and -not (Test-Path -LiteralPath $target)) {',
    '    try { Move-Item -LiteralPath $backup -Destination $target -Force } catch {}',
    '  }',
    '  try { Remove-Item -LiteralPath $pending -Force -ErrorAction SilentlyContinue } catch {}',
    '  try { Start-Process -FilePath $target -WorkingDirectory (Split-Path -Parent $target) } catch {}',
    '  exit 0',
    '}',
    'Log "sostituzione fatta: avvio della nuova versione"',
    'try { Start-Process -FilePath $target -WorkingDirectory (Split-Path -Parent $target) | Out-Null } catch {',
    '  Log ("avvio fallito: {0}" -f $_.Exception.Message)',
    '}',
    '$name = [IO.Path]::GetFileNameWithoutExtension($target)',
    '$deadline = (Get-Date).AddSeconds($markerWait)',
    '$deadSince = $null',
    'while ((Get-Date) -lt $deadline) {',
    '  if (Test-Marker) { break }',
    '  $alive = $false',
    '  foreach ($n in @($name, "TriadeAI")) {',
    '    if (@(Get-Process -Name $n -ErrorAction SilentlyContinue).Count -gt 0) { $alive = $true }',
    '  }',
    '  if ($alive) {',
    '    $deadSince = $null',
    '  } else {',
    '    if ($null -eq $deadSince) { $deadSince = Get-Date }',
    '    elseif (((Get-Date) - $deadSince).TotalSeconds -gt $deadGrace) { Log "nessun processo vivo"; break }',
    '  }',
    '  Start-Sleep -Seconds 1',
    '}',
    'if (Test-Marker) {',
    '  Log "marker presente: aggiornamento completato"',
    '  try { if (Test-Path -LiteralPath $backup) { Remove-Item -LiteralPath $backup -Force } } catch {}',
    '  try { Remove-Item -LiteralPath $pending -Force -ErrorAction SilentlyContinue } catch {}',
    '  try { Remove-Item -LiteralPath $esito -Force -ErrorAction SilentlyContinue } catch {}',
    '} else {',
    '  Log "marker assente: ripristino la versione precedente"',
    '  WriteEsito "rolledback" "la nuova versione non si e avviata"',
    '  try {',
    '    if (Test-Path -LiteralPath $target) { Move-Item -LiteralPath $target -Destination ($target + ".failed") -Force }',
    '  } catch {}',
    '  try {',
    '    if (Test-Path -LiteralPath $backup) { Move-Item -LiteralPath $backup -Destination $target -Force }',
    '  } catch {}',
    '  try { Start-Process -FilePath $target -WorkingDirectory (Split-Path -Parent $target) } catch {}',
    '}',
    'try { Remove-Item -LiteralPath $PSCommandPath -Force -ErrorAction SilentlyContinue } catch {}'
  ].join('\r\n')
}
