// F1 (client half) — the sync engine's error/verdict path.
//
// The engine has three outcomes and the verdict branch is the one nothing had
// ever driven end to end. It contained a self-deadlock: discardRejected_ called
// fetchAndApplyFromServer, which enqueued onto the very syncQueue link it was
// already running inside. The link could not resolve until the call returned
// and the call could not return until the link resolved, so ANY refusal wedged
// the engine permanently — silently, with runSync_'s syncInFlight stuck true,
// nothing drawn in the activity hub, and every later write staying local.
//
// These run the real enqueueSync_/fetchAndApplyFromServer/discardRejected_/
// runSync_/flushFileDeletes_ extracted from index.html, with only the transport
// and the state stubbed.
'use strict';

const { test, equal, ok, notOk, deepEqual, settlesWithin } = require('./helpers/harness');
const { buildContext } = require('./helpers/app-source');

// --- A faithful stand-in for the production call graph on the verdict path ---
// runSync_ -> enqueueSync_(flushPending_) -> ... -> syncSheetsNow_ refused
//          -> discardRejected_ -> fetchAndApplyFromServer -> enqueueSync_
function buildEngine(opts) {
  opts = opts || {};
  const log = [];
  const ctx = buildContext({
    functions: ['enqueueSync_', 'fetchAndApplyFromServer', 'discardRejected_'],
    vars: { syncQueue: Promise.resolve(), writeEpoch: 0 },
    stubs: {
      // The code under test logs on the failure path by design; keep the
      // runner's output about the assertions rather than about that.
      console: opts.getAllThrows ? { error: () => {}, warn: () => {}, log: () => {} } : console,
      rejectedIds: new Set(),
      persistPending_: async () => { log.push('persistPending_'); },
      renderAll: () => { log.push('renderAll'); },
      applyServerData_: () => { log.push('applyServerData_'); },
      scheduleRefreshSoon_: () => { log.push('scheduleRefreshSoon_'); },
      isAuthError: () => false,
      sheetsPost: async (body) => {
        log.push('POST ' + body.action);
        if (opts.getAllThrows) throw new Error('boom');
        return { currentUser: {}, caixaObra: [] };
      },
    },
  });
  return { ctx, log };
}

test('F1: a server verdict does not wedge the sync queue', async () => {
  const { ctx, log } = buildEngine();

  // The exact production shape: discardRejected_ runs INSIDE a syncQueue link.
  const flush = async () => {
    await ctx.discardRejected_(['row1', 'row2']);
    return 'verdict';
  };
  const outcome = await settlesWithin(
    ctx.enqueueSync_(flush), 2000,
    'the verdict path never settled — the sync queue is deadlocked (F1 regression)'
  );

  equal(outcome, 'verdict');
  ok(log.indexOf('applyServerData_') > -1, 'the server value must actually be re-applied for the refused rows');
  ok(log.indexOf('renderAll') > -1, 'and re-rendered');
});

test('F1: the queue still accepts and runs work after a verdict', async () => {
  const { ctx } = buildEngine();
  await settlesWithin(ctx.enqueueSync_(async () => { await ctx.discardRejected_(['row1']); }), 2000,
    'first verdict deadlocked');

  // The real damage was not the one refusal — it was that NOTHING synced again
  // for the rest of the session.
  const after = await settlesWithin(ctx.enqueueSync_(async () => 'still-alive'), 2000,
    'the queue is wedged: work enqueued after a verdict never ran (F1 regression)');
  equal(after, 'still-alive');
});

test('F1: two verdicts in a row both complete', async () => {
  const { ctx } = buildEngine();
  for (let i = 0; i < 2; i++) {
    await settlesWithin(ctx.enqueueSync_(async () => { await ctx.discardRejected_(['r' + i]); }), 2000,
      `verdict ${i + 1} deadlocked`);
  }
  const after = await settlesWithin(ctx.enqueueSync_(async () => 'ok'), 2000, 'queue wedged after two verdicts');
  equal(after, 'ok');
});

test('F1: refused ids are released even when the refresh itself fails', async () => {
  // rejectedIds gates whether a pending row is re-applied on top of a
  // hydration. An id left in that set is excluded from EVERY future hydration,
  // so it has to be released on the failure path too, not just the happy one.
  const { ctx } = buildEngine({ getAllThrows: true });
  await settlesWithin(ctx.enqueueSync_(async () => { await ctx.discardRejected_(['row1']); }), 2000,
    'the failing-refresh verdict path deadlocked');
  equal(ctx.rejectedIds.size, 0, 'rejectedIds must not leak when the refresh fails');
});

