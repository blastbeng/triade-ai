/**
 * Logger con livelli. `TRIADE_LOG=debug|info|warn|error|off` (default: info).
 * Tutto ciò che finisce nel terminale passa da qui, così si può alzare/abbassare
 * il dettaglio senza toccare il codice e senza riempire i log di rumore.
 */
type Level = 'debug' | 'info' | 'warn' | 'error' | 'off'

const ORDER: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40, off: 100 }

function currentLevel(): Level {
  const raw = (process.env.TRIADE_LOG ?? 'info').toLowerCase()
  return (['debug', 'info', 'warn', 'error', 'off'] as Level[]).includes(raw as Level)
    ? (raw as Level)
    : 'info'
}

function emit(level: Exclude<Level, 'off'>, prefix: string, args: unknown[]): void {
  if (ORDER[level] < ORDER[currentLevel()]) return
  const line = [`[${prefix}]`, ...args] as unknown[]
  if (level === 'error') console.error(...line)
  else if (level === 'warn') console.warn(...line)
  else console.log(...line)
}

export const log = {
  debug: (...args: unknown[]): void => emit('debug', 'debug', args),
  info: (...args: unknown[]): void => emit('info', 'info', args),
  warn: (...args: unknown[]): void => emit('warn', 'warn', args),
  error: (...args: unknown[]): void => emit('error', 'error', args)
}
