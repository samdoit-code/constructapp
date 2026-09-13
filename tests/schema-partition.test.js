// Per-project entry tabs, the accountant column order, and the `nota` column.
//
// Drives the REAL, unmodified backend/Code.js through real doPost() calls in a
// mocked Apps Script environment. Everything here protects something that
// would fail SILENTLY: a row written to the wrong project's tab, a tab id
// blanked by an unrelated save, a note wiped by an old client, or a scoped
// role reaching a project it cannot see.
'use strict';

const { test, equal, ok, notOk, deepEqual } = require('./helpers/harness');
const {
  createSandbox, sheetsFrom, partitionedSheets, papeisFor, SCHEMA, ALL_SECTIONS,
} = require('./helpers/apps-script');

const ADMIN = 'admin@example.com';
const SCOPED = 'scoped@example.com';
const TOKENS = {
  'tok-admin': { email: ADMIN, name: 'Admin' },
  'tok-scoped': { email: SCOPED, name: 'Scoped' },
};

const USUARIOS = [
  [ADMIN, 'Admin', 'admin', '*', 'SIM', 1],
  [SCOPED, 'Scoped', 'admin', 'Obra A', 'SIM', 1],
];
const PAPEIS = () => papeisFor('admin', ALL_SECTIONS);

// A CaixaObra row in the NEW column order. Written as a named object and
// projected through SCHEMA rather than as a bare positional array, so this
// fixture cannot silently drift out of step with the column order it claims
// to be testing.
function caixaRow(o) {
  return SCHEMA.CaixaObra.map((c) => (o[c] === undefined ? '' : o[c]));
}
function empRow(o) {
  return SCHEMA.Empreiteiro.map((c) => (o[c] === undefined ? '' : o[c]));
}

// Two projects, each with its own pair of tabs, ids stored in Projetos.
function twoProjects(extra) {
  return createSandbox(Object.assign({
    tokens: TOKENS,
    usuarios: USUARIOS,
    papeis: PAPEIS(),
    sheets: partitionedSheets({
      entries: {
        'Obra A': {
          caixa: [caixaRow({ id: 'a1', projeto: 'Obra A', nome: 'cimento', valor: 10, data: '2026-01-01', criadoEm: 1, lastModified: 1 })],
          emp: [],
        },
        'Obra B': {
          caixa: [caixaRow({ id: 'b1', projeto: 'Obra B', nome: 'areia', valor: 20, data: '2026-01-02', criadoEm: 1, lastModified: 1 })],
          emp: [],
        },
      },
      Tipos: [['mat']],
      Unidades: [['und']],
      Socios: [['Dalmir']],
    }),
  }, extra || {}));
}

const upsert = (sheet, rows) => ({
  sheet,
  upserts: rows.map((r) => ({ id: r.id, row: r, expectedLastModified: r.expectedLastModified || null })),
  deletes: [],
});

// ---------------------------------------------------------------------------
// The mirror. This file and backend/Code.js are the only two places a column
// order is written down; if they disagree, every other test here is asserting
// on a shape that does not ship.
// ---------------------------------------------------------------------------
test('the helper SCHEMA mirrors backend SHEETS[key].cols exactly', () => {
  const sb = twoProjects();
  const SHEETS = sb.eval('SHEETS');
  const byTabName = {
    Projetos: 'projetos', Tarefas: 'tarefas', Notas: 'notas', Fotos: 'fotos',
    Documentos: 'documentos', Tipos: 'tipos', Unidades: 'unidades', Socios: 'socios',
    CaixaObra: 'caixaObra', Empreiteiro: 'empreiteiro',
  };
  Object.keys(byTabName).forEach((tab) => {
    deepEqual(SCHEMA[tab], SHEETS[byTabName[tab]].cols,
      `tests/helpers/apps-script.js SCHEMA.${tab} has drifted from SHEETS.${byTabName[tab]}.cols in backend/Code.js`);
  });
});

test('the requested A:M order really is what the schema produces', () => {
  const sb = twoProjects();
  const cols = sb.eval('SHEETS').caixaObra.cols;
  // nome A, qtd B, unidade C, data D, valor E, fornecedor F, nota G,
  // socio H, tipo I, projeto J, id K, criadoEm L, lastModified M
  deepEqual(cols.slice(0, 11), [
    'nome', 'qtd', 'unidade', 'data', 'valor', 'fornecedor', 'nota', 'socio', 'tipo', 'projeto', 'id',
  ]);
  equal(cols.indexOf('id') + 1, 11, 'id must land in column K on CaixaObra');
  // Empreiteiro has no tipo, so id is one column earlier — the general order
  // is what matters, not the exact letter.
  const empCols = sb.eval('SHEETS').empreiteiro.cols;
  equal(empCols.indexOf('id') + 1, 10, 'id must land in column J on Empreiteiro');
  notOk(empCols.indexOf('tipo') > -1, 'no invented tipo column on Empreiteiro');
});

