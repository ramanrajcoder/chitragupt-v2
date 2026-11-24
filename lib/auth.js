// Session = signed JWT (HS256) in an httpOnly, Secure, SameSite=Strict cookie.
import { SignJWT, jwtVerify } from 'jose';

export const SESSION_COOKIE = 'cr_session';
const SESSION_SECONDS = 60 * 60 * 24 * 7; // 7 days
const ISSUER = 'chitragupt';

function secretKey() {
  const s = process.env.JWT_SECRET || '';
  if (s.length < 32) {
    const e = new Error('JWT_SECRET is missing or shorter than 32 characters');
    e.status = 500;
    throw e;
  }
  return new TextEncoder().encode(s);
}

export async function signSession(businessId) {
  return new SignJWT({})
    .setProtectedHeader({ alg: 'HS256' })
    .setSubject(businessId)
    .setIssuer(ISSUER)
    .setIssuedAt()
    .setExpirationTime(`${SESSION_SECONDS}s`)
    .sign(secretKey());
}

/** returns business id (uuid string) or null */
export async function verifySession(token) {
  try {
    const { payload } = await jwtVerify(token, secretKey(), { issuer: ISSUER, algorithms: ['HS256'] });
    const sub = payload.sub;
    return typeof sub === 'string' && /^[0-9a-f-]{36}$/i.test(sub) ? sub : null;
  } catch (e) {
    if (e?.status === 500) throw e; // misconfiguration should be loud, not "logged out"
    return null;
  }
}

export function readCookie(req, name) {
  const raw = req.headers.cookie || '';
  for (const part of raw.split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    if (part.slice(0, i).trim() === name) return decodeURIComponent(part.slice(i + 1).trim());
  }
  return null;
}

export function sessionCookie(token) {
  return `${SESSION_COOKIE}=${token}; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=${SESSION_SECONDS}`;
}
export function clearCookie() {
  return `${SESSION_COOKIE}=; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=0`;
}
