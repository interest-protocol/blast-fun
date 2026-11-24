/**
 * A ticker in the one shared class (`.ticker` in blast-ui.css): whole when it
 * fits its line, broken anywhere only when it cannot, so it is never clipped,
 * cut or pushed past its card. `$PIP`, or `PIP` after an amount (`bare`).
 */
export function Ticker({ symbol, bare = false }: Readonly<{ symbol: string; bare?: boolean }>) {
  return <span className="ticker">{bare ? symbol : `$${symbol}`}</span>;
}

const escaped = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * A sentence that names tickers ("get at least 89.9M PIP."): each whole-word
 * ticker in `symbols` is set in the shared class, so a long one wraps inside
 * the sentence's box. The sentence stays one string for the status line that
 * announces it.
 */
export function TickerText({ text, symbols }: Readonly<{ text: string; symbols: readonly string[] }>) {
  const names = [...new Set(symbols.filter(Boolean))].sort((a, b) => b.length - a.length);
  if (names.length === 0) return <>{text}</>;
  const parts = text.split(new RegExp(`(?<![\\w])(${names.map(escaped).join("|")})(?![\\w])`));
  return <>{parts.map((part, index) => (index % 2 === 1 ? <span className="ticker" key={index}>{part}</span> : part))}</>;
}
