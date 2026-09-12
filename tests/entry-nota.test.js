// One authoritative note per lançamento, stored on the entry's own row — and
// the Notas feed as a DERIVED view of it.
//
// The single thing worth protecting here is that the derived view stays a
// view. If an entry note ever starts producing a Notas row again, the same
// text exists twice: it shows twice on the Notas page, the two copies drift
// the moment either is edited, and the spreadsheet the father audits stops
// being the one source of truth for a lançamento's note.
//
// Runs the REAL functions extracted from the real index.html — never a copy,
// which would stop being the shipped code the moment someone edited it.
'use strict';

const { test, equal, ok, notOk, deepEqual } = require('./helpers/harness');
const { buildContext, appSourceText } = require('./helpers/app-source');

// caixaObra/empreiteiro/notes as the app holds them in memory.
function ctxWith(state) {
  return buildContext({
    functions: ['computeNotasRows', 'toSheetRows', 'entryFromRow_'],
    vars: {
      caixaObra: state.caixaObra || [],
      empreiteiro: state.empreiteiro || [],
      notes: state.notes || [],
      tasks: [], documentos: [], projectFotos: [], projects: state.projects || [],
      tipos: [], unidades: [], socios: [],
    },
    stubs: {
      pendingUploads: new Map(),
      NO_DRIVE_FILE_YET: new Set(),
      resolvedProjectSocios_: () => [],
    },
  });
}

const entry = (o) => Object.assign({
  id: 'e1', projectId: 'Obra A', nome: 'cimento', valor: 10, data: '2026-01-01',
  qtd: '', unidade: '', fornecedor: '', socio: '', tipo: '', nota: '',
  fotos: [], criadoEm: 1000, lastModified: 1000,
}, o);

// ---------------------------------------------------------------------------
// The invariant: one copy, never two
// ---------------------------------------------------------------------------
test('an entry with a nota produces NO Notas row — there is only one copy', () => {
  // The fixture deliberately ALSO carries a legacy `notas` array, which is
  // what a state rebuilt from a pre-migration cache would hold. Two things
  // have to be true: the `nota` field emits no Notas row, and a leftover
  // nested note array is ignored rather than resurrected as one. Without the
  // second half this test passes vacuously on any state that simply has no
  // nested notes, which proves nothing about the change.
  const ctx = ctxWith({
    caixaObra: [entry({
      nota: 'pago em dinheiro',
      notas: [{ id: 'legacy1', texto: 'do cache antigo', criadoEm: 1, lastModified: 1 }],
    })],
  });
  deepEqual(ctx.computeNotasRows(), [],
    'an entry note must never be written to the Notas sheet as well as its own row');
});

test('the nota travels on the entry row instead', () => {
  const ctx = ctxWith({ caixaObra: [entry({ nota: 'pago em dinheiro' })] });
  const rows = ctx.toSheetRows('caixaObra', ctx.caixaObra);
  equal(rows.length, 1);
  equal(rows[0].nota, 'pago em dinheiro');
});

test('the nota key is ALWAYS sent, even when empty', () => {
  // This is what lets the backend tell a deliberate clear from an old client
  // that has no concept of the column. If the key were omitted when blank,
  // clearing a note would silently become "leave it alone" and the note could
  // never be removed from the app at all.
  const ctx = ctxWith({ caixaObra: [entry({ nota: '' })] });
  const row = ctx.toSheetRows('caixaObra', ctx.caixaObra)[0];
  ok(Object.prototype.hasOwnProperty.call(row, 'nota'), 'the key must be present');
  equal(row.nota, '');
});

test('Empreiteiro carries nota too, and still has no tipo', () => {
  const ctx = ctxWith({ empreiteiro: [entry({ id: 'm1', nota: 'medição 3' })] });
  const row = ctx.toSheetRows('empreiteiro', ctx.empreiteiro)[0];
  equal(row.nota, 'medição 3');
  notOk(Object.prototype.hasOwnProperty.call(row, 'tipo'), 'empreiteiro has no tipo field');
});

test('standalone notes are still real Notas rows', () => {
  const ctx = ctxWith({
    notes: [{ id: 'n1', projectId: 'Obra A', texto: 'nota geral', criadoEm: 5, lastModified: 5, fotos: [] }],
  });
  const rows = ctx.computeNotasRows();
  equal(rows.length, 1);
  equal(rows[0].texto, 'nota geral');
  equal(rows[0].projeto, 'Obra A');
  equal(rows[0].refTipo, '', 'standalone means no parent reference');
});

test('a mixed state emits exactly the standalone notes and nothing else', () => {
  const ctx = ctxWith({
    caixaObra: [entry({ id: 'e1', nota: 'na entrada' }), entry({ id: 'e2', nota: '' })],
    empreiteiro: [entry({ id: 'm1', nota: 'na medição' })],
    notes: [{ id: 'n1', projectId: 'Obra A', texto: 'geral', criadoEm: 5, lastModified: 5, fotos: [] }],
  });
  deepEqual(ctx.computeNotasRows().map((r) => r.id), ['n1']);
});

