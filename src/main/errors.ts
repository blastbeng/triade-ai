/**
 * Traduce gli errori tecnici in messaggi azionabili per l'utente.
 * L'obiettivo: chi legge deve sapere cosa fare, non solo che qualcosa è fallito.
 */
export function humanizeError(err: unknown, backend = 'llama'): string {
  const raw = err instanceof Error ? err.message : String(err)
  const msg = raw.toLowerCase()

  if (/gguf_init_from_reader|failed to load model|invalid number of dimensions|string length .* exceeds maximum/.test(msg)) {
    return (
      'Il file del modello è danneggiato o incompleto. ' +
      'Apri impostazioni → modelli e download e usa “ripara (riscarica)”: ' +
      'l’app eliminerà il file corrotto e lo scaricherà di nuovo.'
    )
  }
  if (/outofdevicememory|out of device memory|cuda_error_out_of_memory|failed to allocate/.test(msg)) {
    return (
      'Memoria GPU esaurita: chiudi altre app che usano la GPU, riduci il contesto ' +
      'nelle impostazioni, oppure assegna questa chat a un’altra GPU.'
    )
  }
  if (/econnrefused|fetch failed|socket hang up|etimedout/.test(msg)) {
    return backend === 'llama'
      ? 'Il server locale non è raggiungibile: riavvia l’app e controlla che i binari in bin/ siano presenti.'
      : `Impossibile raggiungere ${backend}: verifica la connessione e la base URL nelle impostazioni.`
  }
  if (/401|403|invalid api key|unauthorized|incorrect api key|user not found/.test(msg)) {
    return `Chiave API non valida per ${backend}: controlla la chiave in impostazioni → backend.`
  }
  if (/404|not found|model .* not found|no such model/.test(msg)) {
    return `Endpoint o modello non trovato su ${backend}: verifica base URL e nome del modello.`
  }
  if (/429|rate limit|quota/.test(msg)) {
    return `Limite di richieste raggiunto su ${backend}: attendi qualche minuto o usa un altro backend.`
  }
  if (/context|exceeds available|n_ctx/.test(msg)) {
    return (
      'Il contesto è troppo pieno per questo turno: riduci il contesto nelle impostazioni ' +
      'o avvia una nuova chat.'
    )
  }
  return raw
}
