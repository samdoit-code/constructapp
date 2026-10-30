// End-to-end: real index.html in Chromium, real backend/Code.js in the mocked
// Apps Script sandbox, Google's sign-in script replaced by a fake button.
// NOT part of `node tests/run.js` — it needs Playwright and a Chromium, which the
// zero-dependency suite deliberately does not. Run it after any change to
// sign-in, sessions or boot:
//   node tests/e2e/session.e2e.js            (this checkout)
//   node tests/e2e/session.e2e.js <dir>      (index.html from another dir — the negative control)
//   CMOREIRA_BACKEND=<old Code.js> node tests/e2e/session.e2e.js   (deploy-order check)
// PLAYWRIGHT_PATH overrides where playwright is required from.
'use strict';
const path = require('path');
const fs = require('fs');
const http = require('http');
const os = require('os');
const { chromium } = require(process.env.PLAYWRIGHT_PATH || 'playwright');
const REPO = path.join(__dirname, '..', '..');
const { createSandbox, sheetsFrom, papeisFor, ALL_SECTIONS } = require(REPO + '/tests/helpers/apps-script');

const APP_SRC = process.argv[2] || REPO;
const EMAIL = 'a@example.com';
const b64url = (o) => Buffer.from(JSON.stringify(o)).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const CRED = [b64url({ alg: 'RS256' }), b64url({ email: EMAIL, name: 'A' }), 'sig'].join('.');

// Snapshot the app so edits during the run can't change the page mid-run.
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cm-e2e-'));
fs.cpSync(path.join(APP_SRC, 'index.html'), path.join(dir, 'index.html'));
fs.cpSync(path.join(REPO, 'assets'), path.join(dir, 'assets'), { recursive: true });
fs.cpSync(path.join(REPO, 'sw.js'), path.join(dir, 'sw.js'));
fs.writeFileSync(path.join(dir, 'version.json'), fs.readFileSync(path.join(REPO, 'version.json')));

const sandbox = createSandbox({
  tokens: { [CRED]: { email: EMAIL, name: 'A' } },
  usuarios: [[EMAIL, 'A', 'admin', '*', 'SIM', 1]],
  papeis: papeisFor('admin', ALL_SECTIONS),
  sheets: sheetsFrom({
    Projetos: [['Obra A', 'SIM', '', 'Dalmir']],
    Tarefas: [['t1', 'Obra A', 'tarefa existente', '', 'media', 'NAO', 1, 1]],
    Tipos: [['mat']], Unidades: [['und']], Socios: [['Dalmir']],
  }),
});

const FAKE_GIS = `window.google = { accounts: { id: {
  initialize(cfg){ window.__gisCb = cfg.callback; },
  renderButton(el){ el.innerHTML = '<button id="fakeGoogle">Entrar com Google</button>';
    el.querySelector('button').onclick = () => window.__gisCb({ credential: ${JSON.stringify(CRED)} }); },
  prompt(){}, disableAutoSelect(){}, } } };`;

const results = [];
function check(name, cond, extra) { results.push({ name, ok: !!cond }); console.log((cond ? 'PASS ' : 'FAIL ') + name + (extra ? '  — ' + extra : '')); }