test('no code path hardcodes a column position: moving id still works end to end', () => {
  // The whole point of colOf_. If anything still assumed column A, a read of
  // a tab whose id is in K would come back with blank ids.
  const sb = twoProjects();
  const res = sb.post({ idToken: 'tok-admin', action: 'getAll' });
  const ids = res.caixaObra.map((r) => r.id).sort();
  deepEqual(ids, ['a1', 'b1']);
  ok(res.caixaObra.every((r) => r.nome), 'every row kept its nome — columns are not shifted');
});

// ---------------------------------------------------------------------------
// Routing
// ---------------------------------------------------------------------------
test('an upsert lands in its own project tab and in no other', () => {
  const sb = twoProjects();
  const res = sb.post({
    idToken: 'tok-admin', action: 'batchMulti',
    ops: [upsert('caixaObra', [{ id: 'a2', projeto: 'Obra A', nome: 'brita', valor: 30, data: '2026-02-01', criadoEm: 2 }])],
  });
  ok(res.ok, JSON.stringify(res));
  const a = sb.rows('Obra A - CaixaObra').map((r) => r.id).sort();
  const b = sb.rows('Obra B - CaixaObra').map((r) => r.id).sort();
  deepEqual(a, ['a1', 'a2'], 'the new row is in Obra A');
  deepEqual(b, ['b1'], 'Obra B is untouched');
});

test('Empreiteiro routes correctly too — its id column is in a DIFFERENT place', () => {
  // The likeliest place a surviving hardcoded index would hide: Empreiteiro
  // has one fewer column than CaixaObra (no tipo), so its id is in J, not K.
  // Anything reading a fixed column would read the wrong field for exactly one
  // of the two sheets — which is the kind of bug that looks like it works.
  const sb = twoProjects();
  const res = sb.post({
    idToken: 'tok-admin', action: 'batchMulti',
    ops: [upsert('empreiteiro', [{ id: 'm1', projeto: 'Obra B', nome: 'medicao 1', valor: 900, data: '2026-05-01', criadoEm: 9, nota: 'primeira medição' }])],
  });
  ok(res.ok, JSON.stringify(res));
  const row = sb.rows('Obra B - Empreiteiro').find((r) => r.id === 'm1');
  ok(row, 'landed in Obra B\'s Empreiteiro tab');
  equal(row.nome, 'medicao 1', 'nome read back from the right column');
  equal(Number(row.valor), 900, 'valor read back from the right column');
  equal(row.nota, 'primeira medição');
  deepEqual(sb.rows('Obra A - Empreiteiro').map((r) => r.id), [], 'and nowhere else');

  // And it survives a round trip through getAll, where the two sheets are
  // concatenated into one array by two different column layouts.
  const all = sb.post({ idToken: 'tok-admin', action: 'getAll' });
  const back = all.empreiteiro.find((r) => r.id === 'm1');
  ok(back, 'readable through getAll');
  equal(back.nome, 'medicao 1');
  equal(back.nota, 'primeira medição');
  ok(all.caixaObra.every((r) => r.nome), 'and CaixaObra is still read correctly alongside it');
});

test('a new project gets its tabs, and its first entry goes there', () => {
  const sb = twoProjects();
  // Adding a project is a whole-tab Projetos save — the ENTIRE array.
  const saved = sb.post({
    idToken: 'tok-admin', action: 'saveSheet', sheet: 'projetos',
    rows: [
      { id: 'Obra A', ativo: true, socios: 'Dalmir' },
      { id: 'Obra B', ativo: true, socios: 'Dalmir' },
      { id: 'Obra C', ativo: true, socios: 'Dalmir' },
    ],
  });
  ok(saved.ok, JSON.stringify(saved));
  ok(sb.sheet('Obra C - CaixaObra'), 'the new project is immediately auditable — its tab exists');
  ok(sb.sheet('Obra C - Empreiteiro'), 'both tabs, not just one');

  const res = sb.post({
    idToken: 'tok-admin', action: 'batchMulti',
    ops: [upsert('caixaObra', [{ id: 'c1', projeto: 'Obra C', nome: 'ferro', valor: 5, data: '2026-03-01', criadoEm: 3 }])],
  });
  ok(res.ok, JSON.stringify(res));
  deepEqual(sb.rows('Obra C - CaixaObra').map((r) => r.id), ['c1']);
});

