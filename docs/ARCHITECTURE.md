# Construtora Moreira — Architecture

Reference spec for the app's data, sync and offline behaviour. `CLAUDE.md`
remains the operating manual (rules, conventions, reusable patterns, the
permission map); this document is the deeper "why it is shaped this way",
kept separate so `CLAUDE.md` does not have to carry a full spec inline.

Everything under **Implemented now** is in the code today. Everything under
**Possible future evolution** is not — that separation is deliberate and must
be maintained, because the most damaging thing an architecture document can do
is describe a guarantee the system does not actually provide.

---

## 1. The system in one page

| Layer | What it is |
|---|---|
| Frontend | One self-contained `index.html`. No framework, no build step. All JS inline in one IIFE. |
| Local store | IndexedDB, one database per signed-in account. Holds the server-confirmed baseline, the unsent delta, the reference lists, the session record, and photo bytes awaiting upload. |
| Transport | `fetch` POST to a Google Apps Script Web App. `text/plain` content type deliberately, to avoid a CORS preflight Apps Script cannot answer. |
| Backend | `backend/Code.js`, a container-bound Apps Script. Verifies a Google ID token on every request, then authorizes on two independent axes (section/action, project). |
| Database | Google Sheets. Six row-level tabs with `lastModified` conflict tracking; four whole-tab reference lists. |
| Files | Google Drive, per-project folders with `Fotos/` and `Documentos/` subfolders. |
| Auth | Google Identity Services (Sign-In / One Tap). The raw ID token lives only in memory. |
| Service worker | App-shell fallback only, network-first. Never caches the backend, never caches `version.json`, never caches a non-GET. |

The server is the source of truth. The device is a durable, authoritative-
enough replica that lets the user work at full speed regardless of the network.

---

## 2. Local-first: the model

### 2.1 The central idea — there is no operation log

What still needs sending is **derived**, never journalled:

```
pending  =  diff( local desired state , last server-confirmed baseline )
```

Persist both sides and "what is unsent" survives a reload, a crash, and iOS
discarding the webview — by construction, with:

- no idempotency keys to allocate,
- no operation ordering to replay,
- no compaction when a record is created and then deleted before either
  reached the server (it simply produces no diff),
- no dedupe when a response is lost and the batch is re-sent.

Five rapid toggles of one checkbox collapse into one row automatically, because
only the final desired value differs from the baseline.

**This is only safe because the wire protocol is already idempotent**, and that
is a precondition, not a coincidence:

- `applyBatch_` upserts by a **client-minted** id (`prefix_timestamp_random`),
- deletes are by id and are a no-op when the row is absent,
- `deletePhotos` / `deleteDocumentos` explicitly treat "already gone" as
  success.

So the dangerous case — *the server received and applied the write, but the
response never came back* — resolves correctly: the retry re-applies the same
content, and the only side effect is a stale `expectedLastModified`, which
`rebaseConflictsAgainstServer_` corrects in exactly one retry.

An operation-log outbox was considered and rejected. It would have needed every
one of the mechanisms listed above rebuilt, and it would have sat *alongside*
the diff machinery rather than replacing it.

### 2.2 What is stored locally

One IndexedDB database per account, named `cmoreira_v1_<email>`.

| Store | Contents | Written by |
|---|---|---|
| `baseline` | One flat sheet row per record, in exactly the shape `toSheetRows` emits. The last value the **server** confirmed. | a `getAll`, or a `batchMulti` response |
| `pending` | One entry per record that differs from baseline. The outbox — derived, not journalled. | every local write |
| `config` | The four whole-tab reference lists (`projects`, `tipos`, `unidades`, `socios`) plus which are unsent. | local writes and hydration |
| `meta` | Session record, last sync time, upload journal, queued Drive file deletions. | as needed |
| `blobs` | Photo/document bytes that have not reached Drive yet. Deleted the moment Drive has them. | the file picker |

`localStorage` keeps only what must be read **synchronously at boot before the
database is open**: the active project id, the session hint, the last-account
pointer, the boot-failure counter.

Rebuilding `sheetSnapshot` (the diff baseline) from the `baseline` store is what
makes `expectedLastModified` correct **across a restart** — which is precisely
what the pre-local-first cache could not do, and the direct cause of a
production bug where a checkbox tapped in the seconds after a cache-first boot
false-conflicted and rejected an entire batch.

### 2.3 The write path

