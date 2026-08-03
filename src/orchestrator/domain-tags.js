/**
 * Domain keyword → tag extractor.
 * Used by lifecycle.js (learning writes) and learnings.js (context reads)
 * to propagate domain-specific failure knowledge across subtasks.
 */

const DOMAIN_KEYWORDS = [
  ['binance', 'domain:binance'], ['coinbase', 'domain:coinbase'],
  ['bybit', 'domain:bybit'], ['kraken', 'domain:kraken'], ['okx', 'domain:okx'],
  ['projbeta', 'domain:projbeta'], ['kalshi', 'domain:kalshi'],
  ['websocket', 'domain:websocket'], ['webhook', 'domain:webhook'],
  ['orderbook', 'domain:orderbook'], ['arbitrage', 'domain:arbitrage'],
  ['rate limit', 'domain:rate-limit'], ['geo', 'domain:geo-block'],
  ['database', 'domain:database'], ['postgres', 'domain:postgres'],
  ['sqlite', 'domain:sqlite'], ['docker', 'domain:docker'],
  ['authentication', 'domain:auth'], ['oauth', 'domain:oauth'], ['api key', 'domain:api-key'],
  ['projalpha', 'domain:projalpha'], ['polybot', 'domain:polybot'],
  ['governance', 'domain:governance'], ['campaign', 'domain:campaign'],
  ['backtest', 'domain:backtesting'],
];

export function extractDomainTags(text) {
  if (!text) return [];
  const lower = text.toLowerCase();
  return DOMAIN_KEYWORDS.filter(([kw]) => lower.includes(kw)).map(([, tag]) => tag);
}