test('THE TRAP: a whole-tab Projetos save does not blank the stored tab ids', () => {
  // Identical in shape to the driveFolderId bug this column pattern inherits:
  // the client's projects array has no concept of caixaSheetId, and adding one
  // project sends the entire array. Without the re-merge in
  // preserveProjectFolderIds_, every other project's tab id is wiped — after
  // which a hand-renamed tab is orphaned and a fresh one gets created
  // alongside it.
  const sb = twoProjects();
  // Assert the columns genuinely EXIST in the shipped schema first. Without
  // this the rest of the test passes vacuously on a schema that has no such
  // columns — String(undefined) is truthy, and "undefined" compares equal to
  // "undefined" — which is exactly the false pass a negative control is for.
  const projetosCols = sb.eval('SHEETS').projetos.cols;
  ok(projetosCols.indexOf('caixaSheetId') > -1, 'caixaSheetId must be a real Projetos column');
  ok(projetosCols.indexOf('empSheetId') > -1, 'empSheetId must be a real Projetos column');

  const before = sb.rows('Projetos').map((r) => [r.id, String(r.caixaSheetId), String(r.empSheetId)]);
  ok(before.every((r) => r[1] && r[2] && r[1] !== 'undefined' && r[2] !== 'undefined'),
    'fixture really did store tab ids');

  sb.post({
    idToken: 'tok-admin', action: 'saveSheet', sheet: 'projetos',
    rows: [
      { id: 'Obra A', ativo: true, socios: 'Dalmir' },
      { id: 'Obra B', ativo: true, socios: 'Dalmir' },
      { id: 'Obra C', ativo: true, socios: 'Dalmir' },
    ],
  });
  const after = {};
  sb.rows('Projetos').forEach((r) => { after[r.id] = [String(r.caixaSheetId), String(r.empSheetId)]; });
  before.forEach((r) => {
    deepEqual(after[r[0]], [r[1], r[2]], `${r[0]} lost its stored tab ids to an unrelated save`);
  });
});

test('a tab renamed by hand is still found, and its name is left alone', () => {
  const sb = twoProjects();
  const sheet = sb.sheet('Obra A - CaixaObra');
  sheet.setName('Obra A CAIXA (do pai)');

  // Still readable — resolution is by stored id, not by name.
  const res = sb.post({ idToken: 'tok-admin', action: 'getAll' });
  ok(res.caixaObra.some((r) => r.id === 'a1'), 'a hand-renamed tab is still read');

  // Still writable, into that same tab — no second tab conjured up.
  const w = sb.post({
    idToken: 'tok-admin', action: 'batchMulti',
    ops: [upsert('caixaObra', [{ id: 'a3', projeto: 'Obra A', nome: 'cal', valor: 7, data: '2026-04-01', criadoEm: 4 }])],
  });
  ok(w.ok, JSON.stringify(w));
  deepEqual(sb.rows('Obra A CAIXA (do pai)').map((r) => r.id).sort(), ['a1', 'a3']);
  notOk(sb.sheet('Obra A - CaixaObra'), 'no duplicate tab was created under the derived name');

  // And a project rename respects the human's name rather than overwriting it.
  sb.post({ idToken: 'tok-admin', action: 'renameProject', oldName: 'Obra A', newName: 'Obra Alpha' });
  ok(sb.sheet('Obra A CAIXA (do pai)'), 'a hand-renamed tab keeps the name a person chose');
});

test('a STALE stored tab id throws rather than guessing by name', () => {
  // The lookupProjectFolder_ lesson, one layer over: name-guessing here could
  // attach every future write to an unrelated tab AND overwrite the canonical
  // id with the guess, permanently.
  const sb = twoProjects();
  const projetos = sb.sheet('Projetos');
  const col = SCHEMA.Projetos.indexOf('caixaSheetId') + 1;
  const rowIdx = sb.rows('Projetos').findIndex((r) => r.id === 'Obra A') + 2;
  projetos.getRange(rowIdx, col).setValue('999999'); // points at nothing

  const res = sb.post({
    idToken: 'tok-admin', action: 'batchMulti',
    ops: [upsert('caixaObra', [{ id: 'a9', projeto: 'Obra A', nome: 'x', valor: 1, data: '2026-01-01', criadoEm: 1 }])],
  });
  ok(res.error, 'a stale tab id must surface as an error');
  ok(/indispon/i.test(res.error), 'and say the tab is unavailable: ' + res.error);
  notOk(sb.rows('Obra A - CaixaObra').some((r) => r.id === 'a9'),
    'nothing was written into a name-guessed tab');
});

test('an unplaceable row refuses the WHOLE batch, leaving nothing half-applied', () => {
  // applyBatch_ resolves each row's tab from its own projeto and throws on a
  // row it cannot place. A throw part-way through its loop would leave the
  // earlier upserts written — so this is checked up front, exactly like a
  // conflict. Without assertPartitionTargets_, 'good' below lands and 'bad'
  // does not, which is precisely the half-applied batch the all-or-nothing
  // guarantee exists to prevent.
  const sb = twoProjects();
  const res = sb.post({
    idToken: 'tok-admin', action: 'batchMulti',
    ops: [upsert('caixaObra', [
      { id: 'good', projeto: 'Obra A', nome: 'ok', valor: 1, data: '2026-01-01', criadoEm: 1 },
      { id: 'bad', projeto: '', nome: 'sem projeto', valor: 1, data: '2026-01-01', criadoEm: 1 },
    ])],
  });
  ok(res.error, 'the batch must be refused: ' + JSON.stringify(res));
  notOk(sb.rows('Obra A - CaixaObra').some((r) => r.id === 'good'),
    'the valid row in the same batch must NOT have been written');
});

