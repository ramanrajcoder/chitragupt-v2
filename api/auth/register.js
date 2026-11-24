import bcrypt from 'bcryptjs';
import { route, HttpError, clientIp } from '../../lib/http.js';
import { query } from '../../lib/db.js';
import { signSession, sessionCookie } from '../../lib/auth.js';
import { registerBody } from '../../lib/schemas.js';

const MAX_REGISTRATIONS_PER_IP_PER_HOUR = 10; // protects the free database from sign-up spam

export default route({
  methods: ['POST'],
  auth: false,
  async handler(ctx) {
    const b = registerBody.parse(ctx.body);
    const ip = clientIp(ctx.req);

    // sign-up spam guard (re-uses login_attempts; the 'register:' prefix cannot be a real login id)
    const [{ n }] = await query(
      `select count(*)::int as n from login_attempts where login_id = 'register:' and ip = $1 and at > now() - interval '1 hour'`, [ip]);
    if (n >= MAX_REGISTRATIONS_PER_IP_PER_HOUR) throw new HttpError(429, 'Too many sign-ups from this network. Try again in an hour.');
    await query(`insert into login_attempts (login_id, ip) values ('register:', $1)`, [ip]);

    const hash = await bcrypt.hash(b.password, 10); // bcrypt hash only; the password itself is never stored
    let row;
    try {
      [row] = await query(
        `insert into businesses (name, owner_name, login_id, password_hash) values ($1, $2, $3, $4)
         returning id, name, owner_name, login_id`,
        [b.businessName, b.ownerName, b.loginId, hash]);
    } catch (e) {
      if (String(e.code) === '23505') throw new HttpError(409, 'That login id is already taken — choose another');
      throw e;
    }
    const token = await signSession(row.id);
    return {
      status: 201,
      headers: { 'Set-Cookie': sessionCookie(token) },
      json: { user: { businessName: row.name, ownerName: row.owner_name, loginId: row.login_id } }
    };
  }
});
