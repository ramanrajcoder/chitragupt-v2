// npm run dev  ->  full app on http://127.0.0.1:3000 with an in-memory database (data is lost when you stop it)
import { startHarness } from './harness.mjs';
const h = await startHarness({ port: 3000 });
console.log('ChitRagupt dev server (in-memory DB):', h.base + '/landing.html');
