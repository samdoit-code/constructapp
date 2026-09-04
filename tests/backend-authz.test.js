// F1 (backend half) + the two-axis authorization model.
//
// Drives the REAL, unmodified backend/Code.js through real doPost() calls in a
// mocked Apps Script environment — the technique CLAUDE.md Section 8 prescribes
// for anything touching permissions, kept in the repo this time instead of
// being rebuilt as a throwaway.
'use strict';

const { test, equal, ok, notOk, deepEqual } = require('./helpers/harness');
const { createSandbox, sheetsFrom, papeisFor, ALL_SECTIONS } = require('./helpers/apps-script');

const ADMIN = 'admin@example.com';
const SCOPED = 'scoped@example.com';
const VIEWER = 'viewer@example.com';
const TOKENS = {
  'tok-admin': { email: ADMIN, name: 'Admin' },
  'tok-scoped': { email: SCOPED, name: 'Scoped' },
  'tok-viewer': { email: VIEWER, name: 'Viewer' },
};

// Verbatim from installPapeisSheet()'s seed in backend/Code.js — the read-only
// role as it is actually configured in production.
const PARTNER_SEED = [
  ['partner', 'painel', 'SIM', 'NAO', 'NAO', 'NAO', 'NAO', 'NAO'],
  ['partner', 'painel.tarefas', 'NAO', 'NAO', 'NAO', 'NAO', 'NAO', 'NAO'],
  ['partner', 'lancamentos', 'SIM', 'NAO', 'NAO', 'NAO', 'NAO', 'NAO'],
  ['partner', 'tarefas', 'NAO', 'NAO', 'NAO', 'NAO', 'NAO', 'NAO'],
  ['partner', 'notas', 'NAO', 'NAO', 'NAO', 'NAO', 'NAO', 'NAO'],
  ['partner', 'docs', 'SIM', 'NAO', 'NAO', 'NAO', 'NAO', 'NAO'],
  ['partner', 'config', 'NAO', 'NAO', 'NAO', 'NAO', 'NAO', 'NAO'],
  ['partner', 'usuarios', 'NAO', 'NAO', 'NAO', 'NAO', 'NAO', 'NAO'],
];

// One project the scoped user can see (Obra A) and one they cannot (Obra B),
// with a photo, a note and a document hanging off each.
function fixture() {
  return createSandbox({
    tokens: TOKENS,
    usuarios: [
      [ADMIN, 'Admin', 'admin', '*', 'SIM', 1],
      [SCOPED, 'Scoped', 'admin', 'Obra A', 'SIM', 1],
      [VIEWER, 'Viewer', 'partner', '*', 'SIM', 1],
    ],
    // 'partner' is copied verbatim from installPapeisSheet()'s seed, so this
    // exercises the role the app actually ships rather than an invented one.
    papeis: papeisFor('admin', ALL_SECTIONS).concat(PARTNER_SEED),
    sheets: sheetsFrom({
      Projetos: [['Obra A', 'SIM', '', 'Dalmir'], ['Obra B', 'SIM', '', 'Dalmir']],
      CaixaObra: [
        ['e1', 'Obra A', '2026-01-01', 'cimento', 'mat', '', 'und', 10, 'forn', 'Dalmir', 1, 1],
        ['e2', 'Obra B', '2026-01-02', 'areia', 'mat', '', 'und', 20, 'forn', 'Dalmir', 1, 1],
      ],
      Tarefas: [['t1', 'Obra A', 'fazer', '', 'media', 'NAO', 1, 1]],
      Notas: [
        ['n1', 'Obra A', 'nota A', 1, '', '', 1],
        ['n2', 'Obra B', 'nota B', 1, '', '', 1],
      ],
      Fotos: [
        ['p1', 'caixa', 'e1', 'drive1', 'u1', 1, 1],
        ['p2', 'caixa', 'e2', 'drive2', 'u2', 1, 1],
      ],
      Documentos: [['d1', 'Obra A', 'doc', 'application/pdf', 'drive3', 'u3', 1, 1]],
      Tipos: [['mat']],
      Unidades: [['und']],
      Socios: [['Dalmir']],
    }),
  });
}

