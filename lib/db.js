// Neon Postgres over HTTPS (works great in serverless: no connection pool to manage).
import { neon } from '@neondatabase/serverless';

let _sql = null;

function client() {
  if (!_sql) {
    const url = process.env.DATABASE_URL;
    if (!url) throw new Error('DATABASE_URL is not set');
    _sql = neon(url);
  }
  return _sql;
}

/** run one parameterised statement; returns an array of row objects */
export async function query(text, params = []) {
  return client().query(text, params);
}

/** tests inject an in-memory Postgres (PGlite) here; never used in production */
export function __setQueryForTests(fn) {
  _sql = { query: fn };
}