```
user acts
   ↓
mutate in-memory state, paint            ← the user sees the result here
   ↓
persistPending_()  → IndexedDB           ← the write is now DURABLE; saveKey resolves
   ↓
scheduleSync_()                          ← leading 150ms window, coalesces a burst
   ↓
flushPending_()   (serialized via syncQueue)
   ├─ dirty reference lists  → saveSheet (whole tab)
   ├─ queued Drive deletions → deletePhotos / deleteDocumentos
   └─ everything else        → batchMulti with expectedLastModified
   ↓
outcome
```

`saveKey` resolves when the change is durable **on this device**, not when Apps
Script has confirmed it. Call sites no longer have a failure branch to write.

### 2.4 The three outcomes

Collapsing these is what used to turn a bad signal into lost work.

| Outcome | Meaning | Response |
|---|---|---|
| `ok` | On the server. | Baseline advances, pending clears. |
| `retry` | Could not reach or could not be answered — offline, timeout, a busy script lock, a rate-limited token check. | Stays pending. Retried with backoff (2s → 5s → 15s → 30s → 60s), plus immediately on the `online` event and on foreground return. **Never surfaced as an error.** |
| `verdict` | Refused: no permission, or a real concurrent edit that survived one rebase. | Not retried — it can only fail again. The refused ids are dropped from pending and the **server's own value** is restored for them. |

This mirrors, on the client, the rule the backend already learned in
`verifyIdToken_`: *"I could not check"* is never *"you are not who you say you
are."*

### 2.5 Conflicts

Unchanged in model, and still row-level last-write-wins with no field merging
anywhere:

1. A stale `expectedLastModified` → rebase against the `currentLastModified`
   the server reports, retry **once**. A false conflict caused by our own stale
   baseline always resolves here, because nothing else is racing it.
2. A second conflict on the same row → genuine contention. Stand down, take the
   server's value, say so.
3. A row reported `deleted` → dropped locally, never re-sent. Re-sending it is
   what used to resurrect records another device had deleted.

### 2.6 Hydration must never overwrite unsent work

**Invariant.** A background refresh may not discard a local change the user has
already seen accepted.

`applyServerData_` captures the pending delta **before** anything is rebuilt,
makes the server's data the new confirmed baseline, then re-applies the delta on
top. The ordering is load-bearing in both directions: capture after the rebuild
and there is nothing left to capture; re-apply before the snapshot rebuild and
the unsent change is baked into its own baseline and never sent at all.

Before this, only a task's `feito` flag was protected this way
(`reapplyPendingTaskChanges_`); an unsent entry edit, note, or deletion was
silently discarded by any refresh that happened to land.

A second hazard is the response that is *itself* stale: a `getAll` whose fetch
started before a write landed would erase that write from the screen even though
the server had accepted it. `writeEpoch` is incremented on every confirmed
write and checked before the response is applied.

### 2.6a Boot reconciliation — render first, let verify win

A returning user's data is already on this device and the server already
authorized it when it got here. So `verify`'s answer is needed to RECONCILE
what is shown, not to decide whether to show it, and awaiting it before drawing
anything bought nothing but a round trip of blank screen (measured 3,241 ms on
a 3 s connection).

`onGoogleSignIn` now races them:

```
credential arrives
   ├─ bootFromLocalSession_(provisional: true)   → app on screen in ~75ms
   └─ verify()                                   → reconciles when it lands
```

`bootFromLocalSession_` is the same function the offline path uses; the only
difference is `offlineMode`, and whether the app expects an answer shortly.

**The authoritative result always wins**, in every branch:

| verify says | What happens |
|---|---|
| valid, same permissions | nothing visibly changes; hydration proceeds |
| valid, permissions narrowed | `filterCacheAgainstCurrentPermissions()` re-runs against the fresh answer, dropping the now-disallowed rows from state **and from the diff baseline**, before the next paint |
| refused (revoked / deactivated) | local database purged, in-memory state cleared, gate back up |
| unreachable | posture switches to `offlineMode`; nothing is purged |

Two things make this safe rather than merely fast:

1. **The reconciliation path never re-reads the local store.** `loadAll(alreadyRendered)`
   skips `loadLocalStore_()` entirely. The user may have been typing for a
   whole round trip; rebuilding every array from IndexedDB would erase a write
   whose persist had not landed yet — from memory *and* from disk. So
   reconciliation touches permissions and the server hydration only.