// ---------------------------------------------------------------------------
// Hydration: an entry rebuilt from a sheet row keeps its note and grows no
// nested note array.
// ---------------------------------------------------------------------------
test('entryFromRow_ carries nota and creates no nested notas array', () => {
  const ctx = ctxWith({});
  const rebuilt = ctx.entryFromRow_({
    id: 'e1', projeto: 'Obra A', nome: 'cimento', valor: 10, data: '2026-01-01',
    nota: 'do servidor', criadoEm: 1, lastModified: 2,
  }, null);
  equal(rebuilt.nota, 'do servidor');
  notOk(rebuilt.notas, 'no nested note records — the field is the note');
  deepEqual(rebuilt.fotos, [], 'photos are still nested, and still there');
});

test('entryFromRow_ preserves an existing record\'s photos while replacing its fields', () => {
  // The load-bearing half: this runs when a background getAll lands, and the
  // in-flight photos hanging off the record must survive it.
  const ctx = ctxWith({});
  const existing = { id: 'e1', fotos: [{ id: 'p1' }], nota: 'antiga' };
  const rebuilt = ctx.entryFromRow_({ id: 'e1', projeto: 'Obra A', nome: 'x', nota: 'nova', criadoEm: 1, lastModified: 2 }, existing);
  deepEqual(rebuilt.fotos.map((f) => f.id), ['p1']);
  equal(rebuilt.nota, 'nova', 'the server\'s value wins for the field itself');
});

test('a missing nota on a server row reads as empty, never undefined', () => {
  // An old backend (or the transitional mode before the migration) sends no
  // nota at all. `undefined` would be written straight back out as the string
  // "undefined" by some render paths, and would defeat the blank check that
  // keeps empty cards out of the feed.
  const ctx = ctxWith({});
  const rebuilt = ctx.entryFromRow_({ id: 'e1', projeto: 'Obra A', nome: 'x', criadoEm: 1, lastModified: 1 }, null);
  equal(rebuilt.nota, '');
});

// ---------------------------------------------------------------------------
// Source-level invariants. These are about the shape of the code rather than
// one function's behaviour — cheaper and more durable than reconstructing the
// whole Notas page in a vm, and they catch exactly the regressions that
// matter.
// ---------------------------------------------------------------------------
test('the Notas feed derives entry notes from e.nota, not from a note array', () => {
  const src = appSourceText();
  ok(/pushEntryNote_/.test(src), 'the derived-note helper must exist');
  ok(/projEntries\(caixaObra\)\.forEach\(e => pushEntryNote_\(e, 'caixa'/.test(src),
    'the feed must build entry notes from the entries themselves');
  notOk(/\(e\.notas\s*\|\|\s*\[\]\)\.forEach\(n => push_/.test(src),
    'the old nested-note union loop must be gone');
});

test('a derived feed item is marked so its action menu can route Editar', () => {
  const src = appSourceText();
  ok(/ref:\{origin:'entry', kind, entryId:e\.id\}/.test(src),
    "a derived item must carry ref.origin === 'entry'");
  ok(/ctx\.ref\.origin === 'entry'\)\{\s*\n\s*startEditEntry\(/.test(src),
    'Editar on a derived card must open the lançamento\'s own Editar form');
});

test('the per-entry note thread is gone, not merely hidden', () => {
  const src = appSourceText();
  ['function notesThreadHTML', 'function renderModalNotes', 'function renderEditNotes',
    'function attachNotesThreadHandlers', 'function refreshNoteViewsFor'].forEach((decl) => {
    notOk(src.indexOf(decl) > -1, decl + ' should no longer exist');
  });
  notOk(/id="modalAddNoteBtn"/.test(src), 'the modal note composer is gone');
  notOk(/id="editNotesList"/.test(src), 'the edit-form note thread is gone');
});

test('the Editar form pre-fills the note rather than appending to a thread', () => {
  const src = appSourceText();
  ok(/\$\('#f_nota'\)\.value = e\.nota \|\| '';/.test(src),
    'editing must load the current note into the field');
  notOk(/notas: \[\{id: uid\('n'\)/.test(src),
    'saving must not mint a note record any more');
});

test('editNoteRef and deleteNoteRef handle standalone notes only', () => {
  const src = appSourceText();
  ok(/async function editNoteRef\(ref\)\{\s*\n\s*if\(ref\.origin !== 'standalone'\) return;/.test(src));
  ok(/async function deleteNoteRef\(ref\)\{\s*\n\s*if\(ref\.origin !== 'standalone'\) return;/.test(src));
});
