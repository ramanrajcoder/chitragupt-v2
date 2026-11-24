// Local test/dev harness: serves the static app + /api/* handlers exactly like Vercel would,
// but against an in-memory Postgres (PGlite) created from the REAL schema.sql. No cloud needed.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { PGlite } from '@electric-sql/pglite';
import { __setQueryForTests } from '../lib/db.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css', '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png' };

export async function startHarness({ port = 0 } = {}) {
  process.env.JWT_SECRET ||= 'test-secret-test-secret-test-secret-0123456789';
  process.env.DATABASE_URL ||= 'postgresql://test:test@localhost/test'; // never contacted: the harness swaps in PGlite
  const pg = new PGlite();
  await pg.exec(fs.readFileSync(path.join(ROOT, 'schema.sql'), 'utf8'));
  __setQueryForTests(async (text, params) => (await pg.query(text, params)).rows);

  const handlers = new Map();
  async function handlerFor(file) {
    if (!handlers.has(file)) handlers.set(file, (await import(pathToFileURL(file).href)).default);
    return handlers.get(file);
  }

  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, 'http://localhost');
      if (url.pathname.startsWith('/api/')) {
        const file = path.join(ROOT, url.pathname + '.js');
        if (!file.startsWith(path.join(ROOT, 'api')) || !fs.existsSync(file)) { res.statusCode = 404; return res.end('{"error":"not found"}'); }
        // emulate Vercel: JSON bodies arrive already parsed on req.body
        if (req.method !== 'GET' && req.method !== 'HEAD') {
          const chunks = []; for await (const c of req) chunks.push(c);
          const raw = Buffer.concat(chunks).toString('utf8');
          try { req.body = raw ? JSON.parse(raw) : {}; } catch { res.statusCode = 400; return res.end('{"error":"bad json"}'); }
        }
        return (await handlerFor(file))(req, res);
      }
      if (url.pathname === '/') { res.statusCode = 302; res.setHeader('Location', '/landing.html'); return res.end(); }
      const file = path.join(ROOT, decodeURIComponent(url.pathname));
      if (!file.startsWith(ROOT) || file.includes('node_modules') || !fs.existsSync(file) || fs.statSync(file).isDirectory()) { res.statusCode = 404; return res.end('not found'); }
      res.setHeader('Content-Type', MIME[path.extname(file)] || 'application/octet-stream');
      res.setHeader('Cache-Control', 'no-store');
      fs.createReadStream(file).pipe(res);
    } catch (e) { console.error(e); res.statusCode = 500; res.end('error'); }
  });
  await new Promise(r => server.listen(port, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  return { base, pg, close: () => new Promise(r => { server.close(r); }) };
}
