// App sessions — frontend half: what an auth answer does to the DEVICE.
//
// Two kinds of answer, opposite handling (CLAUDE.md §4):
//   - a CREDENTIAL problem ('não autenticado', 'sessão expirada'): the login on
//     this device ended. Nothing on the device is deleted and nothing unsent
//     is dropped; signing back in sends it.
//   - an ACCOUNT refusal ('usuário desativado', ...): purge, as before.
// Before this split, a routine Google-token expiry (every hour on the iPhone
// app) went down the purge path in saveErrorMessage and dropped any pending
// Projetos/Tipos/Unidades/Sócios change in flushPending_.
//
// Runs the real functions extracted from index.html.
'use strict';

const { test, equal, ok, notOk, deepEqual } = require('./helpers/harness');
const { buildContext } = require('./helpers/app-source');

const ERRORS = {
  functions: ['isCredentialError', 'isAccountRefusal', 'isAuthError', 'isPermissionError'],
  declarations: ['CREDENTIAL_ERROR_MESSAGES', 'ACCOUNT_REFUSAL_MESSAGES'],
};

function buildFailure() {
  const log = [];
  const ctx = buildContext({
    functions: ERRORS.functions.concat(['saveErrorMessage', 'handleAuthFailure_', 'isNetworkError']),
    declarations: ERRORS.declarations,
    vars: { googleIdToken: 'g', googleIdTokenObtainedAt: 1, sessionToken: 'cms1.x', sessionVerifyPending: false, offlineMode: false },
    stubs: {
      setTimeout: (fn) => fn(),             // run the deferred sign-out now
      clearSessionHint: () => log.push('clearSessionHint'),
      purgeLocalData_: () => log.push('purgeLocalData_'),
      detachLocalDbForSignIn_: () => log.push('detachLocalDbForSignIn_'),
      suspendUploadSession_: () => log.push('suspendUploadSession_'),
      resetSyncMemory_: () => log.push('resetSyncMemory_'),
      clearInMemoryData_: () => log.push('clearInMemoryData_'),
      showAuthGate: (m) => log.push('gate'),
      ensureGisLoaded_: () => {},
      renderGoogleButton: () => {},
    },
  });
  return { ctx, log };
}

test('auth: an expired login never purges the device (saveErrorMessage path)', () => {
  const { ctx, log } = buildFailure();
  ctx.saveErrorMessage(new Error('sessão expirada'));
  notOk(log.indexOf('purgeLocalData_') > -1, 'unsent work must survive a login that merely ended');
  ok(log.indexOf('gate') > -1, 'the sign-in screen comes back');
  ok(log.indexOf('detachLocalDbForSignIn_') > -1, 'the dead code is dropped and the database detached, so a late persist cannot overwrite it');
  equal(ctx.sessionToken, null);
});

test('auth: a Google-token expiry ("não autenticado") is a credential problem too', () => {
  const { ctx, log } = buildFailure();
  ctx.saveErrorMessage(new Error('não autenticado'));
  notOk(log.indexOf('purgeLocalData_') > -1);
});

test('auth: an account refusal still purges', () => {
  ['usuário desativado', 'usuário não cadastrado', 'não autorizado'].forEach((m) => {
    const { ctx, log } = buildFailure();
    ctx.handleAuthFailure_(new Error(m));
    ok(log.indexOf('purgeLocalData_') > -1, m + ' must purge');
  });
});

test('auth: the classes do not overlap and do not swallow permission errors', () => {
  const ctx = buildContext({ functions: ERRORS.functions, declarations: ERRORS.declarations });
  ok(ctx.isCredentialError(new Error('sessão expirada')));
  notOk(ctx.isAccountRefusal(new Error('sessão expirada')));
  ok(ctx.isAccountRefusal(new Error('usuário desativado')));
  notOk(ctx.isCredentialError(new Error('usuário desativado')));
  notOk(ctx.isAuthError(new Error('sem permissão para edit')));
  notOk(ctx.isAuthError(new Error('Servidor ocupado, tente novamente.')));
});

function buildFlush(err) {
  const ctx = buildContext({
    functions: ERRORS.functions.concat(['flushPending_']),
    declarations: ERRORS.declarations.concat(['CONFIG_KEYS']),
    vars: { dirtyConfig: { projects: true }, projects: [{ id: 'Obra A' }], tipos: [], unidades: [], socios: [] },
    stubs: {
      SHEET_TAB: { projects: 'projetos' },
      toSheetRows: () => [],
      sheetsPost: async () => { throw err; },
      persistConfig_: async () => {},
      reportSyncVerdict_: () => {},
      flushFileDeletes_: async () => 'ok',
    },
  });
  return ctx;
}