// ---------------------------------------------------------------------------
// Performance: backfillRowMetadata_ must be cheap on a large, already-clean
// tab. This is a real production regression, not a hypothetical one — the
// original version read the FULL WIDTH of every entry tab plus one full
// column PER FIELD, unconditionally, on every single getAll (five range
// reads per tab, inside the write lock), which on a ~1,400-row project made
// sync feel hung and pushed other requests into "Servidor ocupado" retries.
// ---------------------------------------------------------------------------
test('getAll on already-backfilled tabs costs a small, bounded number of range calls', () => {
  // The mock counts ROUND TRIPS, not bytes — it cannot show the difference a
  // full-width read of a 1,400-row tab makes on the real Sheets API. What it
  // CAN show, and what actually distinguishes the fixed code from the
  // regression, is call COUNT: the original backfill made 5 range calls per
  // tab (a full-width scan plus one read per field) regardless of whether
  // anything needed backfilling; the fast gate makes 2. Two already-clean
  // tabs make the gap wide enough to tell apart reliably (new: 3+3=6 total
  // including the data read each tab still needs; old: 6+6=12).
  const caixa = [];
  const emp = [];
  for (let i = 0; i < 1400; i++) {
    caixa.push(caixaRow({
      id: 'r' + i, projeto: 'Obra A', nome: 'item ' + i, valor: 10, data: '2026-01-01',
      criadoEm: 1700000000000 + i, lastModified: 1700000000000 + i,
    }));
  }
  for (let i = 0; i < 500; i++) {
    emp.push(empRow({
      id: 'm' + i, projeto: 'Obra A', nome: 'medicao ' + i, valor: 5, data: '2026-01-01',
      criadoEm: 1700000000000 + i, lastModified: 1700000000000 + i,
    }));
  }
  const sb = createSandbox({
    tokens: TOKENS, usuarios: USUARIOS, papeis: PAPEIS(),
    sheets: partitionedSheets({ entries: { 'Obra A': { caixa, emp } } }),
  });
  const caixaSheet = sb.sheet('Obra A - CaixaObra');
  const empSheet = sb.sheet('Obra A - Empreiteiro');
  caixaSheet._rangeCalls = 0;
  empSheet._rangeCalls = 0;

  sb.post({ idToken: 'tok-admin', action: 'getAll' });

  const total = caixaSheet._rangeCalls + empSheet._rangeCalls;
  ok(total < 10,
    `backfillRowMetadata_ + readSheet_ made ${total} range calls across two already-clean tabs ` +
    '(caixa=' + caixaSheet._rangeCalls + ', emp=' + empSheet._rangeCalls + ') — ' +
    'the original full-tab scan made 12 here and made sync feel hung at real-world row counts');
});

test('a hand-typed row is still found and stamped even on a large tab', () => {
  // The fast gate must not trade away correctness for speed: a real blank-id
  // row still gets backfilled, however large the rest of the tab is.
  const rows = [];
  for (let i = 0; i < 500; i++) {
    rows.push(caixaRow({
      id: 'r' + i, projeto: 'Obra A', nome: 'item ' + i, valor: 10, data: '2026-01-01',
      criadoEm: 1, lastModified: 1,
    }));
  }
  rows.push(caixaRow({ nome: 'tijolo', valor: 500, data: '2026-06-01' })); // hand-typed, all machine fields blank
  const sb = createSandbox({
    tokens: TOKENS, usuarios: USUARIOS, papeis: PAPEIS(),
    sheets: partitionedSheets({ entries: { 'Obra A': { caixa: rows, emp: [] } } }),
  });

  const res = sb.post({ idToken: 'tok-admin', action: 'getAll' });
  const found = res.caixaObra.find((r) => r.nome === 'tijolo');
  ok(found, 'the hand-typed row is still visible');
  ok(found.id && found.criadoEm && found.lastModified && found.projeto === 'Obra A',
    JSON.stringify(found));
});

// ---------------------------------------------------------------------------
// The nota column
// ---------------------------------------------------------------------------
test('nota round-trips on the entry row, and is cleared by an explicit empty', () => {
  const sb = twoProjects();
  sb.post({
    idToken: 'tok-admin', action: 'batchMulti',
    ops: [upsert('caixaObra', [{ id: 'a1', projeto: 'Obra A', nome: 'cimento', valor: 10, data: '2026-01-01', criadoEm: 1, nota: 'pago em dinheiro', expectedLastModified: 1 }])],
  });
  equal(sb.rows('Obra A - CaixaObra').find((r) => r.id === 'a1').nota, 'pago em dinheiro');

  const lm = sb.post({ idToken: 'tok-admin', action: 'getAll' }).caixaObra.find((r) => r.id === 'a1').lastModified;
  sb.post({
    idToken: 'tok-admin', action: 'batchMulti',
    ops: [upsert('caixaObra', [{ id: 'a1', projeto: 'Obra A', nome: 'cimento', valor: 10, data: '2026-01-01', criadoEm: 1, nota: '', expectedLastModified: lm }])],
  });
  equal(sb.rows('Obra A - CaixaObra').find((r) => r.id === 'a1').nota, '',
    'an explicit empty nota must actually clear it');
});

