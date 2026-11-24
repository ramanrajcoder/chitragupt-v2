import { route, send, HttpError } from '../lib/http.js';
import { query } from '../lib/db.js';
import { syncBody } from '../lib/schemas.js';

/*
 * POST /api/sync   { changes: [ {key, base, value}, ... ] }
 *
 * ALL changed keys are saved in ONE SQL statement (= one transaction) with a per-key version check:
 *   - base > 0  : UPDATE ... WHERE version = base      (stale write -> 0 rows)
 *   - base = 0  : INSERT ... ON CONFLICT DO NOTHING    (key already exists -> 0 rows)
 * If ANY key is stale, the final 1/0 raises an error, Postgres rolls the whole statement back,
 * nothing is saved, and we answer 409 listing the stale keys. So a bill can never be half-saved.
 * business_id is taken from the verified cookie.
 */
const APPLY_SQL = `
with input as (
  select * from jsonb_to_recordset($2::jsonb) as x(key text, value jsonb, base integer)
),
upd as (
  update business_data d
     set value = i.value, version = d.version + 1, updated_at = now()
    from input i
   where d.business_id = $1::uuid and d.key = i.key and i.base > 0 and d.version = i.base
  returning d.key, d.version
),
ins as (
  insert into business_data (business_id, key, value, version)
  select $1::uuid, i.key, i.value, 1 from input i where i.base = 0
  on conflict (business_id, key) do nothing
  returning key, version
),
res as (select key, version from upd union all select key, version from ins)
select 1 / case when (select count(*) from res) = (select count(*) from input) then 1 else 0 end as ok,
       (select jsonb_object_agg(key, version) from res) as versions
`;

export default route({
  methods: ['POST'],
  async handler({ businessId, body }) {
    const b = syncBody.parse(body);
    try {
      const [row] = await query(APPLY_SQL, [businessId, JSON.stringify(b.changes)]);
      return { json: { ok: true, versions: row.versions } };
    } catch (e) {
      const stale = String(e.code) === '22012' || /division by zero/i.test(e.message || '');
      if (!stale) {
        if (String(e.code) === '23503') throw new HttpError(401, 'Account not found — please sign in again');
        throw e;
      }
      // find which keys are out of date so the app can tell the user and reload
      const rows = await query(`select key, version from business_data where business_id = $1 and key = any($2::text[])`,
        [businessId, b.changes.map(c => c.key)]);
      const cur = {};
      rows.forEach(r => { cur[r.key] = r.version; });
      const conflicts = b.changes.filter(c => (c.base === 0 ? cur[c.key] !== undefined : cur[c.key] !== c.base)).map(c => c.key);
      return { status: 409, json: { error: 'Data was changed on another device. Nothing was saved.', conflicts } };
    }
  }
});
