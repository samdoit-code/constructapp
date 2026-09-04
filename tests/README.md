# Regression suite

```
node tests/run.js            # everything
node tests/run.js sync       # only files whose name contains "sync"
```

No dependencies, no `package.json`, no build step — the same constraint the app
ships under. Node 18+ (uses `atob` and `TextDecoder` as globals).

## What this is for

This suite exists because of a specific, repeated failure mode in this project:
every fix so far was verified by a throwaway harness that was then deleted, so
nothing protected any of it from the next change. Two of the defects the
September 2026 audit found — a permanent silent sync stall, and an account
crossover on the fast boot path — were introduced by changes whose own testing
was thorough. They were exactly the kind of thing a retained suite catches.

It is deliberately small. It does not chase coverage; it protects the handful of
places where a regression is silent, expensive, or touches money.

## How it works

Nothing here re-implements the code it asserts on.

- **Backend tests** load the real, unmodified `backend/Code.js` into a mocked
  Apps Script environment (`helpers/apps-script.js`) and drive it through real
  `doPost()` calls. This is the technique CLAUDE.md Section 8 prescribes.
- **Frontend tests** extract the real named functions out of `index.html`
  (`helpers/app-source.js`) and run them in a `vm` with stubbed dependencies.
  A copy of a function stops being the shipped code the moment someone edits it,
  which is exactly when the test needs to still be looking at the real thing.

`helpers/app-source.js` relies on every declaration inside the IIFE being
indented two spaces, with functions closing on a line of exactly `  }`. If a
function under test is renamed or reindented, extraction fails loudly with a
clear message rather than silently testing nothing.

## The negative control — do this for every new regression test

A test that has not been shown to FAIL on the buggy code proves nothing about
the fix. Both helpers take an environment override so the whole suite can be
pointed at an older commit:

```sh
mkdir -p /tmp/prev
git show <commit-before-the-fix>:index.html      > /tmp/prev/index.html
git show <commit-before-the-fix>:backend/Code.js > /tmp/prev/Code.js

CMOREIRA_APP=/tmp/prev/index.html CMOREIRA_BACKEND=/tmp/prev/Code.js node tests/run.js
```

Against `076836b` (the commit before this suite was written) the result is
**24 failed, 19 passed**, with the three headline defects reporting themselves
directly — "the verdict path never settled — the sync queue is deadlocked",
`sem acesso a esta seção` on an already-absent delete, and the stale ids left in
the diff baseline.

The tests that PASS in that run are not weak — they are the invariant tests
(see below), which are meant to hold on both sides and to catch a FUTURE break.

## What is covered, and why each one is here

### `backend-authz.test.js` — the two-axis authorization model
- **F1 (backend):** deleting a Notas/Fotos row the server no longer has used to
  throw `sem acesso a esta seção`, even for an admin with `'*'` projects, and
  rejected the whole all-or-nothing batch with it. Routine trigger: a delete
  whose response was lost and retried.
- Two latent project-scope bugs found alongside it: a scoped user could never
  delete any photo (`projectOfRow` returned undefined for every fotos delete)
  or any document (it was looked up in an index that never holds documents).
- *Invariants:* a delete of a row that EXISTS is still fully authorized; a row
  that exists but resolves to no known parent still fails closed; forged
  role/permission claims in the request body are ignored; cross-cutting
  Notas/Fotos rows are gated by their PARENT's section, not the page they render
  on; deny-by-default for an unknown role; conflict and deleted-elsewhere
  reporting; upsert-by-client-id idempotency.

### `sync-engine.test.js` — the outcome model's error paths
- **F1 (client):** `discardRejected_` enqueued onto the `syncQueue` link it was
  already running inside, so any server verdict deadlocked the engine
  permanently and silently. The `settlesWithin` assertion is the point: a wedged
  queue produces a promise that never settles, which without a deadline hangs
  the runner instead of failing it.
- **F1 (trigger):** `flushFileDeletes_` left already-deleted ids in
  `sheetSnapshot`, so the next diff emitted the very delete the backend refused.
- *Invariants:* an ordinary hydration still goes THROUGH the queue (the fix must
  not turn it into an unqueued apply); `runSync_` always releases
  `syncInFlight`; refused ids are released even when the refresh fails.

### `boot-account.test.js` — provisional boot and account identity
- **F2:** `bootFromLocalSession_` chose whose data to paint from
  `lastKnownUserEmail_()` alone — the PREVIOUS person on a shared device.
- *Invariants:* the returning-user fast path still works; the credential-free
  offline launch still works; an unreadable credential declines rather than
  guessing; an expired session, an empty database and a first-ever launch all
  decline cleanly without adopting an identity.

### `parsing.test.js` — money
- **F3:** `1.500` parsed as `1.5`, so R$ 1.500,00 was recorded as R$ 1,50 with
  no error and no retry. The only audit finding that could write a wrong number
  into the books.
- *Invariants:* the fix is narrow — `1.5`, `1.50`, `1500.50`, `150,50`,
  `1.500,50` and `1,500.50` all keep their existing meanings.

## Adding a test

1. Put it in the file that matches the subsystem, next to the invariants it
   belongs with.
2. Say in the test name or a comment WHAT breaks if it fails — a bare
   `equal(a, b)` tells the next person nothing about why it mattered.
3. Negative-control it (above) before trusting it.