test('THE DEPLOY-WINDOW TRAP: a client that sends no nota key does not wipe the note', () => {
  // An old index.html still cached on someone's phone sends no nota at all.
  // rowValuesFromObj_ writes '' for a missing key, so without the
  // hasOwnProperty check this silently erases the note on every edit.
  const sb = twoProjects();
  sb.post({
    idToken: 'tok-admin', action: 'batchMulti',
    ops: [upsert('caixaObra', [{ id: 'a1', projeto: 'Obra A', nome: 'cimento', valor: 10, data: '2026-01-01', criadoEm: 1, nota: 'nao apagar', expectedLastModified: 1 }])],
  });
  const lm = sb.post({ idToken: 'tok-admin', action: 'getAll' }).caixaObra.find((r) => r.id === 'a1').lastModified;

  // No `nota` property anywhere in the row — the old client's exact payload.
  const res = sb.post({
    idToken: 'tok-admin', action: 'batchMulti',
    ops: [{
      sheet: 'caixaObra',
      upserts: [{ id: 'a1', row: { id: 'a1', projeto: 'Obra A', data: '2026-01-01', nome: 'cimento', valor: 99, qtd: '', unidade: '', fornecedor: '', socio: '', tipo: '', criadoEm: 1 }, expectedLastModified: lm }],
      deletes: [],
    }],
  });
  ok(res.ok, JSON.stringify(res));
  const row = sb.rows('Obra A - CaixaObra').find((r) => r.id === 'a1');
  equal(row.nota, 'nao apagar', 'the note survived an old client\'s edit');
  equal(Number(row.valor), 99, 'and the edit it actually made was applied');
});

// ---------------------------------------------------------------------------
// Hand-entered rows
// ---------------------------------------------------------------------------
test('a hand-typed row with no id, criadoEm or projeto comes back complete', () => {
  const sb = twoProjects();
  // Exactly what typing into the spreadsheet produces: the visible fields
  // filled, every machine field blank.
  sb.sheet('Obra A - CaixaObra').appendRow(
    caixaRow({ nome: 'tijolo', qtd: 500, unidade: 'und', data: '2026-05-01', valor: 450, fornecedor: 'Depósito' }));

  const res = sb.post({ idToken: 'tok-admin', action: 'getAll' });
  const row = res.caixaObra.find((r) => r.nome === 'tijolo');
  ok(row, 'the hand-typed row is visible to the app');
  ok(row.id, 'it was given an id');
  ok(row.criadoEm, 'and a criadoEm');
  ok(row.lastModified, 'and a lastModified');
  equal(row.projeto, 'Obra A', 'the project came from the tab it was typed into');

  // Persisted, not just filled in for one response — otherwise the id changes
  // on every read and nothing can reference the row.
  const stored = sb.rows('Obra A - CaixaObra').find((r) => r.nome === 'tijolo');
  equal(String(stored.id), String(row.id), 'the id was written back to the sheet');
  equal(stored.projeto, 'Obra A');
  const again = sb.post({ idToken: 'tok-admin', action: 'getAll' });
  equal(again.caixaObra.find((r) => r.nome === 'tijolo').id, row.id, 'and it is stable across reads');
});

test('a row cleared by hand is not resurrected as a phantom lançamento', () => {
  // Someone clears a row's contents instead of deleting the row. Minting an id
  // for it is what turns it into an empty lançamento nobody created — the
  // writeSheet_ surplus-row lesson, reached from the read side.
  const sb = twoProjects();
  sb.sheet('Obra A - CaixaObra').appendRow(SCHEMA.CaixaObra.map(() => ''));

  const res = sb.post({ idToken: 'tok-admin', action: 'getAll' });
  deepEqual(res.caixaObra.map((r) => r.id).sort(), ['a1', 'b1'], 'no phantom row appeared');
  notOk(sb.rows('Obra A - CaixaObra').some((r) => r.id && !r.nome),
    'and no id was written into the blank row');
});

test('onEdit stamps the machine fields a hand edit leaves blank', () => {
  const sb = twoProjects();
  const sheet = sb.sheet('Obra A - CaixaObra');
  sheet.appendRow(caixaRow({ nome: 'areia lavada', valor: 120, data: '2026-06-01' }));
  const rowNum = sheet.getLastRow();

  sb.ctx.onEdit({ range: sheet.getRange(rowNum, 1, 1, 1) });

  const stored = sb.rows('Obra A - CaixaObra').find((r) => r.nome === 'areia lavada');
  ok(stored.id, 'id stamped at edit time');
  ok(stored.criadoEm, 'criadoEm stamped at edit time');
  ok(stored.lastModified, 'lastModified stamped at edit time');
  equal(stored.projeto, 'Obra A', 'projeto filled from the tab');
});