(async () => {
  const server = http.createServer((req, res) => {
    let p = decodeURIComponent(req.url.split('?')[0]);
    if (p === '/' || p === '') p = '/index.html';
    const f = path.join(dir, p);
    if (!f.startsWith(dir) || !fs.existsSync(f)) { res.writeHead(404); res.end(); return; }
    const type = f.endsWith('.html') ? 'text/html' : f.endsWith('.js') ? 'application/javascript' : f.endsWith('.json') ? 'application/json' : f.endsWith('.woff2') ? 'font/woff2' : 'application/octet-stream';
    res.writeHead(200, { 'Content-Type': type }); res.end(fs.readFileSync(f));
  });
  await new Promise((r) => server.listen(0, r));
  const url = 'http://localhost:' + server.address().port + '/';

  const browser = await chromium.launch();
  const context = await browser.newContext({ viewport: { width: 430, height: 900 }, serviceWorkers: 'block' });
  const stats = { gis: 0, bodies: [] };
  let offline = false;
  await context.route('**/*', (route) => route.continue());
  await context.route('https://accounts.google.com/**', (route) => {
    stats.gis++;
    if (offline) return route.abort();
    route.fulfill({ status: 200, contentType: 'application/javascript', body: FAKE_GIS });
  });
  await context.route('https://script.google.com/**', async (route) => {
    if (offline) return route.abort();
    const body = JSON.parse(route.request().postData() || '{}');
    stats.bodies.push(body);
    let out;
    try { out = sandbox.post(body); } catch (e) { out = { error: String(e.message) }; }
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(out) });
  });

  const gateVisible = (page) => page.evaluate(() => getComputedStyle(document.getElementById('authGate')).display !== 'none');
  const sessions = () => (sandbox.auth.Sessoes ? sandbox.auth.Sessoes._objects() : []);
  const taskTexts = () => sandbox.rows('Tarefas').map((r) => r.texto);
  const errors = [];

  // 1. First launch: sign in with Google once.
  let page = await context.newPage();
  page.on('pageerror', (e) => errors.push(String(e)));
  await page.goto(url);
  await page.waitForSelector('#fakeGoogle', { timeout: 8000 });
  check('first launch shows the Google button', await gateVisible(page));
  await page.click('#fakeGoogle');
  await page.waitForFunction(() => getComputedStyle(document.getElementById('authGate')).display === 'none', null, { timeout: 8000 });
  await page.waitForTimeout(800);
  check('signing in opens the app', !(await gateVisible(page)));
  check('one session row was created', sessions().length === 1, JSON.stringify(sessions().map((s) => s.dispositivo)));
  const verifyBody = stats.bodies.find((b) => b.action === 'verify' && b.idToken);
  check('the sign-in verify carried the Google token', verifyBody && verifyBody.idToken === CRED);
  const after = stats.bodies.slice(stats.bodies.indexOf(verifyBody) + 1);
  check('every request after sign-in uses the app session, not Google', after.length > 0 && after.every((b) => b.sessionToken && !b.idToken),
    after.map((b) => b.action + ':' + (b.sessionToken ? 's' : 'g')).join(','));
  await page.close();

  // 2. Relaunch: no Google at all.
  stats.gis = 0; stats.bodies = [];
  const t0 = Date.now();
  page = await context.newPage();
  page.on('pageerror', (e) => errors.push(String(e)));
  await page.goto(url);
  await page.waitForFunction(() => getComputedStyle(document.getElementById('authGate')).display === 'none', null, { timeout: 8000 });
  const openMs = Date.now() - t0;
  await page.waitForTimeout(1000);
  check('relaunch opens straight into the app', !(await gateVisible(page)), openMs + ' ms to app');
  check("relaunch never loads Google's script", stats.gis === 0, 'gis requests: ' + stats.gis);
  check('relaunch verify used the session', stats.bodies.some((b) => b.action === 'verify' && b.sessionToken));

  // 3. A write works on the session.
  await page.click('button[data-view="tasks"]');
  await page.fill('#t_texto', 'tarefa via sessao');
  await page.click('#saveTaskBtn');
  await page.waitForTimeout(1500);
  check('a write reaches the spreadsheet on the session', taskTexts().indexOf('tarefa via sessao') > -1, JSON.stringify(taskTexts()));

  // 4. Revoke this device (delete its row by hand), then write: the login ends,
  //    the unsent write must survive and go out after signing in again.
  sandbox.auth.Sessoes._data.splice(1, 1);
  await page.fill('#t_texto', 'tarefa depois de revogar');
  await page.click('#saveTaskBtn');
  await page.waitForFunction(() => getComputedStyle(document.getElementById('authGate')).display !== 'none', null, { timeout: 8000 }).catch(() => {});
  check('a revoked session sends the device back to sign-in', await gateVisible(page));
  const msg = await page.evaluate(() => document.getElementById('authGateMsg').textContent + ' | ' + document.getElementById('authGateError').textContent);
  check('the message says nothing was lost', /continuam guardadas|não foi perdido/.test(msg), msg);
  check('the write did NOT reach the server yet', taskTexts().indexOf('tarefa depois de revogar') === -1);
  await page.waitForSelector('#fakeGoogle', { timeout: 8000 });
  await page.click('#fakeGoogle');
  await page.waitForFunction(() => getComputedStyle(document.getElementById('authGate')).display === 'none', null, { timeout: 8000 });
  await page.waitForTimeout(2500);
  check('after signing in again the kept write is sent', taskTexts().indexOf('tarefa depois de revogar') > -1, JSON.stringify(taskTexts()));
  check('a new session row exists', sessions().length === 1);
  await page.close();

  // 5. Offline launch on the stored session.
  offline = true;
  page = await context.newPage();
  page.on('pageerror', (e) => errors.push(String(e)));
  await page.goto(url).catch(() => {});
  await page.waitForTimeout(2500);
  check('offline launch opens from the device', !(await gateVisible(page)));
  // Queue a write offline, then come back online: it must send with no sign-in.
  await page.click('button[data-view="tasks"]');
  await page.fill('#t_texto', 'tarefa offline');
  await page.click('#saveTaskBtn');
  await page.waitForTimeout(800);
  offline = false;
  await page.evaluate(() => window.dispatchEvent(new Event('online')));
  await page.waitForTimeout(3500);
  check('back online, the offline write is sent with no sign-in', taskTexts().indexOf('tarefa offline') > -1, JSON.stringify(taskTexts()));
  check('still no sign-in screen', !(await gateVisible(page)));

  // 6. Sign out revokes server-side.
  await page.click('#settingsBtn');
  await page.click('#signOutBtn');
  await page.click('#confirmOkBtn');
  await page.waitForTimeout(1200);
  check('sign-out shows the sign-in screen', await gateVisible(page));
  check('sign-out removed the session row on the server', sessions().length === 0, JSON.stringify(sessions()));
  await page.close();
  page = await context.newPage();
  await page.goto(url);
  await page.waitForTimeout(1500);
  check('after sign-out a relaunch asks to sign in', await gateVisible(page));

  check('no page errors', errors.length === 0, errors.join(' | '));
  await browser.close();
  server.close();
  const failed = results.filter((r) => !r.ok).length;
  console.log(`\n${results.length - failed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(2); });
