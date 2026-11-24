import { route } from '../lib/http.js';
import { query } from '../lib/db.js';

// GET /api/health - open this URL after deploying to confirm everything is wired up.
export default route({
  methods: ['GET'],
  auth: false,
  async handler() {
    let db = 'ok';
    try { await query('select 1 as ok'); } catch { db = 'error'; }
    const configured = {
      database: !!process.env.DATABASE_URL,
      jwtSecret: (process.env.JWT_SECRET || '').length >= 32,
      translate: !!process.env.GOOGLE_TRANSLATE_API_KEY
    };
    const ok = db === 'ok' && configured.database && configured.jwtSecret;
    return { status: ok ? 200 : 503, json: { ok, db, configured, time: new Date().toISOString() } };
  }
});