test('onEdit refuses to stamp a tab whose columns were reordered by hand', () => {
  // cfg.cols is authoritative and POSITIONAL, so writing into a shifted sheet
  // would put a timestamp in whatever column now sits there. verifySchemaHeaders
  // is how a person finds out why nothing is being stamped.
  const sb = twoProjects();
  const sheet = sb.sheet('Obra A - CaixaObra');
  sheet.getRange(1, 1).setValue('NOME DO ITEM'); // header no longer matches the schema
  sheet.appendRow(caixaRow({ nome: 'pedra', valor: 1 }));
  const rowNum = sheet.getLastRow();

  sb.ctx.onEdit({ range: sheet.getRange(rowNum, 1, 1, 1) });
  const stored = sb.rows('Obra A - CaixaObra')[sb.rows('Obra A - CaixaObra').length - 1];
  notOk(stored.id, 'nothing was stamped into a sheet whose shape is unknown');

  const report = sb.ctx.verifySchemaHeaders();
  ok(report.mismatched.length > 0, 'and the audit reports the mismatch');
});

test('onEdit handles a multi-row paste, and skips a cleared row', () => {
  const sb = twoProjects();
  const sheet = sb.sheet('Obra A - CaixaObra');
  sheet.appendRow(caixaRow({ nome: 'linha 1', valor: 1 }));
  sheet.appendRow(SCHEMA.CaixaObra.map(() => ''));        // blank row inside the range
  sheet.appendRow(caixaRow({ nome: 'linha 2', valor: 2 }));
  const first = sheet.getLastRow() - 2;

  sb.ctx.onEdit({ range: sheet.getRange(first, 1, 3, SCHEMA.CaixaObra.length) });

  const rows = sb.rows('Obra A - CaixaObra');
  ok(rows.find((r) => r.nome === 'linha 1').id, 'first pasted row stamped');
  ok(rows.find((r) => r.nome === 'linha 2').id, 'last pasted row stamped');
  notOk(rows.some((r) => r.id && !r.nome), 'the blank row in the middle was left alone');
});

// ---------------------------------------------------------------------------
// Project scope. Run deliberately: the '*' admin used in most fixtures skips
// the entire project-scope pass, which is CLAUDE.md's named blind spot.
// ---------------------------------------------------------------------------
test('a project-scoped role cannot READ another project\'s tab', () => {
  const sb = twoProjects();
  const res = sb.post({ idToken: 'tok-scoped', action: 'getAll' });
  deepEqual(res.caixaObra.map((r) => r.id), ['a1'], 'only Obra A rows reach a scoped user');
});

test('a project-scoped role cannot WRITE into another project\'s tab', () => {
  const sb = twoProjects();
  const res = sb.post({
    idToken: 'tok-scoped', action: 'batchMulti',
    ops: [upsert('caixaObra', [{ id: 'b2', projeto: 'Obra B', nome: 'forjado', valor: 1, data: '2026-01-01', criadoEm: 1 }])],
  });
  ok(res.error, 'the write must be refused');
  ok(/sem acesso a este projeto/.test(res.error), res.error);
  deepEqual(sb.rows('Obra B - CaixaObra').map((r) => r.id), ['b1'], 'and Obra B is unchanged');
});

test('a project-scoped role cannot DELETE a row in another project\'s tab', () => {
  const sb = twoProjects();
  const res = sb.post({
    idToken: 'tok-scoped', action: 'batchMulti',
    ops: [{ sheet: 'caixaObra', upserts: [], deletes: ['b1'] }],
  });
  ok(res.error, 'the delete must be refused: ' + JSON.stringify(res));
  deepEqual(sb.rows('Obra B - CaixaObra').map((r) => r.id), ['b1']);
});

// ---------------------------------------------------------------------------
// Conflicts and idempotency, across partitions
// ---------------------------------------------------------------------------
test('conflict detection still works when the id lives in a non-first tab', () => {
  const sb = twoProjects();
  const res = sb.post({
    idToken: 'tok-admin', action: 'batchMulti',
    ops: [upsert('caixaObra', [{ id: 'b1', projeto: 'Obra B', nome: 'areia', valor: 21, data: '2026-01-02', criadoEm: 1, expectedLastModified: 999 }])],
  });
  ok(res.conflict, 'a stale expectedLastModified is reported: ' + JSON.stringify(res));
  equal(res.conflicts[0].id, 'b1');
  equal(Number(sb.rows('Obra B - CaixaObra').find((r) => r.id === 'b1').valor), 20, 'nothing was applied');
});

test('re-sending an applied upsert does not duplicate the row in its tab', () => {
  const sb = twoProjects();
  const op = upsert('caixaObra', [{ id: 'a5', projeto: 'Obra A', nome: 'massa', valor: 3, data: '2026-01-01', criadoEm: 1 }]);
  sb.post({ idToken: 'tok-admin', action: 'batchMulti', ops: [op] });
  sb.post({ idToken: 'tok-admin', action: 'batchMulti', ops: [op] });
  equal(sb.rows('Obra A - CaixaObra').filter((r) => r.id === 'a5').length, 1);
});