test('auth: a pending Projetos change survives a login that ended', async () => {
  const ctx = buildFlush(new Error('sessão expirada'));
  const out = await ctx.flushPending_();
  equal(out, 'retry', 'not a verdict on the data');
  ok(ctx.dirtyConfig.projects, 'the change must still be waiting to be sent');
});

test('auth: an account refusal is still a verdict on a pending Projetos change', async () => {
  const ctx = buildFlush(new Error('usuário desativado'));
  equal(await ctx.flushPending_(), 'verdict');
  notOk(ctx.dirtyConfig.projects);
});

test('journal: an upload journal written by another account is not resumed', () => {
  const store = {};
  const ctx = buildContext({
    functions: ['readUploadJournal_'],
    declarations: ['UPLOAD_JOURNAL_KEY'],
    vars: { currentUser: { email: 'b@example.com' }, localDbEmail: 'b@example.com' },
    stubs: { localStorage: { getItem: (k) => store[k] || null } },
  });
  const key = ctx.UPLOAD_JOURNAL_KEY || 'cmoreira_upload_journal_v1';
  store[key] = JSON.stringify({ email: 'a@example.com', jobs: [{ id: 'p1' }] });
  deepEqual(ctx.readUploadJournal_(), [], "A's photo job must not resume under B");
  store[key] = JSON.stringify({ email: 'b@example.com', jobs: [{ id: 'p2' }] });
  equal(ctx.readUploadJournal_().length, 1, 'the same account resumes its own');
});

// --- the stored-session launch ------------------------------------------------

function buildStoredBoot(opts) {
  const events = [];
  const ctx = buildContext({
    functions: ['bootFromStoredSession_'],
    vars: { sessionToken: null },
    stubs: {
      lastKnownUserEmail_: () => opts.lastEmail,
      openLocalDb_: async (e) => { events.push('open:' + e); },
      readStoredAuth_: async () => opts.auth,
      $: () => ({ set innerHTML(v) {} }),
      bootFromLocalSession_: async (p, e) => { events.push('render:' + e); return true; },
      reconcileSignIn_: async (r, e) => { events.push('verify:' + e); },
    },
  });
  return { ctx, events };
}

test('stored session: opens the last account on its own code, then verifies', async () => {
  const { ctx, events } = buildStoredBoot({ lastEmail: 'a@example.com', auth: { token: 'cms1.a', email: 'a@example.com' } });
  ok(await ctx.bootFromStoredSession_());
  equal(ctx.sessionToken, 'cms1.a');
  deepEqual(events, ['open:a@example.com', 'render:a@example.com', 'verify:a@example.com']);
});

test('stored session: a code that names another account is never used', async () => {
  const { ctx, events } = buildStoredBoot({ lastEmail: 'a@example.com', auth: { token: 'cms1.b', email: 'b@example.com' } });
  notOk(await ctx.bootFromStoredSession_());
  equal(ctx.sessionToken, null);
  notOk(events.some((e) => e.indexOf('render') === 0));
});

test('stored session: nothing stored means the normal sign-in screen', async () => {
  const { ctx } = buildStoredBoot({ lastEmail: 'a@example.com', auth: undefined });
  notOk(await ctx.bootFromStoredSession_());
  const none = buildStoredBoot({ lastEmail: null, auth: undefined });
  notOk(await none.ctx.bootFromStoredSession_());
});

test('auth: an ended login detaches the database so a late persist cannot overwrite unsent work', () => {
  const ops = [];
  const db = {
    transaction: () => ({ objectStore: () => ({ delete: (k) => ops.push('delete:' + k) }) }),
    close: () => ops.push('close'),
  };
  const ctx = buildContext({ functions: ['detachLocalDbForSignIn_'], vars: { localDb: db, localDbEmail: 'a@example.com' } });
  ctx.detachLocalDbForSignIn_();
  equal(ctx.localDb, null, 'every persist path no-ops without an open handle');
  equal(ctx.localDbEmail, null, 'and the next sign-in reopens it');
  deepEqual(ops, ['delete:auth', 'close'], 'only the dead session code is removed, nothing else');
});

test('journal: with nobody signed in, a late write leaves the stored journal untouched', () => {
  const store = { cmoreira_upload_journal_v1: JSON.stringify({ email: 'a@example.com', jobs: [{ id: 'p1' }] }) };
  const ctx = buildContext({
    functions: ['saveUploadJournal_'],
    declarations: ['UPLOAD_JOURNAL_KEY'],
    vars: { currentUser: null, localDbEmail: null, pendingUploads: new Map() },
    stubs: { localStorage: { setItem: (k, v) => { store[k] = v; }, removeItem: (k) => { delete store[k]; } } },
  });
  ctx.saveUploadJournal_();
  ok(store.cmoreira_upload_journal_v1, 'the journal of photos already in Drive must survive');
});
