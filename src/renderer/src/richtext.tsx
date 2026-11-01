/**
 * Markup minimale nelle stringhe tradotte: `<b>`, `<i>`, `<c>`.
 *
 * Le traduzioni usano questi tag (es. “i file stanno in <c>dati/modelli/</c>”):
 * senza conversione finirebbero a schermo come testo, parentesi comprese. Si
 * convertono qui e mai con `dangerouslySetInnerHTML`: il testo arriva da file
 * di lingua, ma resta testo.
 */
export function renderRichText(text: string): JSX.Element[] {
  const parts = text.split(/(<b>.*?<\/b>|<i>.*?<\/i>|<c>.*?<\/c>)/g)
  return parts.filter(Boolean).map((part, index) => {
    if (part.startsWith('<b>')) return <strong key={index}>{part.slice(3, -4)}</strong>
    if (part.startsWith('<i>')) return <em key={index}>{part.slice(3, -4)}</em>
    if (part.startsWith('<c>')) return <code key={index}>{part.slice(3, -4)}</code>
    return <span key={index}>{part}</span>
  })
}
