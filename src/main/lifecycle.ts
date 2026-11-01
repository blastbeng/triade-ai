/**
 * Registro unico delle risorse da chiudere all'uscita (server, timer, watcher).
 * Ogni nuovo modulo che crea qualcosa di persistente deve registrarsi qui:
 * senza un punto solo, i processi figli restano orfani in VRAM (già successo).
 */
type Cleanup = () => void | Promise<void>

const tasks: Cleanup[] = []

/** Registra una pulizia; viene eseguita in ordine inverso all'uscita. */
export function onShutdown(fn: Cleanup): void {
  tasks.push(fn)
}

/** Esegue tutte le pulizie registrate; un errore non blocca le altre. */
export async function shutdownAll(): Promise<void> {
  while (tasks.length) {
    const fn = tasks.pop()
    if (!fn) continue
    try {
      await fn()
    } catch (err) {
      console.warn('[lifecycle] pulizia fallita:', (err as Error).message)
    }
  }
}
