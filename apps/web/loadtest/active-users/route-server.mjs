// Small smoke adapter only. Acceptance runs must use the real production Next build.
import { createServer } from 'node:http';
import { registerHooks } from 'node:module';
registerHooks({ resolve(specifier, context, next) {
  if (specifier === 'server-only') return { url: 'data:text/javascript,export {}', shortCircuit: true };
  return next(specifier, context);
} });
const paths = [
  'me', 'me/portfolio', 'me/portfolio/coins', 'me/presales', 'me/notifications',
  'home', 'home/traders', 'presales', 'feed',
];
const routes = new Map(await Promise.all(paths.map(async path => [
  `/api/social/${path}`, (await import(`../../src/app/api/social/${path}/route.ts`)).GET,
])));
const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url, process.env.NEXT_PUBLIC_SITE_URL);
    if (url.pathname === '/privacy') { res.end('smoke ready'); return; }
    const handler = routes.get(url.pathname);
    if (!handler) { res.writeHead(404); res.end(); return; }
    const response = await handler(new Request(url, { headers: req.headers }));
    res.writeHead(response.status, Object.fromEntries(response.headers));
    res.end(Buffer.from(await response.arrayBuffer()));
  } catch (error) { console.error(error); res.writeHead(500); res.end(); }
});
server.listen(Number(process.env.PORT), '127.0.0.1');
process.on('SIGTERM', () => server.close(() => process.exit(0)));
