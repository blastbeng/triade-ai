/**
 * Generatori degli script che installano un aggiornamento (Windows: PowerShell,
 * Linux/macOS: POSIX sh).
 *
 * È un modulo puro (nessun import di Electron): così lo script che finisce sul
 * disco è esattamente quello verificato dai test, su Windows e su Linux. Deve
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
  parentPid?: number
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
    '# pending.json resta: è l app, al riavvio, a dire che l aggiornamento non è stato applicato',
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

/** Letterale per `sh`: apice singolo, con `'\''` per gli apici interni. */
export function shLiteral(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`
}

/**
 * Supervisore POSIX (AppImage) dell'aggiornamento.
 *
 * Stessa regola del Windows: sostituisce il file **in place** (stesso nome, così
 * collegamenti e lanciatori continuano a funzionare), avvia la nuova versione e
 * torna indietro solo se il marker di avvio non compare. Senza questo script, un
 * AppImage che non parte lascerebbe l'utente con l'app rotta e nessuno in grado
 * di ripristinare: `recoverFailedUpdate()` gira dentro l'app, che è proprio
 * quella che non parte.
 */
export function posixSupervisor(o: UpdateScriptOptions & { args?: string[] }): string {
  const exitTries = Math.max(1, Math.round((o.exitWaitSec ?? 120) * 2))
  const swapTries = Math.max(1, Math.round(o.swapRetries ?? 60))
  const markerWait = Math.max(1, Math.round(o.markerWaitSec ?? 300))
  const args = (o.args ?? []).map(shLiteral).join(' ')
  return `#!/bin/sh
# Supervisore di aggiornamento generato da TriadeAI. Si elimina da solo.
set -u

target=${shLiteral(o.target)}
newexe=${shLiteral(o.newExe)}
marker=${shLiteral(o.marker)}
pending=${shLiteral(o.pending)}
esito=${shLiteral(o.esito)}
logfile=${shLiteral(o.logFile)}
version=${shLiteral(o.version)}
backup="$target.old"
failed="$target.failed"
oldpid=${o.pid}
exit_tries=${exitTries}
swap_tries=${swapTries}
marker_wait=${markerWait}

log() { printf '[%s] %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$*" >>"$logfile" 2>/dev/null; }
write_esito() { printf '{"result":"%s","version":"%s","reason":"%s","at":"%s"}' "$1" "$version" "$2" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" >"$esito" 2>/dev/null; }
marker_ok() { [ -e "$marker" ]; }
launch() {
  [ -x "$target" ] || return 0
  "$target" ${args} >>"$logfile" 2>&1 &
  app_pid=$!
}

log "avvio: attendo la chiusura dell app (pid $oldpid)"
i=0
while [ "$i" -lt "$exit_tries" ]; do
  kill -0 "$oldpid" 2>/dev/null || break
  sleep 0.5
  i=$((i + 1))
done
sleep 1

# l'AppImage in esecuzione è montato: si rinomina (stesso filesystem) e si mette
# il nuovo al suo posto, senza mai copiare sopra un file in uso (ETXTBSY)
log "sostituzione di $target"
swapped=0
i=0
while [ "$i" -lt "$swap_tries" ]; do
  if [ ! -f "$newexe" ]; then
    log "nuovo eseguibile assente"
    break
  fi
  if [ -f "$target" ]; then
    rm -f "$backup" 2>/dev/null
    mv -f "$target" "$backup" 2>/dev/null || { i=$((i + 1)); sleep 1; continue; }
  fi
  if mv -f "$newexe" "$target" 2>/dev/null; then
    swapped=1
    break
  fi
  # ripristino parziale: il vecchio non deve restare fuori posto
  if [ ! -f "$target" ] && [ -f "$backup" ]; then mv -f "$backup" "$target" 2>/dev/null; fi
  i=$((i + 1))
  sleep 1
done
chmod 755 "$target" 2>/dev/null

if [ "$swapped" -ne 1 ]; then
  log "sostituzione non riuscita: resta la versione in uso"
  write_esito "swap-failed" "il file non era sostituibile"
  # pending.json resta: è l app, al riavvio, a dire che l aggiornamento non è stato applicato
  launch
  rm -f "$0" 2>/dev/null
  exit 0
fi

log "sostituzione fatta: avvio della nuova versione"
app_pid=""
launch

deadline=$(( $(date +%s) + marker_wait ))
while [ "$(date +%s)" -lt "$deadline" ]; do
  marker_ok && break
  # il processo avviato è morto: se ha fatto in tempo a scrivere il marker
  # l'aggiornamento è riuscito, altrimenti inutile aspettare
  if [ -n "$app_pid" ] && ! kill -0 "$app_pid" 2>/dev/null; then
    marker_ok && break
    log "la nuova versione è terminata senza segnare l avvio"
    break
  fi
  sleep 2
done

if marker_ok; then
  log "marker presente: aggiornamento completato"
  rm -f "$backup" "$pending" "$esito" 2>/dev/null
else
  log "marker assente: ripristino la versione precedente"
  write_esito "rolledback" "la nuova versione non si e avviata"
  if [ -f "$target" ]; then mv -f "$target" "$failed" 2>/dev/null; fi
  if [ -f "$backup" ]; then mv -f "$backup" "$target" 2>/dev/null; fi
  chmod 755 "$target" 2>/dev/null
  app_pid=""
  launch
fi
rm -f "$0" 2>/dev/null
exit 0
`
}