const del = (sheet, ids) => ({ sheet, upserts: [], deletes: ids });
const taskUpsert = (id, feito, expectedLastModified) => ({
  sheet: 'tarefas',
  upserts: [{ id, row: { id, projeto: 'Obra A', texto: 'fazer', prazo: '', prioridade: 'media', feito, criadoEm: 1 }, expectedLastModified }],
  deletes: [],
});

// --- F1: deleting a row the server no longer has ---------------------------

test('F1: deleting an already-absent Fotos row is a no-op, not a refusal', () => {
  const s = fixture();
  const r = s.post({ idToken: 'tok-admin', action: 'batchMulti', ops: [del('fotos', ['gone-photo'])] });
  ok(r.ok, 'expected ok, got: ' + JSON.stringify(r));
  notOk(r.error);
});

test('F1: deleting an already-absent Notas row is a no-op, not a refusal', () => {
  const s = fixture();
  const r = s.post({ idToken: 'tok-admin', action: 'batchMulti', ops: [del('notas', ['gone-note'])] });
  ok(r.ok, 'expected ok, got: ' + JSON.stringify(r));
});

test('F1: a mixed batch is not destroyed by one already-absent delete', () => {
  // This is what made the bug expensive: batches are all-or-nothing, so a stale
  // photo delete took every unrelated row in the same request down with it.
  const s = fixture();
  const r = s.post({
    idToken: 'tok-admin',
    action: 'batchMulti',
    ops: [taskUpsert('t1', true, 1), del('fotos', ['gone-photo'])],
  });
  ok(r.ok, 'expected ok, got: ' + JSON.stringify(r));
  equal(s.rows('Tarefas')[0].feito, 'SIM', 'the valid edit in the batch must actually land');
});

test('F1: an already-absent delete is still a no-op for a project-scoped user', () => {
  const s = fixture();
  const r = s.post({ idToken: 'tok-scoped', action: 'batchMulti', ops: [del('fotos', ['gone-photo']), del('notas', ['gone-note'])] });
  ok(r.ok, 'expected ok, got: ' + JSON.stringify(r));
});

test('F1: repeating a delete (a lost response, retried) succeeds both times', () => {
  const s = fixture();
  const first = s.post({ idToken: 'tok-admin', action: 'batchMulti', ops: [del('fotos', ['p1'])] });
  ok(first.ok);
  equal(s.rows('Fotos').length, 1, 'the row is gone after the first delete');
  const retry = s.post({ idToken: 'tok-admin', action: 'batchMulti', ops: [del('fotos', ['p1'])] });
  ok(retry.ok, 'the retry must be idempotent, not a refusal: ' + JSON.stringify(retry));
});

// --- F1: the skip must NOT weaken authorization ----------------------------

test('F1: a delete of a row that EXISTS is still fully authorized', () => {
  const s = fixture();
  const r = s.post({ idToken: 'tok-viewer', action: 'batchMulti', ops: [del('fotos', ['p1'])] });
  equal(r.error, 'sem permissão para excluir', 'a view-only role must still be refused');
  equal(s.rows('Fotos').length, 2, 'and nothing may be deleted');
});

test('F1: a scoped user still cannot delete a row outside their projects', () => {
  const s = fixture();
  // p2 hangs off e2, which belongs to Obra B.
  const r = s.post({ idToken: 'tok-scoped', action: 'batchMulti', ops: [del('fotos', ['p2'])] });
  equal(r.error, 'sem acesso a este projeto');
  equal(s.rows('Fotos').length, 2);
});

test('F1: a row that exists but resolves to no known parent still fails closed', () => {
  // The other reason sectionForOp_ can come back empty, and the one that must
  // keep throwing: an orphan whose refTipo means nothing.
  const s = fixture();
  s.sheets.Fotos._data.push(['pX', 'nonsense', 'e1', 'd', 'u', 1, 1]);
  const r = s.post({ idToken: 'tok-admin', action: 'batchMulti', ops: [del('fotos', ['pX'])] });
  equal(r.error, 'sem acesso a esta seção', 'an unresolvable EXISTING row must not be silently deleted');
  equal(s.rows('Fotos').length, 3);
});

