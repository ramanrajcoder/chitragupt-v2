import { route, sendMaybeGzip, HttpError } from '../lib/http.js';
import { query } from '../lib/db.js';
import { DATA_KEYS } from '../lib/schemas.js';

// keys that, when all empty, mean "this business has not entered anything yet" (drives the one-time import step)
const CONTENT_KEYS = ['products', 'sales', 'expenses', 'customers', 'suppliers', 'payments', 'supplierPayments', 'purchases', 'returns', 'ledger'];

/**
 * GET /api/data               -> everything for the signed-in business (user + every key with its version)
 * GET /api/data?versions=1    -> just {key: version} (tiny; used to check freshness)
 * GET /api/data?keys=a,b      -> only those keys
 * business_id comes from the verified cookie, never from the URL.
 */
export default route({
  methods: ['GET'],
  async handler({ req, res, businessId }) {
    const url = new URL(req.url, 'http://x');
    const [biz] = await query(`select name, owner_name, login_id from businesses where id = $1`, [businessId]);
    if (!biz) throw new HttpError(401, 'Account not found — please sign in again');

    if (url.searchParams.get('versions')) {
      const rows = await query(`select key, version from business_data where business_id = $1`, [businessId]);
      const versions = {};
      rows.forEach(r => { versions[r.key] = r.version; });
      return { json: { versions } };
    }

    let keys = null;
    const k = url.searchParams.get('keys');
    if (k) {
      keys = k.split(',').map(s => s.trim()).filter(x => DATA_KEYS.includes(x));
      if (!keys.length) throw new HttpError(400, 'No valid keys requested');
    }
    const rows = keys
      ? await query(`select key, value, version from business_data where business_id = $1 and key = any($2::text[])`, [businessId, keys])
      : await query(`select key, value, version from business_data where business_id = $1`, [businessId]);

    const data = {};
    rows.forEach(r => { data[r.key] = { value: r.value, version: r.version }; });
    const empty = CONTENT_KEYS.every(key => !data[key] || !Array.isArray(data[key].value) || data[key].value.length === 0);
    sendMaybeGzip(req, res, 200, {
      user: { id: businessId, businessName: biz.name, ownerName: biz.owner_name, loginId: biz.login_id },
      data, empty, serverTime: new Date().toISOString()
    });
    return null;
  }
});
