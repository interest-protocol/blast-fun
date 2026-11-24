// Re-pin contract.json from the published docs spec, never by hand:
//   node scripts/partner-api-live/pin-contract.mjs <docs commit> [spec file or URL]
// Each operation keeps its documented 200 JSON schema plus every component it reaches.
import { readFileSync, writeFileSync } from 'node:fs';

const SOURCE = 'https://docs.blast.fun/openapi/partner-api-v1.json';
const OPERATIONS = {
  presales: '/api/v1/presales',
  featured: '/api/v1/presales/featured',
  presale: '/api/v1/presales/{presaleId}',
  prices: '/api/v1/prices',
  discovery: '/api/v1/discovery',
  search: '/api/v1/search',
  status: '/api/v1/market/status',
  pool: '/api/v1/market/pools/{venue}/{poolId}',
  candles: '/api/v1/market/pools/{venue}/{poolId}/candles',
};

const [sourceCommit, from = SOURCE] = process.argv.slice(2);
if (!/^[0-9a-f]{40}$/.test(sourceCommit ?? '')) throw new Error('Pass the full docs commit the spec was built from.');
async function download(url) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`The spec answered ${response.status}.`);
  return response.json();
}
const spec = from.startsWith('https://') ? await download(from) : JSON.parse(readFileSync(from, 'utf8'));

const schemas = {};
function collect(node) {
  if (Array.isArray(node)) return node.forEach(collect);
  if (!node || typeof node !== 'object') return;
  const name = node.$ref?.match(/^#\/components\/schemas\/(.+)$/)?.[1];
  if (name && !(name in schemas)) {
    schemas[name] = spec.components.schemas[name];
    if (!schemas[name]) throw new Error(`The spec has no component ${name}.`);
    collect(schemas[name]);
  }
  Object.values(node).forEach(collect);
}
const operations = Object.fromEntries(Object.entries(OPERATIONS).map(([id, path]) => {
  const schema = spec.paths[path]?.get?.responses?.['200']?.content?.['application/json']?.schema;
  if (!schema) throw new Error(`The spec has no 200 JSON response for ${path}.`);
  collect(schema);
  return [id, { path, schema }];
}));

writeFileSync(new URL('./contract.json', import.meta.url),
  JSON.stringify({ source: SOURCE, sourceCommit, operations, components: { schemas } }, null, 2) + '\n');