test('F1: a normal (non-verdict) hydration still goes through the queue', async () => {
  // The fix must not turn the ordinary background refresh into an unqueued
  // apply — that ordering is what stops a hydration landing between a write's
  // request and its response.
  const { ctx, log } = buildEngine();
  const order = [];
  const slowWrite = ctx.enqueueSync_(async () => {
    await new Promise((r) => setTimeout(r, 30));
    order.push('write');
  });
  const refresh = ctx.fetchAndApplyFromServer().then(() => order.push('apply'));
  await settlesWithin(Promise.all([slowWrite, refresh]), 2000, 'hydration did not settle');
  deepEqual(order, ['write', 'apply'], 'the apply must wait for the in-flight write to finish');
  ok(log.indexOf('applyServerData_') > -1);
});

test('F1: runSync_ always clears syncInFlight, even on a verdict', async () => {
  // syncInFlight stuck true is what made the deadlock permanent: scheduleSync_
  // early-returns while it is set, so no later write could even try.
  const ticks = [];
  const ctx = buildContext({
    functions: ['enqueueSync_', 'runSync_'],
    declarations: ['SYNC_BACKOFF_MS'],
    vars: { syncQueue: Promise.resolve(), syncInFlight: false, syncFailures: 0, syncBlockedReason: null },
    stubs: {
      pendingTotal_: () => 1,
      googleIdToken: 'tok',
      navigator: { onLine: true },
      renderUploadTray_: () => {},
      scheduleSync_: (ms) => ticks.push(ms),
      flushPending_: async () => 'verdict',
    },
  });
  await settlesWithin(ctx.runSync_(), 2000, 'runSync_ never returned');
  equal(ctx.syncInFlight, false, 'syncInFlight must be released so later writes can sync');
  equal(ctx.syncFailures, 0, 'a verdict is not a transport failure and must not accrue backoff');
  ok(ticks.length > 0, 'still-pending work is rescheduled after a verdict');
});

// --- F1's real-world trigger: a delete whose response was lost -------------
function buildFileDeletes(opts) {
  const posts = [];
  const ctx = buildContext({
    functions: ['flushFileDeletes_'],
    declarations: ['DELETE_CHUNK_SIZE'],
    vars: {
      pendingFileDeletes: { photo: opts.queued.slice(), doc: [] },
      sheetSnapshot: { fotos: opts.snapshot.map((id) => ({ id })), documentos: [] },
    },
    stubs: {
      sheetsPost: async (body) => { posts.push(body); return { ok: true, deleted: opts.serverReports }; },
      isPermissionError: () => false,
      reportSyncVerdict_: () => {},
      persistMeta_: async () => {},
      persistBaselineDelta_: async () => {},
      persistPending_: async () => {},
    },
  });
  return { ctx, posts };
}

test('F1 trigger: a delete the server reports as already-gone leaves the baseline clean', async () => {
  // deletePhotos reached the server, the response was lost, withRetry re-sent
  // it, and the retry legitimately reported `deleted: []`. Keeping those ids in
  // sheetSnapshot made the next diff emit a row DELETE for a row the server
  // does not have — the request that used to be refused, wedging the engine.
  const { ctx, posts } = buildFileDeletes({ queued: ['p1', 'p2'], snapshot: ['p1', 'p2', 'p3'], serverReports: [] });
  const outcome = await settlesWithin(ctx.flushFileDeletes_(), 2000, 'flushFileDeletes_ hung');

  equal(outcome, 'ok');
  equal(posts.length, 1, 'one chunked request');
  deepEqual(ctx.pendingFileDeletes.photo, [], 'the queue is drained');
  deepEqual(ctx.sheetSnapshot.fotos.map((r) => r.id), ['p3'],
    'both processed ids must leave the baseline, not only the ones the server echoed back');
});

test('F1 trigger: the normal case (server confirms) is unchanged', async () => {
  const { ctx } = buildFileDeletes({ queued: ['p1'], snapshot: ['p1', 'p2'], serverReports: ['p1'] });
  await settlesWithin(ctx.flushFileDeletes_(), 2000, 'flushFileDeletes_ hung');
  deepEqual(ctx.sheetSnapshot.fotos.map((r) => r.id), ['p2']);
});

test('F1 trigger: a queue larger than one chunk is fully drained', async () => {
  const ids = [];
  for (let i = 0; i < 30; i++) ids.push('p' + i);
  const { ctx, posts } = buildFileDeletes({ queued: ids, snapshot: ids, serverReports: [] });
  await settlesWithin(ctx.flushFileDeletes_(), 2000, 'flushFileDeletes_ hung on a multi-chunk queue');
  equal(posts.length, 3, '30 ids at DELETE_CHUNK_SIZE=12 is three requests');
  deepEqual(ctx.pendingFileDeletes.photo, []);
  deepEqual(ctx.sheetSnapshot.fotos, [], 'nothing stale left in the baseline');
  notOk(posts.some((p) => p.ids.length > ctx.DELETE_CHUNK_SIZE), 'no request exceeds the chunk size');
});