test('changing an entry\'s project MOVES it — it never exists in two tabs', () => {
  const sb = twoProjects();
  const lm = sb.post({ idToken: 'tok-admin', action: 'getAll' }).caixaObra.find((r) => r.id === 'a1').lastModified;
  const res = sb.post({
    idToken: 'tok-admin', action: 'batchMulti',
    ops: [upsert('caixaObra', [{ id: 'a1', projeto: 'Obra B', nome: 'cimento', valor: 10, data: '2026-01-01', criadoEm: 1, expectedLastModified: lm }])],
  });
  ok(res.ok, JSON.stringify(res));
  notOk(sb.rows('Obra A - CaixaObra').some((r) => r.id === 'a1'), 'gone from the old tab');
  ok(sb.rows('Obra B - CaixaObra').some((r) => r.id === 'a1'), 'present in the new tab');
});

// ---------------------------------------------------------------------------
// Project deletion
// ---------------------------------------------------------------------------
test('deleteProject removes only that project\'s tabs', () => {
  const sb = twoProjects();
  const res = sb.post({ idToken: 'tok-admin', action: 'deleteProject', name: 'Obra A' });
  ok(res.ok, JSON.stringify(res));
  notOk(sb.sheet('Obra A - CaixaObra'), 'the deleted project\'s tab is gone');
  notOk(sb.sheet('Obra A - Empreiteiro'), 'both of them');
  ok(sb.sheet('Obra B - CaixaObra'), 'the other project\'s tab survives');
  deepEqual(sb.rows('Obra B - CaixaObra').map((r) => r.id), ['b1']);
});

test('renameProject renames the tabs and keeps the rows resolvable', () => {
  const sb = twoProjects();
  const res = sb.post({ idToken: 'tok-admin', action: 'renameProject', oldName: 'Obra A', newName: 'Obra Alpha' });
  ok(res.ok, JSON.stringify(res));
  ok(sb.sheet('Obra Alpha - CaixaObra'), 'the tab followed the rename');
  notOk(sb.sheet('Obra A - CaixaObra'), 'under its old name it is gone');
  const all = sb.post({ idToken: 'tok-admin', action: 'getAll' });
  const row = all.caixaObra.find((r) => r.id === 'a1');
  ok(row, 'the row is still readable');
  equal(row.projeto, 'Obra Alpha', 'and its projeto column was rewritten');
});

// ---------------------------------------------------------------------------
// The transitional mode. This is the state a real spreadsheet is in between
// the backend deploy and the moment the migration is run, and getting it
// wrong means an empty app plus a duplicating re-upload.
// ---------------------------------------------------------------------------
function legacyFixture() {
  return createSandbox({
    tokens: TOKENS,
    usuarios: USUARIOS,
    papeis: PAPEIS(),
    sheets: sheetsFrom({
      Projetos: [['Obra A', 'SIM', '', 'Dalmir'], ['Obra B', 'SIM', '', 'Dalmir']],
      CaixaObra: [
        ['a1', 'Obra A', '2026-01-01', 'cimento', 'mat', '', 'und', 10, 'forn', 'Dalmir', 1, 1],
        ['b1', 'Obra B', '2026-01-02', 'areia', 'mat', '', 'und', 20, 'forn', 'Dalmir', 1, 1],
      ],
      Notas: [
        ['n1', '', 'primeira nota', 1, 'caixa', 'a1', 1],
        ['n2', '', 'segunda nota', 2, 'caixa', 'a1', 1],
        ['n3', 'Obra A', 'nota geral', 3, '', '', 1],
      ],
      Fotos: [['p1', 'notes', 'n1', 'drive1', 'u1', 1, 1]],
      Tipos: [['mat']], Unidades: [['und']], Socios: [['Dalmir']],
    }),
  });
}

test('before the migration, the app still reads the old shared tabs correctly', () => {
  const sb = legacyFixture();
  const res = sb.post({ idToken: 'tok-admin', action: 'getAll' });
  deepEqual(res.caixaObra.map((r) => r.id).sort(), ['a1', 'b1'],
    'an empty read here would make the app re-upload everything and duplicate it');
  equal(res.caixaObra.find((r) => r.id === 'a1').nome, 'cimento', 'old column order read correctly');
  equal(res.notas.length, 3, 'entry-attached notes are still Notas rows before the migration');
});

test('before the migration, a write still goes to the old shared tab', () => {
  const sb = legacyFixture();
  const res = sb.post({
    idToken: 'tok-admin', action: 'batchMulti',
    ops: [upsert('caixaObra', [{ id: 'a2', projeto: 'Obra A', nome: 'brita', valor: 30, data: '2026-02-01', criadoEm: 2, nota: 'ignorada por enquanto' }])],
  });
  ok(res.ok, JSON.stringify(res));
  deepEqual(sb.rows('CaixaObra').map((r) => r.id).sort(), ['a1', 'a2', 'b1']);
  equal(sb.rows('CaixaObra').find((r) => r.id === 'a2').nome, 'brita',
    'written in the LEGACY column order, not the new one');
});

// ---------------------------------------------------------------------------
// The migration itself
// ---------------------------------------------------------------------------
test('the migration is a dry run by default and writes nothing', () => {
  const sb = legacyFixture();
  const report = sb.ctx.migrateToPerProjectTabs();
  notOk(report.commit, 'dry run');
  deepEqual(report.legacyCounts.caixaObra, 2);
  ok(sb.sheet('CaixaObra'), 'the legacy tab is untouched');
  notOk(sb.sheet('Obra A - CaixaObra'), 'and nothing was created');
});