2. **Narrowing permissions must not delete data.** `filterCacheAgainstCurrentPermissions()`
   trims the desired state; `sheetSnapshot` is the confirmed-baseline side of
   `diff(desired, baseline)`. Trimming only the desired side turns every row
   the user may no longer see into a pending DELETE, and the next sync would
   erase from the spreadsheet exactly the data the narrower scope was meant to
   protect. Both sides are trimmed, so those rows leave the diff universe
   entirely — which is the honest model, since the server never sent them to
   this user in the first place. (This was a latent bug from the moment the
   baseline became persistent: it could only fire for a project-scoped role,
   and the `'*'` admin used in earlier tests made the filter a no-op.)

### 2.7 Offline boot and the 30-day session

Before: launching with no signal was impossible *and* destructive. `verify` was
awaited before anything rendered, its failure was treated as a rejected
identity, and the catch deleted the whole local dataset — measured at 987 KB to
0 KB on one signal-less launch. Google's sign-in script also comes from
`accounts.google.com`, so the button never rendered either: the gate was simply
dead.

Now, a session record (`{email, nome, role, projects, sections, verifiedAt}`)
is written after every successful `verify`. If the server cannot be reached and
that record is younger than **30 days**, the app opens on it.

**What that grace window actually costs, stated plainly:** for up to 30 days
after their last successful verify, a user who has been deactivated or demoted
keeps *read* access to what this one device already downloaded. They cannot
read anything new — there is no token in that state, so no request can be made
at all — and they cannot write anything the server will accept, because a
queued write is authorized when it is finally sent, not when it was made. The
moment connectivity returns, `verify` runs, and a refusal purges the device.

The local database is purged **only** on an authentication verdict or an
explicit sign-out. Never on a transport failure. A second consecutive non-auth
boot failure also purges, which preserves the original recovery property (if
the stored data is itself what breaks the boot, keeping it guarantees the next
attempt breaks identically) without destroying a working device's data because
it was launched in a lift.

Each account gets its own database, and signing in drops every other account's.
The previous single `localStorage` cache was global.

### 2.8 Photos

Bytes are written to the `blobs` store **at pick time**, before anything else
touches them, and deleted the moment Drive has them. The pre-existing journal
only ever recorded a job *after* Drive had the bytes, which left the other half
of the gap open: a photo picked with no signal existed solely as an in-memory
`File`, so a reload lost it with no trace and no error — on a job site with no
signal, which is exactly when photos get taken.

The upload runner declines to drain while `navigator.onLine === false`, so a
queued batch waits instead of burning every file's 90-second deadline and
turning "no signal" into a tray full of manual retries.

Budget: 200 MB of queued bytes (the browser reported ~938 MB of quota here);
beyond that the picker says so rather than failing quietly.

### 2.8a What the activity hub is for

The hub has four layers in strict priority: outcome message > active uploads >
a slow foreground request > sync state. The sync layer is deliberately the
narrowest of the four.

**Routine synchronisation is not an event.** A write is durable before a
request is even made, so "sincronizando…" and "N alterações para enviar" were
reporting internal bookkeeping that resolves in about 150 ms and that the user
can do nothing with. Drawing them meant the hub blinked on essentially every
tap, which turns the one surface that should mean *read this* into background
noise — the exact opposite of why three separate indicators were consolidated
into it.

The sync layer now draws only what a person can act on or genuinely needs to
know: **no connection**, **needs to sign in again**, or **actually failing and
backing off** (`syncFailures > 0`, which can only become non-zero after a real
round trip has failed, so it cannot fire during the ordinary sub-second pending
window). The verify handshake, boot reconciliation and every successful round
trip are silent.

Nothing about the sync engine changed: the same states are tracked, the same
errors are classified, the same retry schedule runs. This decides only what is
drawn. Save confirmations, refusals, conflicts, deleted-elsewhere notices and
offline state are all still shown, because those are things the user needs.

### 2.9 Drive file deletions

Trashing a Drive file is a server-side action that cannot be expressed as a row
diff, so it has its own small durable queue in `meta`, drained **before** the
row batch. The ordering is the whole point: the server resolves which file a
row points at *from the row*, so deleting the row first would strand the file in
Drive with nothing referencing it. The row batch is explicitly told to leave
those ids alone until the queue has drained.

---

## 3. Decisions, and what was rejected

