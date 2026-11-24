import bcrypt from 'bcryptjs';
import { route, HttpError, clientIp } from '../../lib/http.js';
import { query } from '../../lib/db.js';
import { signSession, sessionCookie } from '../../lib/auth.js';
import { loginBody } from '../../lib/schemas.js';

const MAX_FAILS = 5;            // failed attempts allowed ...
const WINDOW = '15 minutes';    // ... per 15 minutes, per login id AND per IP
// a real bcrypt hash: lets us spend the same time on unknown login ids (no user-enumeration by timing)
const DUMMY_HASH = bcrypt.hashSync('not-a-real-password', 10);

export default route({
  methods: ['POST'],
  auth: false,
  async handler(ctx) {
    const b = loginBody.parse(ctx.body);
    const ip = clientIp(ctx.req);
    const lid = b.loginId.toLowerCase().slice(0, 60);

    // 1. rate limit (counts FAILED attempts only)
    const [rl] = await query(
      `select count(*) filter (where lower(login_id) = $1)::int as by_login,
              count(*) filter (where ip = $2 and login_id <> 'register:')::int as by_ip,
              greatest(0, ceil(extract(epoch from (min(at) + interval '${WINDOW}' - now()))))::int as retry
         from login_attempts
        where at > now() - interval '${WINDOW}' and login_id <> 'register:' and (lower(login_id) = $1 or ip = $2)`, [lid, ip]);
    if (rl.by_login >= MAX_FAILS || rl.by_ip >= MAX_FAILS) {
      throw new HttpError(429, 'Too many wrong attempts. Please wait about 15 minutes and try again.',
        { retryAfterSeconds: rl.retry || 900 });
    }

    // 2. check the password (always run bcrypt, even for unknown ids)
    const [biz] = await query(
      `select id, name, owner_name, login_id, password_hash from businesses where lower(login_id) = $1`, [lid]);
    const ok = await bcrypt.compare(b.password, biz ? biz.password_hash : DUMMY_HASH);

    if (!biz || !ok) {
      await query(`insert into login_attempts (login_id, ip) values ($1, $2)`, [lid, ip]);
      if (Math.random() < 0.1) await query(`delete from login_attempts where at < now() - interval '1 day'`); // housekeeping
      const left = Math.max(0, MAX_FAILS - (rl.by_login + 1));
      throw new HttpError(401, 'Wrong login id or password', { attemptsLeft: left });
    }

    await query(`delete from login_attempts where lower(login_id) = $1`, [lid]);
    const token = await signSession(biz.id);
    return {
      headers: { 'Set-Cookie': sessionCookie(token) },
      json: { user: { businessName: biz.name, ownerName: biz.owner_name, loginId: biz.login_id } }
    };
  }
});