// --- F1: the latent project-scope bugs in the same function ----------------

test('F1: a scoped user CAN delete a photo inside their own project', () => {
  // projectOfRow returned undefined for every fotos delete, so this was
  // impossible before — fail-closed, but a dead end for any scoped role.
  const s = fixture();
  const r = s.post({ idToken: 'tok-scoped', action: 'batchMulti', ops: [del('fotos', ['p1'])] });
  ok(r.ok, 'expected ok, got: ' + JSON.stringify(r));
  deepEqual(s.rows('Fotos').map((f) => f.id), ['p2']);
});

test('F1: a scoped user CAN delete a document inside their own project', () => {
  // projectOfRow looked documentos up in entryIdx, which never holds them.
  const s = fixture();
  const r = s.post({ idToken: 'tok-scoped', action: 'batchMulti', ops: [del('documentos', ['d1'])] });
  ok(r.ok, 'expected ok, got: ' + JSON.stringify(r));
  equal(s.rows('Documentos').length, 0);
});

test('F1: a scoped user cannot delete a document outside their projects', () => {
  const s = fixture();
  s.sheets.Documentos._data.push(['d2', 'Obra B', 'doc B', 'application/pdf', 'drive9', 'u9', 1, 1]);
  const r = s.post({ idToken: 'tok-scoped', action: 'batchMulti', ops: [del('documentos', ['d2'])] });
  equal(r.error, 'sem acesso a este projeto');
  equal(s.rows('Documentos').length, 2);
});

test('F1: a scoped user can delete their own entry, but not another project\'s', () => {
  const s = fixture();
  ok(s.post({ idToken: 'tok-scoped', action: 'batchMulti', ops: [del('caixaObra', ['e1'])] }).ok);
  equal(s.post({ idToken: 'tok-scoped', action: 'batchMulti', ops: [del('caixaObra', ['e2'])] }).error, 'sem acesso a este projeto');
  deepEqual(s.rows('CaixaObra').map((r) => r.id), ['e2']);
});

// --- Standing authorization guarantees the fixes must not disturb ----------

test('authz: a forged role/sections claim in the request body is ignored', () => {
  const s = fixture();
  const r = s.post({
    idToken: 'tok-viewer', action: 'batchMulti',
    role: 'admin', sections: { lancamentos: { delete: true } }, projects: '*',
    ops: [del('caixaObra', ['e1'])],
  });
  equal(r.error, 'sem permissão para excluir');
  equal(s.rows('CaixaObra').length, 2);
});

test('authz: getAll withholds another project\'s rows from a scoped user', () => {
  const s = fixture();
  const r = s.post({ idToken: 'tok-scoped', action: 'getAll' });
  deepEqual(r.caixaObra.map((e) => e.id), ['e1']);
  deepEqual(r.notas.map((n) => n.id), ['n1']);
  deepEqual(r.fotos.map((f) => f.id), ['p1'], 'a photo is filtered by the project of its PARENT entry');
  deepEqual(r.projetos.map((p) => p.id), ['Obra A']);
});

test('authz: a view-only role gets data but cannot write', () => {
  const s = fixture();
  const r = s.post({ idToken: 'tok-viewer', action: 'getAll' });
  equal(r.caixaObra.length, 2, 'partner has lancamentos.view');
  equal(r.tarefas.length, 0, 'but not tarefas.view');
  const w = s.post({ idToken: 'tok-viewer', action: 'batchMulti', ops: [taskUpsert('t1', true, 1)] });
  ok(String(w.error).indexOf('sem permissão') === 0, 'got: ' + JSON.stringify(w));
});