| Decision | Rejected alternative | Why |
|---|---|---|
| Derived diff as the outbox | An operation log with idempotency keys | The protocol is already idempotent by id, and the app already maintained a confirmed baseline. An op log would duplicate the diff machinery and add ordering, dedupe and compaction as new places to be wrong. |
| IndexedDB for the store | Keep localStorage | Not because IndexedDB is faster — **it is not, uniformly**. Measured at ~3,000 entries: single-record write 0.7 ms vs 22 ms whole-blob (30× better, and that is the tap path), but bulk hydration 152 ms vs 22 ms and boot read 42 ms vs 3 ms (both worse, both off the critical path). It wins where this design lives and loses where it does not matter. Quota ~938 MB vs ~5 MB decides the photo question outright. |
| localStorage retained for four small values | Move everything | They are read synchronously at boot, before the database is open. |
| `online` event + backoff + foreground check | Background Sync API | iOS Safari, the primary target, does not implement it. It would be dead code on the only device that matters. |
| Removed `pendingTaskChanges` | Keep it beside the new model | Its three invariants (per-task rollback, newest-intention-wins, no dependence on the user stopping) are all provided structurally by the general model. Keeping it would be a second pending mechanism for one data type. |
| Removed `cloneState_` / `restoreStateArray_` | Keep whole-array rollback | Rolling back on a network failure *is* the behaviour that destroyed work. A refusal now restores the server's own value for exactly the refused rows — more accurate than any client clone, and structurally immune to the "whole-array restore erases a concurrent mutation" trap that had forced every hot path into bespoke per-record rollback. |
| Project rename/delete stay online-only | Make them work offline | They are server-side bulk rewrites across thousands of rows in six sheets. A half-applied local cascade is far worse than "precisa de conexão". |
| Whole-tab lists resend current state | Row-level pending for them | `saveSheet` replaces the entire tab; there is no row-level conflict tracking on the wire for these. Modelling something the protocol cannot use would be fiction. |
| Render from the local store before `verify` returns | Await `verify` as the gate | The data is already on the device and the server already authorized it; `verify` reconciles what is shown rather than deciding whether to show it. 3,241 ms → 71 ms for a returning user on a slow link, with the authoritative result still winning in every branch. |
| Routine sync draws nothing in the hub | Show a "sincronizando" pill | It resolves in ~150 ms and the user can do nothing with it, so it made the hub blink on every tap and devalued the messages that matter. |
| No backend changes | Add a `since` cursor / change feed | Once writes are local-first, the full `getAll` is off the perceived path entirely. An incremental read would need server-side tombstones to report deletions correctly, and this project has a documented history of Apps Script deploys that look green and ship nothing. Not worth the risk for something the user cannot feel. |

---

## 4. Measured

Same harness both times: the real `backend/Code.js` in a mocked Apps Script
`vm`, the real `index.html` in Chromium at iPhone 14 Pro Max viewport, timings
taken in-page from the real click event. Dataset: 2,600 CaixaObra + 400
Empreiteiro + 120 Tarefas + 300 Notas + 900 Fotos + 60 Documentos.

**Entry save — tap to the entry being visible**

| Network | Before | After |
|---|---|---|
| 0 ms | 101 ms | **48 ms** |
| 300 ms | 415 ms | **49 ms** |
| 1.5 s | 1,598 ms | **52 ms** |
| 4 s | 4,070 ms | **48 ms** |
| stalled (opens, never answers) | **92,203 ms**, then the write was discarded | **~48 ms**, write kept and queued |
| offline | 2,210 ms, write discarded | **47 ms**, write kept and queued |

