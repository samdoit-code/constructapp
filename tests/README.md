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

Against `ece95b5` (the commit before the per-project-tabs / `nota` change) the
result is **40 failed, 56 passed**: 40 of the 45 tests in
`schema-partition.test.js` and `entry-nota.test.js` fail there. The five that
pass on both sides are the invariants — standalone notes still being real
Notas rows, a scoped role still being refused a cross-project write, and the
transitional mode reading and writing the legacy tabs exactly as the old code
did (which is the point: that mode IS the old behaviour).

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

### `schema-partition.test.js` — per-project entry tabs and the column order
- **Per-project tabs:** each project's lançamentos live in their own
  `<Projeto> - CaixaObra` / `- Empreiteiro` tab, resolved by the tab's stable
  numeric sheet id (stored on the Projetos row), never by its name. Covers
  routing an upsert to the right tab, a hand-renamed tab still being found and
  left alone, a STALE stored id throwing instead of name-guessing, a
  cross-project move being a move rather than a duplicate, and
  rename/delete touching only that project's tabs.
- **The whole-tab trap, one column over:** a `Projetos` save (which sends the
  ENTIRE array) must not blank `caixaSheetId`/`empSheetId`. Identical in shape
  to the `driveFolderId` bug, and the test asserts the columns genuinely exist
  first — otherwise it passes vacuously on a schema that has neither.
- **Column order:** `SHEETS[key].cols` is the single source of truth, and the
  first test pins this file's `SCHEMA` mirror against it. Also asserts the
  requested A:M order really is what the schema produces (`id` in K on
  CaixaObra, J on Empreiteiro) — as a *consequence* of the array, never
  hardcoded.
- **Hand-entered rows:** a row typed straight into the spreadsheet with no id,
  `criadoEm` or `projeto` comes back complete and stable across reads;
  `onEdit` stamps those fields at edit time (including a multi-row paste), and
  refuses to stamp a tab whose header no longer matches the schema. A row
  *cleared* by hand is not resurrected as a phantom lançamento.
- **The deploy window:** the transitional mode (legacy shared tabs still
  present) reads and writes correctly in the OLD column order, and the
  migration is a dry run by default, loses no rows, folds note threads, and is
  a no-op on a second run.
- *Invariants:* conflict detection and upsert idempotency still hold when an
  id lives in a non-first tab; a project-scoped role can still neither read,
  write nor delete in another project's tab (run deliberately — the `'*'`
  admin in most fixtures skips that pass entirely).

### `entry-nota.test.js` — one note per lançamento, and the derived feed
- **The invariant that matters:** an entry's note is the `nota` column on its
  own row, and produces **no** Notas row. The Notas page still shows entry
  notes, but *derives* them at render time — so the assertion is that nothing
  ever emits a second stored copy. The fixture deliberately also carries a
  legacy nested `notas` array, so the test cannot pass vacuously.
- The `nota` key is always sent, `''` included, so the backend can tell a
  deliberate clear from an old cached client that has no concept of the column
  (which would otherwise wipe the note on every edit).
- *Source-level invariants:* the per-entry note thread is gone rather than
  hidden, the feed derives from `e.nota`, a derived card is marked so its
  action menu routes Editar into the lançamento's own form, and
  `editNoteRef`/`deleteNoteRef` handle standalone notes only.

### `parsing.test.js` — money
- **F3:** `1.500` parsed as `1.5`, so R$ 1.500,00 was recorded as R$ 1,50 with
  no error and no retry. The only audit finding that could write a wrong number
  into the books.
- *Invariants:* the fix is narrow — `1.5`, `1.50`, `1500.50`, `150,50`,
  `1.500,50` and `1,500.50` all keep their existing meanings.

## What a retained suite cannot catch

Worth knowing, so nothing here is mistaken for more coverage than it is:

- **`LockService` is a no-op in the mock.** A nested `waitLock` from an
  execution that already holds the script lock — which real Apps Script will
  not grant — is completely invisible here. Lock nesting has to be reasoned
  about at the call site; see the note on `resolveOrCreateEntrySheet_` in
  `backend/Code.js`, which is a bug that was found by reading, not by running.
- **Execution time limits.** The mock has none, so a migration that would
  exceed Apps Script's 6-minute ceiling on real data passes here in
  milliseconds. That is why the migration reports row totals for a human to
  check rather than only returning `ok`.
- **Real browser layout.** These tests run functions in a `vm`, not a page. An
  end-to-end pass (real `index.html` in Chromium against the real
  `backend/Code.js`) is still the right tool before shipping anything that
  touches the schema or the sync engine.
- **The spreadsheet view's windowing, specifically.** `sheet-view.test.js`
  pins the arithmetic that would lie silently if it broke (row numbers,
  spacer heights, the mounted slice being bounded) — but *which* rows the
  window should hold is derived from a real on-screen rect and a real scroll
  position, and there is neither here. The cost it exists to prevent is a
  layout cost the `vm` cannot show at all: measured in Chromium, a 1,400-row
  tab went from 2,421 ms and 14,009 live form controls to 155 ms and 509, and
  a 5,000-row tab from 11,433 ms and 50,009 controls to 149 ms and 509. Any
  change to the window (overscan, row-height measurement, the focus guard)
  needs a real browser again; asserting on mounted-control count is the
  dimension that moves with the real one, the same way range-call count
  stands in for latency on the backend.

## Adding a test

1. Put it in the file that matches the subsystem, next to the invariants it
   belongs with.
2. Say in the test name or a comment WHAT breaks if it fails — a bare
   `equal(a, b)` tells the next person nothing about why it mattered.
3. Negative-control it (above) before trusting it.
