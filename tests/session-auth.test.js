// App sessions ("Google once, then the app's own login") — backend half.
//
// Drives the REAL backend/Code.js through real doPost() calls. What these pin:
// a session is only opened from a FRESH Google sign-in for an ACTIVE user; the
// Sessoes tab never holds the code itself; a forged, expired, idle or revoked
// code is refused with the CREDENTIAL message (never an account verdict, so
// the client keeps unsent work); `ativo` = NAO still blocks on the next
// request and ends that device for good; and "could not read Sessoes" is a
// retry, never a sign-out.
'use strict';

const { test, equal, ok, notOk } = require('./helpers/harness');
const { createSandbox, sheetsFrom, papeisFor, ALL_SECTIONS } = require('./helpers/apps-script');

const A = 'a@example.com';
const B = 'b@example.com';
const OFF = 'off@example.com';
const nowS = () => Math.floor(Date.now() / 1000);

function fixture(tokens) {
  return createSandbox({
    tokens: Object.assign({
      'g-a': { email: A, name: 'A' },
      'g-b': { email: B, name: 'B' },
      'g-off': { email: OFF, name: 'Off' },
      'g-stale': { email: A, name: 'A', iat: nowS() - 3600 },
    }, tokens || {}),
    usuarios: [
      [A, 'A', 'admin', '*', 'SIM', 1],
      [B, 'B', 'admin', '*', 'SIM', 1],
      [OFF, 'Off', 'admin', '*', 'NAO', 1],
    ],
    papeis: papeisFor('admin', ALL_SECTIONS),
    sheets: sheetsFrom({
      Projetos: [['Obra A', 'SIM', '', 'Dalmir']],
      Tarefas: [['t1', 'Obra A', 'fazer', '', 'media', 'NAO', 1, 1]],
      Tipos: [['mat']], Unidades: [['und']], Socios: [['Dalmir']],
    }),
  });
}

function signIn(s, gTok, device) {
  return s.post({ action: 'verify', idToken: gTok, device: device || 'iPhone · app' });
}
const sessionRows = (s) => (s.auth.Sessoes ? s.auth.Sessoes._objects() : []);

test('session: a fresh Google sign-in opens a session that works for data actions', () => {
  const s = fixture();
  const r = signIn(s, 'g-a');
  ok(r.sessionToken, 'verify must hand back a session code');
  ok(r.sessionExpiresAt > Date.now(), 'and say when it ends');
  const g = s.post({ action: 'getAll', sessionToken: r.sessionToken });
  notOk(g.error, 'the session must work on getAll: ' + g.error);
  equal(g.currentUser.email, A);
  equal(g.tarefas.length, 1);
});

test('session: the sheet stores only a fingerprint, never the code itself', () => {
  const s = fixture();
  const r = signIn(s, 'g-a');
  const rows = sessionRows(s);
  equal(rows.length, 1);
  notOk(JSON.stringify(s.auth.Sessoes._data).indexOf(r.sessionToken.slice(5)) > -1, 'the raw code must not be in the tab');
  equal(rows[0].tokenHash.length, 64, 'a SHA-256 hex fingerprint');
  equal(rows[0].email, A);
  equal(rows[0].revogado, 'NAO');
});

test('session: a stale Google token (an hour old) cannot open a session', () => {
  const s = fixture();
  const r = signIn(s, 'g-stale');
  notOk(r.error, 'verify itself still answers');
  notOk(r.sessionToken, 'but no session may be minted from an old sign-in');
  equal(sessionRows(s).length, 0);
});

test('session: no session for an inactive or unknown account', () => {
  const s = fixture({ 'g-stranger': { email: 'x@example.com' } });
  equal(signIn(s, 'g-off').error, 'usuário desativado');
  equal(signIn(s, 'g-stranger').error, 'usuário não cadastrado');
  equal(sessionRows(s).length, 0);
});

test('session: forged, unknown and malformed codes are refused as a CREDENTIAL problem', () => {
  const s = fixture();
  signIn(s, 'g-a');
  equal(s.post({ action: 'getAll', sessionToken: 'cms1.' + 'f'.repeat(64) }).error, 'sessão expirada');
  equal(s.post({ action: 'getAll', sessionToken: 'not-even-shaped' }).error, 'sessão expirada');
  equal(s.post({ action: 'getAll' }).error, 'não autenticado');
});

test('session: revoked by typing SIM, or by deleting the row, ends just that device', () => {
  const s = fixture();
  const phone = signIn(s, 'g-a', 'iPhone').sessionToken;
  const laptop = signIn(s, 'g-a', 'Mac').sessionToken;
  const col = s.auth.Sessoes._data[0].indexOf('revogado');
  s.auth.Sessoes._data[1][col] = 'SIM';     // the phone's row
  equal(s.post({ action: 'verify', sessionToken: phone }).error, 'sessão expirada');
  notOk(s.post({ action: 'verify', sessionToken: laptop }).error, 'the other device keeps working');
  s.auth.Sessoes._data.splice(2, 1);        // delete the laptop's row by hand
  equal(s.post({ action: 'verify', sessionToken: laptop }).error, 'sessão expirada');
});

