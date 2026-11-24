// zod schemas for every request body + the shape of each business-data key.
import { z } from 'zod';

export const DATA_KEYS = ['products', 'sales', 'expenses', 'customers', 'suppliers', 'payments', 'supplierPayments',
  'purchases', 'returns', 'held', 'gstAdjust', 'ledger', 'audit', 'counters', 'settings',
  'businessName', 'gstNumber', 'address', 'bizPhone'];

const LEDGER_ACCOUNTS = ['CASH', 'BANK', 'AR', 'GST_IN', 'ADV', 'AP', 'GST_OUT', 'SALES', 'SALES_RET', 'EXP', 'EQ_OPEN'];

const entity = z.record(z.string(), z.unknown());
const entityList = z.array(entity).max(500000);
const ledgerEntry = z.object({
  account: z.enum(LEDGER_ACCOUNTS),
  debit: z.number().int().nonnegative(),   // integer paise only
  credit: z.number().int().nonnegative()
});
const text = z.string().max(500);

/** validation only; the ORIGINAL value is what gets stored (zod would strip unknown fields) */
export const KEY_SCHEMAS = {
  products: entityList, sales: entityList, expenses: entityList, customers: entityList, suppliers: entityList,
  payments: entityList, supplierPayments: entityList, purchases: entityList, returns: entityList,
  held: entityList, gstAdjust: entityList, audit: entityList,
  ledger: z.array(z.looseObject({}).pipe(ledgerEntry)).max(2000000),
  counters: z.record(z.string(), z.number()),
  settings: entity,
  businessName: text, gstNumber: text, address: text, bizPhone: text
};

const keyEnum = z.enum(DATA_KEYS);

export const syncBody = z.object({
  changes: z.array(z.object({
    key: keyEnum,
    base: z.number().int().min(0),   // version the client last saw (0 = key not on server yet)
    value: z.unknown()
  })).min(1).max(DATA_KEYS.length)
}).superRefine((b, ctx) => {
  const seen = new Set();
  b.changes.forEach((c, i) => {
    if (seen.has(c.key)) ctx.addIssue({ code: 'custom', message: 'Duplicate key in one request', path: ['changes', i, 'key'] });
    seen.add(c.key);
    const r = KEY_SCHEMAS[c.key].safeParse(c.value);
    if (!r.success) ctx.addIssue({ code: 'custom', message: `"${c.key}" has an invalid shape: ${r.error.issues[0]?.message || 'invalid'}`, path: ['changes', i, 'value'] });
  });
});

export const importBody = z.object({
  data: z.record(z.string(), z.unknown())
}).superRefine((b, ctx) => {
  let any = false;
  for (const [k, v] of Object.entries(b.data)) {
    if (!DATA_KEYS.includes(k)) { ctx.addIssue({ code: 'custom', message: `Unknown data key "${k}"`, path: ['data', k] }); continue; }
    any = true;
    const r = KEY_SCHEMAS[k].safeParse(v);
    if (!r.success) ctx.addIssue({ code: 'custom', message: `"${k}" has an invalid shape: ${r.error.issues[0]?.message || 'invalid'}`, path: ['data', k] });
  }
  if (!any) ctx.addIssue({ code: 'custom', message: 'No ChitRagupt data found', path: ['data'] });
  // same integrity rule the app's own Restore uses: debits must equal credits
  if (Array.isArray(b.data.ledger)) {
    let dr = 0, cr = 0;
    for (const e of b.data.ledger) { dr += e.debit || 0; cr += e.credit || 0; }
    if (dr !== cr) ctx.addIssue({ code: 'custom', message: 'Ledger does not balance (debits ≠ credits)', path: ['data', 'ledger'] });
  }
});

export const registerBody = z.object({
  businessName: z.string().trim().min(1, 'Enter your business name').max(80),
  ownerName: z.string().trim().min(1, 'Enter the owner name').max(80),
  loginId: z.string().trim().min(3, 'Login id must be at least 3 characters').max(40)
    .regex(/^[A-Za-z0-9._@+-]+$/, 'Login id may use letters, numbers and . _ @ + - only'),
  password: z.string().min(6, 'Password must be at least 6 characters').max(72, 'Password must be at most 72 characters')
});

export const loginBody = z.object({
  loginId: z.string().trim().min(1, 'Enter your login id').max(60),
  password: z.string().min(1, 'Enter your password').max(200)
});

export const translateBody = z.object({
  texts: z.array(z.string().max(500)).min(1).max(25),
  target: z.string().regex(/^[a-z]{2,3}(-[A-Za-z]{2,4})?$/, 'Invalid language code')
});
