import { route, HttpError } from '../lib/http.js';
import { query } from '../lib/db.js';
import { importBody } from '../lib/schemas.js';

/*
 * POST /api/import   { data: { products: [...], sales: [...], ... } }
 * One-time import of existing localStorage data or a Backup-export file (already upgraded to schema v2
 * by the app). Only allowed while the business has no records yet, so it can never overwrite or
 * double-count real data. Saved in one SQL statement (one transaction).
 */
const IMPORT_SQL = `
with input as (
  select * from jsonb_to_recordset($2::jsonb) as x(key text, value jsonb)
),
chk as (
  select not exists (
    select 1 from business_data
     where business_id = $1::uuid
       and key = any($3::text[])
       and jsonb_typeof(value) = 'array' and jsonb_array_length(value) > 0
  ) as is_empty
),
ups as (
  insert into business_data (business_id, key, value, version)
  select $1::uuid, i.key, i.value, 1 from input i where (select is_empty from chk)
  on conflict (business_id, key) do update
     set value = excluded.value, version = business_data.version + 1, updated_at = now()
  returning key, version
)
select (select is_empty from chk) as is_empty, (select jsonb_object_agg(key, version) from ups) as versions
`;
const CONTENT_KEYS = ['products', 'sales', 'expenses', 'customers', 'suppliers', 'payments', 'supplierPayments', 'purchases', 'returns', 'ledger'];

export default route({
  methods: ['POST'],
  async handler({ businessId, body }) {
    const b = importBody.parse(body);
    const items = Object.entries(b.data).map(([key, value]) => ({ key, value }));
    const [row] = await query(IMPORT_SQL, [businessId, JSON.stringify(items), CONTENT_KEYS]);
    if (!row.is_empty) throw new HttpError(409, 'This account already has data, so the one-time import is not allowed. Use Settings → Restore from file instead.');
    return { json: { ok: true, versions: row.versions || {} } };
  }
});
