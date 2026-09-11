// login_hint on the sign-in gate.
//
// A returning user on the iPhone PWA makes TWO taps on every cold launch: our
// own sign-in button, then "escolha uma conta" on accounts.google.com. The
// first is not removable (the popup needs a real user gesture, and prompt()
// has no session to find inside a standalone PWA's WKWebView partition). The
// second is Google's own chooser, and login_hint is the documented way to skip
// it.
//
// What these tests protect is not the tap count — that is Google's UI and no
// test here can observe it — but the two properties the app is responsible for:
// WHICH stored email is handed over, and that nothing is handed over once the
// session has ended.
//
// Runs the real initAuth from index.html.
'use strict';

const { test, equal, ok, notOk } = require('./helpers/harness');
const { buildContext, extractDeclaration } = require('./helpers/app-source');

// initAuth closes over GOOGLE_CLIENT_ID as a lexical `const`, so it is
// reachable from the extracted code but never a property of the vm context.
// Read the real literal out of index.html instead of re-typing it here.
const CLIENT_ID = extractDeclaration('GOOGLE_CLIENT_ID').match(/'([^']+)'/)[1];

function buildAuth(opts) {
  opts = opts || {};
  const calls = [];
  const ctx = buildContext({
    functions: ['initAuth'],
    declarations: ['GOOGLE_CLIENT_ID'],
    vars: {
      gisWaitTicks: 0,
      pendingTokenRefreshOnly: false,
      // The case being optimised is the home-screen PWA, where the silent
      // restore below is skipped entirely and the button is all there is.
      isStandalone: opts.isStandalone !== false,
    },
    stubs: {
      window: { google: true },
      google: {
        accounts: {
          id: {
            initialize: (cfg) => { calls.push(cfg); },
            prompt: () => {},
          },
        },
      },
      lastKnownUserEmail_: () => opts.storedEmail || null,
      // Deliberately false by default: the 5-minute session hint has long
      // expired on the cold launch hours later that this feature is for.
      hasFreshSessionHint: () => !!opts.freshHint,
      onGoogleSignIn: function onGoogleSignIn() {},
      renderGoogleButton: () => {},
      showAuthGate: () => {},
      clearSessionHint: () => {},
      tryOfflineBoot_: async () => false,
      showToast: () => {},
    },
  });
  ctx.initAuth();
  return { ctx, calls, cfg: calls[0] };
}

test('login_hint: the stored account is handed to Google so its chooser can be skipped', () => {
  const { cfg } = buildAuth({ storedEmail: 'samuel@example.com' });
  equal(cfg.login_hint, 'samuel@example.com');
});

test('login_hint: comes from the DURABLE pointer, not the 5-minute session hint', () => {
  // The whole point is a cold launch hours later, when hasFreshSessionHint()
  // is false and the silent-restore path is not taken at all. Wiring the hint
  // to the session hint instead would make it useless exactly when it matters.
  const { cfg, ctx } = buildAuth({ storedEmail: 'samuel@example.com', freshHint: false, isStandalone: true });
  equal(cfg.login_hint, 'samuel@example.com');
  notOk(ctx.pendingTokenRefreshOnly, 'the silent-restore branch must not have run here');
});

test('login_hint: absent entirely when no account is stored — never an empty string', () => {
  // purgeLocalData_ clears LAST_USER_KEY, so this is the state after an
  // explicit sign-out or any auth refusal: the chooser must come back for
  // whoever is holding the device next. An empty login_hint is not the same
  // as no login_hint.
  const { cfg } = buildAuth({ storedEmail: null });
  notOk('login_hint' in cfg, 'the key itself must be omitted, not sent blank');
});

test('login_hint: a first-ever sign-in on a fresh device is unaffected', () => {
  const { cfg, calls } = buildAuth({ storedEmail: null });
  equal(calls.length, 1, 'initialize is still called exactly once');
  notOk('login_hint' in cfg);
});

// Invariants — these must hold on both sides of the change.
test('login_hint: the rest of the GIS config is untouched', () => {
  const { cfg } = buildAuth({ storedEmail: 'samuel@example.com' });
  equal(cfg.client_id, CLIENT_ID, 'must match Code.js exactly — a mismatch has broken auth before');
  equal(typeof cfg.callback, 'function');
  equal(cfg.callback.name, 'onGoogleSignIn', 'the one shared GIS callback');
  ok(cfg.cancel_on_tap_outside);
});
