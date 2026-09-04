// F2 — account crossover on the provisional / offline boot.
//
// bootFromLocalSession_ paints data from THIS DEVICE before verify() answers.
// It used to pick whose data by reading lastKnownUserEmail_() alone, which on a
// shared device is the PREVIOUS person: A closes the app without signing out
// (their database survives by design — that is the whole offline story), B
// relaunches and signs in with their own account, and B got A's lançamentos on
// screen, A's unsent writes pushed under B's token, and A's pending delta
// persisted into B's database.
//
// Runs the real bootFromLocalSession_ and emailFromCredential_ from index.html.
'use strict';

const { test, equal, ok, notOk, deepEqual } = require('./helpers/harness');
const { buildContext } = require('./helpers/app-source');

// A real-shaped (unsigned) Google credential. emailFromCredential_ never
// verifies it — the backend does that independently on every request — it only
// reads who is signing in, to decide whose local data may be painted early.
function credentialFor(email, name) {
  const b64url = (o) => Buffer.from(JSON.stringify(o)).toString('base64')
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  return [b64url({ alg: 'RS256' }), b64url({ email, name: name || email, aud: 'x' }), 'sig'].join('.');
}

function buildBoot(opts) {
  const events = [];
  const ctx = buildContext({
    functions: ['emailFromCredential_', 'bootFromLocalSession_', 'tryOfflineBoot_'],
    vars: { googleIdToken: opts.googleIdToken || null, currentUser: null, offlineMode: false },
    stubs: {
      lastKnownUserEmail_: () => opts.storedEmail,
      openLocalDb_: async (email) => { events.push('openLocalDb_:' + email); },
      readSessionRecord_: async () => (opts.session === undefined
        ? { email: opts.storedEmail, nome: 'Stored', role: 'admin', projects: '*', sections: {} }
        : opts.session),
      loadLocalStore_: async () => { events.push('loadLocalStore_'); return opts.hasLocalData !== false; },
      filterCacheAgainstCurrentPermissions: () => { events.push('filter'); },
      hideAuthGate: () => { events.push('hideAuthGate'); },
      finishLoadSetup: () => {},
      renderAll: () => { events.push('renderAll'); },
      updateSyncStatusText: () => {},
      resumeJournaledUploads_: async () => { events.push('resumeJournaledUploads_'); },
      renderUploadTray_: () => {},
    },
  });
  return { ctx, events };
}

test('F2: a different account signing in never opens the stored account', async () => {
  const { ctx, events } = buildBoot({ storedEmail: 'a@example.com' });
  const signingInAs = ctx.emailFromCredential_(credentialFor('b@example.com'));
  equal(signingInAs, 'b@example.com');

  const rendered = await ctx.bootFromLocalSession_(true, signingInAs);

  notOk(rendered, 'must decline: this credential is not the stored account');
  deepEqual(events, [], 'the previous account\'s database must not even be opened');
  equal(ctx.currentUser, null, 'and their identity must not be adopted');
});

test('F2: the same account signing in still gets the fast path', async () => {
  const { ctx, events } = buildBoot({ storedEmail: 'a@example.com' });
  const signingInAs = ctx.emailFromCredential_(credentialFor('a@example.com'));

  const rendered = await ctx.bootFromLocalSession_(true, signingInAs);

  ok(rendered, 'the returning-user fast path must be preserved');
  ok(events.indexOf('openLocalDb_:a@example.com') > -1);
  ok(events.indexOf('hideAuthGate') > -1, 'the app is on screen before verify answers');
  equal(ctx.currentUser.email, 'a@example.com');
});

test('F2: casing and surrounding whitespace do not defeat the match', () => {
  const { ctx } = buildBoot({ storedEmail: 'a@example.com' });
  equal(ctx.emailFromCredential_(credentialFor('A@Example.COM')), 'a@example.com');
});

test('F2: an unreadable credential declines rather than guessing', async () => {
  const { ctx, events } = buildBoot({ storedEmail: 'a@example.com' });
  // If we cannot tell who is signing in, opening the last person's session is
  // exactly the crossover this guards against. Costs one round trip; the
  // alternative costs someone else's financial records.
  equal(ctx.emailFromCredential_('not-a-jwt'), null);
  equal(ctx.emailFromCredential_(''), null);
  equal(ctx.emailFromCredential_(null), null);

  notOk(await ctx.bootFromLocalSession_(true, null), 'provisional boot with an unreadable credential');
  notOk(await ctx.bootFromLocalSession_(false, null), 'offline fallback with an unreadable credential');
  deepEqual(events, [], 'nothing opened in either case');
});

test('F2: a credential with no email claim is treated as unreadable', () => {
  const { ctx } = buildBoot({ storedEmail: 'a@example.com' });
  const b64url = (o) => Buffer.from(JSON.stringify(o)).toString('base64').replace(/=+$/, '');
  equal(ctx.emailFromCredential_(['h', b64url({ sub: '123' }), 's'].join('.')), null);
});

test('F2: a non-ASCII name in the payload does not break decoding', () => {
  const { ctx } = buildBoot({ storedEmail: 'a@example.com' });
  // The payload is UTF-8 and carries a display name; decoding it as latin-1
  // would corrupt it and could throw inside JSON.parse.
  equal(ctx.emailFromCredential_(credentialFor('joao@example.com', 'João Conceição')), 'joao@example.com');
});

test('F2: the offline launch path (no credential at all) is unchanged', async () => {
  // initAuth's fallback when Google's script never loads. Nobody has signed in,
  // so "the last person on this device" is the only meaningful answer and the
  // 30-day offline session must still open.
  const { ctx, events } = buildBoot({ storedEmail: 'a@example.com' });
  const rendered = await ctx.tryOfflineBoot_();

  ok(rendered, 'the offline boot must still work');
  ok(events.indexOf('openLocalDb_:a@example.com') > -1);
  equal(ctx.offlineMode, true, 'and it must set the offline posture');
});

test('F2: an expired session record still declines, matching account or not', async () => {
  const { ctx, events } = buildBoot({ storedEmail: 'a@example.com', session: null });
  notOk(await ctx.bootFromLocalSession_(true, 'a@example.com'), 'past the 30-day grace');
  ok(events.indexOf('loadLocalStore_') === -1, 'no data is loaded for an expired session');
});

test('F2: no stored account at all declines cleanly (first-ever launch)', async () => {
  const { ctx } = buildBoot({ storedEmail: null });
  notOk(await ctx.bootFromLocalSession_(true, 'b@example.com'));
  notOk(await ctx.tryOfflineBoot_());
});

test('F2: a stored account with an empty database declines and adopts nobody', async () => {
  const { ctx } = buildBoot({ storedEmail: 'a@example.com', hasLocalData: false });
  notOk(await ctx.bootFromLocalSession_(true, 'a@example.com'));
  equal(ctx.currentUser, null, 'identity must be released when there is nothing to show');
});

test('F2: provisional boot without an expected email is refused outright', async () => {
  // Defensive: a future caller that forgets to pass the account must fail
  // closed, not fall back to lastKnownUserEmail_.
  const { ctx, events } = buildBoot({ storedEmail: 'a@example.com' });
  notOk(await ctx.bootFromLocalSession_(true));
  deepEqual(events, []);
});