test('the migration splits by project, folds notes, and loses no rows', () => {
  const sb = legacyFixture();
  const report = sb.ctx.migrateToPerProjectTabsCommit();

  ok(report.rowCountsMatch, 'row totals must match exactly: ' + JSON.stringify(report));
  deepEqual(report.newCounts, { caixaObra: 2, empreiteiro: 0 });
  deepEqual(sb.rows('Obra A - CaixaObra').map((r) => r.id), ['a1']);
  deepEqual(sb.rows('Obra B - CaixaObra').map((r) => r.id), ['b1']);

  // The two notes on a1 become ONE cell, oldest first, blank line between.
  equal(sb.rows('Obra A - CaixaObra').find((r) => r.id === 'a1').nota,
    'primeira nota\n\nsegunda nota');
  equal(report.notasFolded, 2);

  // Folded notes stop being records; the standalone one stays.
  deepEqual(sb.rows('Notas').map((r) => r.id), ['n3']);

  // A photo that hung off a folded note becomes a photo OF THE ENTRY —
  // otherwise it resolves to no parent and fails closed forever.
  const p1 = sb.rows('Fotos').find((r) => r.id === 'p1');
  equal(p1.refTipo, 'caixa');
  equal(p1.refId, 'a1');
  equal(report.fotosReparented, 1);

  // The legacy tabs are renamed, never deleted.
  ok(sb.sheet('CaixaObra (antigo)'), 'the old tab is kept for eyeballing');
  notOk(sb.sheet('CaixaObra'), 'but no longer the active one');
});

test('after the migration the app reads the same data through the new tabs', () => {
  const sb = legacyFixture();
  sb.ctx.migrateToPerProjectTabsCommit();
  const res = sb.post({ idToken: 'tok-admin', action: 'getAll' });
  deepEqual(res.caixaObra.map((r) => r.id).sort(), ['a1', 'b1']);
  equal(res.caixaObra.find((r) => r.id === 'a1').nota, 'primeira nota\n\nsegunda nota');
  equal(res.notas.length, 1, 'only the standalone note remains a Notas row');
  // The photo is now reachable through its entry, and still authorized.
  ok(res.fotos.some((f) => f.id === 'p1' && f.refId === 'a1'));
});

test('re-running the migration is a no-op', () => {
  const sb = legacyFixture();
  sb.ctx.migrateToPerProjectTabsCommit();
  const before = sb.rows('Obra A - CaixaObra').length;
  const again = sb.ctx.migrateToPerProjectTabsCommit();
  ok(again.alreadyDone, 'the guard is the sheet\'s own shape, so it cannot run twice');
  equal(sb.rows('Obra A - CaixaObra').length, before, 'no rows duplicated');
});

test('the migration parks a row whose project no longer exists, never drops it', () => {
  const sb = createSandbox({
    tokens: TOKENS, usuarios: USUARIOS, papeis: PAPEIS(),
    sheets: sheetsFrom({
      Projetos: [['Obra A', 'SIM', '', 'Dalmir']],
      CaixaObra: [
        ['a1', 'Obra A', '2026-01-01', 'cimento', 'mat', '', 'und', 10, '', 'Dalmir', 1, 1],
        ['z1', 'Obra Fantasma', '2026-01-01', 'mistério', 'mat', '', 'und', 5, '', 'Dalmir', 1, 1],
      ],
      Tipos: [['mat']], Unidades: [['und']], Socios: [['Dalmir']],
    }),
  });
  const report = sb.ctx.migrateToPerProjectTabsCommit();
  deepEqual(report.unmatchedProjects, ['Obra Fantasma'], 'reported, so a person can fix it');
  deepEqual(sb.rows('Sem projeto - CaixaObra').map((r) => r.id), ['z1'], 'and kept, not dropped');
  ok(report.rowCountsMatch, 'totals still match: ' + JSON.stringify(report.newCounts));
});

test('the migration gives an empty project its tabs too', () => {
  const sb = createSandbox({
    tokens: TOKENS, usuarios: USUARIOS, papeis: PAPEIS(),
    sheets: sheetsFrom({
      Projetos: [['Obra A', 'SIM', '', 'Dalmir'], ['Obra Vazia', 'SIM', '', 'Dalmir']],
      CaixaObra: [['a1', 'Obra A', '2026-01-01', 'cimento', 'mat', '', 'und', 10, '', 'Dalmir', 1, 1]],
      Tipos: [['mat']], Unidades: [['und']], Socios: [['Dalmir']],
    }),
  });
  sb.ctx.migrateToPerProjectTabsCommit();
  ok(sb.sheet('Obra Vazia - CaixaObra'), 'every project is auditable the same way from day one');
  ok(sb.sheet('Obra Vazia - Empreiteiro'));
  equal(sb.rows('Obra Vazia - CaixaObra').length, 0);
});
