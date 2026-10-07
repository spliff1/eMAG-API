import { createApp } from './src/app.js';
import { createHttpServer } from './src/core/http.js';

const port = Number(process.env.PORT) || 3030;
const host = process.env.HOST || '127.0.0.1';

const app = createApp({ ...(process.env.DATA_DIR ? { dataDir: process.env.DATA_DIR } : {}), persist: process.env.PERSIST !== '0', host });
const server = createHttpServer(app);

server.listen(port, host, () => {
  console.log(`
  Dummy eMAG Marketplace API  (spec v${app.spec.version})

  API base URL : http://${host}:${port}/api-3     (HTTP Basic auth, any credentials by default)
  Web UI       : http://${host}:${port}/
  OpenAPI spec : http://${host}:${port}/openapi.json
`);
});

// Ctrl+C / kill: record running imports as interrupted, flush everything to SQLite, close cleanly.
let closing = false;
for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    if (closing) process.exit(1);
    closing = true;
    try { app.importer.shutdown(); app.store.flush(); app.db.close(); } catch (e) { console.error('shutdown:', e.message); }
    process.exit(0);
  });
}