test('authz: a cross-cutting photo is gated by its PARENT\'s section, not the page it shows on', () => {
  // The non-obvious rule the whole per-row Notas/Fotos design exists for: a
  // task's photo is rendered in the Docs gallery, and 'partner' HAS docs.view —
  // but not tarefas.view, so the row must still be withheld. A blanket
  // "Fotos belongs to docs" flag would leak it.
  const s = fixture();
  s.sheets.Fotos._data.push(['pt', 'tasks', 't1', 'drive4', 'u4', 1, 1]);
  const r = s.post({ idToken: 'tok-viewer', action: 'getAll' });
  notOk(r.fotos.some((f) => f.id === 'pt'), 'a task photo must not reach a role denied tarefas.view');
  ok(r.fotos.some((f) => f.id === 'p1'), 'while a lançamento photo still does, since lancamentos.view is granted');
});

test('authz: a standalone note is gated by notas, not by the page it appears on', () => {
  const s = fixture();
  const r = s.post({ idToken: 'tok-viewer', action: 'getAll' });
  equal(r.notas.length, 0, 'partner has no notas.view, so no standalone notes');
});

test('authz: an unknown or deactivated user is rejected before any data', () => {
  const s = createSandbox({
    tokens: { 'tok-ghost': { email: 'ghost@example.com' }, 'tok-off': { email: 'off@example.com' } },
    usuarios: [['off@example.com', 'Off', 'admin', '*', 'NAO', 1]],
    papeis: papeisFor('admin', ALL_SECTIONS),
    sheets: sheetsFrom({ Projetos: [['Obra A', 'SIM', '', '']] }),
  });
  equal(s.post({ idToken: 'tok-ghost', action: 'getAll' }).error, 'usuário não cadastrado');
  equal(s.post({ idToken: 'tok-off', action: 'getAll' }).error, 'usuário desativado');
  equal(s.post({ idToken: 'nope', action: 'getAll' }).error, 'não autenticado');
});

test('authz: a missing Papeis row denies by default', () => {
  const s = createSandbox({
    tokens: TOKENS,
    usuarios: [[ADMIN, 'Admin', 'norole', '*', 'SIM', 1]],
    papeis: papeisFor('admin', ALL_SECTIONS),   // nothing for 'norole'
    sheets: sheetsFrom({ Projetos: [['Obra A', 'SIM', '', '']], CaixaObra: [['e1', 'Obra A', '2026-01-01', 'x', 'mat', '', 'und', 1, '', '', 1, 1]] }),
  });
  const r = s.post({ idToken: 'tok-admin', action: 'getAll' });
  equal(r.caixaObra.length, 0, 'an unrecognized role sees nothing');
});

test('conflict: a stale lastModified is reported, not applied', () => {
  const s = fixture();
  const r = s.post({ idToken: 'tok-admin', action: 'batchMulti', ops: [taskUpsert('t1', true, 999)] });
  ok(r.conflict);
  equal(r.conflicts[0].currentLastModified, 1, 'the client needs the current value to rebase');
  equal(s.rows('Tarefas')[0].feito, 'NAO', 'nothing written');
});

test('conflict: a vanished row is reported as deleted, never re-created', () => {
  const s = fixture();
  s.post({ idToken: 'tok-admin', action: 'batchMulti', ops: [del('tarefas', ['t1'])] });
  const r = s.post({ idToken: 'tok-admin', action: 'batchMulti', ops: [taskUpsert('t1', true, 1)] });
  ok(r.conflict);
  equal(r.conflicts[0].deleted, true);
  equal(s.rows('Tarefas').length, 0, 'the row must not be resurrected');
});

test('idempotency: re-sending an applied upsert does not duplicate the row', () => {
  // The property the derived-diff outbox depends on: the server applied the
  // write but the response was lost, so the client re-sends the same batch.
  const s = fixture();
  const first = s.post({ idToken: 'tok-admin', action: 'batchMulti', ops: [taskUpsert('t1', true, 1)] });
  ok(first.ok);
  const lm = first.updated.tarefas[0].lastModified;
  const again = s.post({ idToken: 'tok-admin', action: 'batchMulti', ops: [taskUpsert('t1', true, lm)] });
  ok(again.ok);
  equal(s.rows('Tarefas').length, 1, 'upsert by client-minted id, never an append');
});