test('session: expired (absolute) and idle sessions are refused; an unreadable date fails closed', () => {
  const s = fixture();
  const t1 = signIn(s, 'g-a').sessionToken;
  const t2 = signIn(s, 'g-a').sessionToken;
  const t3 = signIn(s, 'g-a').sessionToken;
  const hdr = s.auth.Sessoes._data[0];
  const day = 24 * 3600 * 1000;
  s.auth.Sessoes._data[1][hdr.indexOf('expiraEm')] = new Date(Date.now() - 1000);
  s.auth.Sessoes._data[2][hdr.indexOf('ultimoUso')] = new Date(Date.now() - 91 * day);
  s.auth.Sessoes._data[3][hdr.indexOf('ultimoUso')] = 'ontem';
  equal(s.post({ action: 'verify', sessionToken: t1 }).error, 'sessão expirada');
  equal(s.post({ action: 'verify', sessionToken: t2 }).error, 'sessão expirada');
  equal(s.post({ action: 'verify', sessionToken: t3 }).error, 'sessão expirada');
});

test('session: deactivating the person blocks the next request AND ends the device for good', () => {
  const s = fixture();
  const t = signIn(s, 'g-a').sessionToken;
  s.auth.Usuarios._data[1][4] = 'NAO';
  equal(s.post({ action: 'getAll', sessionToken: t }).error, 'usuário desativado', 'an account verdict, not a credential one');
  s.auth.Usuarios._data[1][4] = 'SIM';
  equal(s.post({ action: 'getAll', sessionToken: t }).error, 'sessão expirada', 're-activating must not revive the old device');
});

test('session: the daily cleanup drops dead sessions and those of inactive people', () => {
  const s = fixture();
  signIn(s, 'g-a');
  const tb = signIn(s, 'g-b').sessionToken;
  signIn(s, 'g-a');
  s.auth.Sessoes._data[3][s.auth.Sessoes._data[0].indexOf('revogado')] = 'SIM';
  s.auth.Usuarios._data[1][4] = 'NAO';      // A switched off without A ever calling in
  s.ctx.cleanupSessions_();
  const rows = sessionRows(s);
  equal(rows.length, 1, 'only B survives');
  equal(rows[0].email, B);
  notOk(s.post({ action: 'verify', sessionToken: tb }).error);
});

test('session: logout removes this device server-side only', () => {
  const s = fixture();
  const t1 = signIn(s, 'g-a').sessionToken;
  const t2 = signIn(s, 'g-a').sessionToken;
  ok(s.post({ action: 'logout', sessionToken: t1 }).ok);
  equal(s.post({ action: 'verify', sessionToken: t1 }).error, 'sessão expirada');
  notOk(s.post({ action: 'verify', sessionToken: t2 }).error);
});

test('session: at most 10 devices per person — the oldest is signed out first', () => {
  const s = fixture();
  const toks = [];
  for (let i = 0; i < 11; i++) toks.push(signIn(s, 'g-a', 'd' + i).sessionToken);
  equal(sessionRows(s).length, 10);
  equal(s.post({ action: 'verify', sessionToken: toks[0] }).error, 'sessão expirada');
  notOk(s.post({ action: 'verify', sessionToken: toks[10] }).error);
});

test('session: a Sessoes read failure is "busy" (retry), never a sign-out', () => {
  const s = fixture();
  const t = signIn(s, 'g-a').sessionToken;
  s.auth.Sessoes.getRange = () => { throw new Error('Sheets hiccup'); };
  equal(s.post({ action: 'getAll', sessionToken: t }).error, 'Servidor ocupado, tente novamente.');
});

test('session: a Google token stops working on data actions after the cutoff, but still signs in', () => {
  const s = fixture();
  notOk(s.post({ action: 'getAll', idToken: 'g-a' }).error, 'before the cutoff an old frontend still works');
  const cutoff = s.eval('GOOGLE_TOKEN_DATA_ACTIONS_UNTIL');
  const realNow = s.ctx.Date.now;
  s.ctx.Date.now = () => cutoff + 1000;
  try {
    equal(s.post({ action: 'getAll', idToken: 'g-a' }).error, 'não autenticado');
    const v = s.post({ action: 'verify', idToken: 'g-a' });
    notOk(v.error, 'verify (sign-in) still takes a Google token');
  } finally {
    s.ctx.Date.now = realNow;
  }
});

test('session: renewing ultimoUso happens on verify, at most once a day', () => {
  const s = fixture();
  const t = signIn(s, 'g-a').sessionToken;
  const col = s.auth.Sessoes._data[0].indexOf('ultimoUso');
  const old = new Date(Date.now() - 3 * 24 * 3600 * 1000);
  s.auth.Sessoes._data[1][col] = old;
  s.post({ action: 'getAll', sessionToken: t });
  equal(s.auth.Sessoes._data[1][col], old, 'data actions never write to Sessoes');
  s.post({ action: 'verify', sessionToken: t });
  ok(s.auth.Sessoes._data[1][col].getTime() > Date.now() - 5000, 'verify renews it');
});