The save no longer tracks network latency at all. At 4 s that is 85× faster to
visible, and the POST has not even been issued by the time the entry is on
screen (the sync engine's leading window is 150 ms).

For contrast, the two paths that were already optimistic are unchanged:
task checkbox 21-22 ms, note post 35-36 ms, both independent of latency.

**Offline**

| | Before | After |
|---|---|---|
| Entry save with no connectivity | failed after 2.2 s, record gone, did not survive a reload | accepted in 47 ms, durable, syncs on reconnect |
| Cold launch, no signal at all | gate up with nothing to tap — Google's sign-in script cannot load, so the button never rendered | app usable in **1.9 s**, database intact |
| Cold launch, signal bad enough that `verify` fails | the sign-in attempt purged the cache: 987 KB → **0 KB** | database intact; a second consecutive non-auth failure still clears it |

Both failures were reproduced and negative-controlled against the previous
commit served from a second directory — identical script, both runs in the same
process: *"the offline write reached the server"* false before / true after, and
*"app usable with no connectivity"* false before / true after.

**Boot (credential accepted → app on screen)**

| Network | First-time user | Returning user |
|---|---|---|
| 0 ms | 99 ms | **78 ms** |
| 800 ms | 1,702 ms | **73 ms** |
| 3 s | 6,111 ms | **71 ms** |

A returning user no longer waits for the network at all — 46× faster than the
3,241 ms this cost when `verify` was awaited before anything rendered. A
first-time user is unchanged and still waits, correctly: there is nothing
stored to render, so there is nothing to be early about.

---

## 5. The single-writer assumption

**Implemented now.** The app is optimised around one primary person entering
data. That is an optimisation, and these are the places it is load-bearing:

1. **Row-level conflicts are last-write-wins with no field merge.** Two people
   editing the same lançamento means one of them loses their edit. One rebase
   and retry resolves a *stale baseline*; a second conflict is reported, not
   merged.
2. **The four whole-tab reference lists have no conflict tracking at all.** An
   offline edit to the project list replays as a whole-tab replace against
   whatever the server holds by then.
3. **Deletions made elsewhere are only learned through a full `getAll`.** There
   are no server-side tombstones, so a device that has not refreshed does not
   know a row is gone until it tries to write it (which is correctly reported as
   `deleted`, not resurrected).
4. **The 30-day offline grace assumes a device belongs to one person.**

None of this is a dead end. The store, the derived-diff outbox, the three
outcomes and the hydration invariant are all independent of how many writers
there are.

**Possible future evolution** (none of this exists today):

- *Multiple devices, same user.* Already works, with the caveats above. The
  practical gap is refresh frequency, not correctness.
- *Multiple concurrent writers.* Needs field-level merge for the two or three
  fields where it actually matters (a lançamento's `valor`, a task's `feito`),
  not a general CRDT.
- *Incremental sync.* Needs a `since` cursor plus server-side tombstones — a
  `getAll` filtered by `lastModified` cannot report deletions. A cheaper first
  step is a `getManifest` action returning ids + `lastModified` only (~60 KB
  against the current ~973 KB), from which a missing id *is* a deletion.
- *Change feed / push.* Apps Script has no push channel. Polling the manifest is
  the realistic ceiling.
- *Row-level `Projetos`.* Would remove the whole-tab clobber risk in (2).
- *Per-user permissions.* Today `Papeis` is per-role; a per-user override layer
  would sit on top of `sectionsForRole_` without touching this design.

---

## 6. Reusable lessons

For the next app on this stack (or any local-first client over a slow,
transactional backend):

1. **Make the wire protocol idempotent first.** Upsert by a client-minted id,
   make delete a no-op when absent, and treat "already gone" as success. Every
   retry question becomes easy afterwards, and an operation log stops being
   necessary at all.
2. **Derive the outbox; do not journal it.** If you keep a confirmed baseline
   and a desired state, "what is unsent" is a diff. Diffs collapse, dedupe and
   compact themselves.
3. **"Could not reach" and "was refused" need opposite handling.** Give the sync
   result three outcomes, not a boolean. A transport failure must never be a
   user-visible error, and a refusal must never be retried.
4. **Never let a network failure roll back accepted work.** Rollback belongs to
   refusals, and the right thing to restore is the *server's* value, not a
   client-side clone taken before the mutation.
5. **A cache-first render needs an explicit answer to "what if a write fires
   before hydration lands".** Persist the baseline transactionally with the
   state so the answer is "nothing special happens".
6. **Hydration must preserve unsent local work, for every record type.** Capture
   the delta before rebuilding, re-apply after the baseline is set, and check
   that the response is not itself older than a write you have already
   confirmed.
7. **Measure before choosing storage.** IndexedDB is 30× better on the write
   path here and ~7× worse on bulk hydration. Neither number would have been
   guessable, and the wrong one would have made the app slower while looking
   more modern.
8. **Record the irreversible middle step before attempting the rest** — bytes in
   Drive, payment taken, message sent. And record the *input* to that step
   durably too, or work made offline exists only in memory.
9. **State the cost of an offline grace window in the document.** "A demoted
   user keeps read access to this device's existing data for N days" is a
   decision someone must be able to find and revisit.
