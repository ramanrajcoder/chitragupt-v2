// Shared plumbing for every Vercel Function: method check, CSRF origin check,
// cookie auth, JSON/gzip body reading, uniform error replies.
import zlib from 'node:zlib';
import { ZodError } from 'zod';
import { verifySession, readCookie, SESSION_COOKIE } from './auth.js';

export class HttpError extends Error {
  constructor(status, message, extra) {
    super(message);
    this.status = status;
    this.extra = extra || {};
  }
}

export const MAX_BODY_BYTES = 30 * 1024 * 1024; // after gunzip; guards against zip bombs

export function send(res, status, json, headers = {}) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  for (const [k, v] of Object.entries(headers)) res.setHeader(k, v);
  res.end(JSON.stringify(json));
}

/** Gzip big JSON replies when the browser accepts it (keeps us under Vercel's 4.5 MB response cap). */
export function sendMaybeGzip(req, res, status, json) {
  const body = Buffer.from(JSON.stringify(json));
  const accepts = String(req.headers['accept-encoding'] || '');
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  if (body.length > 1024 && /\bgzip\b/.test(accepts)) {
    const gz = zlib.gzipSync(body, { level: 6 });
    res.setHeader('Content-Encoding', 'gzip');
    res.setHeader('Vary', 'Accept-Encoding');
    res.setHeader('Content-Length', gz.length);
    res.end(gz);
  } else {
    res.setHeader('Content-Length', body.length);
    res.end(body);
  }
}

export function clientIp(req) {
  const h = req.headers;
  const ip = h['x-real-ip'] || String(h['x-forwarded-for'] || '').split(',')[0].trim() || req.socket?.remoteAddress || '';
  return String(ip).slice(0, 64) || 'unknown';
}

/** Reject cross-site browser POSTs (belt and braces on top of SameSite=Strict). */
function checkOrigin(req) {
  const origin = req.headers.origin;
  if (!origin) return; // curl / server-to-server / same-origin GET
  const host = req.headers['x-forwarded-host'] || req.headers.host;
  let oh = '';
  try { oh = new URL(origin).host; } catch { /* fallthrough */ }
  if (!oh || oh !== host) throw new HttpError(403, 'Cross-site request blocked');
}

async function readRawBody(req) {
  const chunks = [];
  let size = 0;
  for await (const c of req) {
    size += c.length;
    if (size > MAX_BODY_BYTES) throw new HttpError(413, 'Request too large');
    chunks.push(c);
  }
  return Buffer.concat(chunks);
}

/**
 * Body is either plain JSON, or {"gz":"<base64 of gzip(JSON)>"} (sent by the app for big saves).
 * Works whether or not the platform already parsed req.body.
 */
export async function readJsonBody(req) {
  let parsed;
  try {
    const pre = req.body;
    if (pre !== undefined && pre !== null && !(typeof pre === 'string' && pre === '')) {
      parsed = typeof pre === 'string' ? JSON.parse(pre) : Buffer.isBuffer(pre) ? JSON.parse(pre.toString('utf8')) : pre;
    } else {
      const raw = await readRawBody(req);
      parsed = raw.length ? JSON.parse(raw.toString('utf8')) : {};
    }
  } catch (e) {
    if (e instanceof HttpError) throw e;
    throw new HttpError(400, 'Request body is not valid JSON');
  }
  if (parsed && typeof parsed === 'object' && typeof parsed.gz === 'string' && Object.keys(parsed).length === 1) {
    try {
      const out = zlib.gunzipSync(Buffer.from(parsed.gz, 'base64'), { maxOutputLength: MAX_BODY_BYTES });
      parsed = JSON.parse(out.toString('utf8'));
    } catch {
      throw new HttpError(400, 'Compressed body could not be read');
    }
  }
  return parsed;
}

/** Verified business id from the httpOnly cookie. NEVER read it from the body. */
export async function requireAuth(req) {
  const token = readCookie(req, SESSION_COOKIE);
  if (!token) throw new HttpError(401, 'Not signed in');
  const businessId = await verifySession(token);
  if (!businessId) throw new HttpError(401, 'Session expired — please sign in again');
  return businessId;
}

/**
 * route({ methods, auth, handler }) -> (req,res) => Promise
 * handler({req,res,businessId,body}) returns {status,json,headers?} or calls res itself and returns null.
 */
export function route({ methods, auth = true, handler }) {
  return async function vercelHandler(req, res) {
    try {
      if (!methods.includes(req.method)) {
        res.setHeader('Allow', methods.join(', '));
        return send(res, 405, { error: 'Method not allowed' });
      }
      if (req.method !== 'GET' && req.method !== 'HEAD') checkOrigin(req);
      const ctx = { req, res, businessId: null, body: undefined };
      if (auth) ctx.businessId = await requireAuth(req);
      if (req.method !== 'GET' && req.method !== 'HEAD') ctx.body = await readJsonBody(req);
      const out = await handler(ctx);
      if (out) send(res, out.status || 200, out.json ?? {}, out.headers);
    } catch (e) {
      if (e instanceof HttpError) return send(res, e.status, { error: e.message, ...e.extra });
      if (e instanceof ZodError) {
        const first = e.issues?.[0];
        const where = first?.path?.length ? ` (${first.path.join('.')})` : '';
        return send(res, 400, { error: (first?.message || 'Invalid request') + where });
      }
      console.error('API error:', e?.code || '', e?.message || e); // never log request bodies or secrets
      return send(res, 500, { error: 'Server error — please try again' });
    }
  };
}
