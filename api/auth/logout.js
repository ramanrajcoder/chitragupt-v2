import { route } from '../../lib/http.js';
import { clearCookie } from '../../lib/auth.js';

export default route({
  methods: ['POST'],
  auth: false,
  async handler() {
    return { headers: { 'Set-Cookie': clearCookie() }, json: { ok: true } };
  }
});
