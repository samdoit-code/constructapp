// The spreadsheet view's column derivation.
//
// Small surface, but two things here would be silent and bad if they broke:
// a machine column becoming visible (and therefore editable — `id` is the
// handle every photo and the whole diff engine depend on), and the column
// letters drifting away from the real spreadsheet, which is the entire point
// of the view for someone reading it alongside the actual sheet.
//
// Runs the REAL functions extracted from index.html.
'use strict';

const { test, equal, ok, notOk, deepEqual } = require('./helpers/harness');
const { buildContext, appSourceText } = require('./helpers/app-source');
const { SCHEMA } = require('./helpers/apps-script');

// Seeded with the REAL schema the backend sends, so these assertions are about
// the shipped column order rather than an invented one.
function ctxWith(schema) {
  return buildContext({
    functions: ['sheetColumns_', 'sheetColLetter_'],
    declarations: ['SHEET_HIDDEN_COLS'],
    vars: {
      entrySchema: schema || {
        caixaObra: SCHEMA.CaixaObra.slice(),
        empreiteiro: SCHEMA.Empreiteiro.slice(),
      },
    },
    stubs: {},
  });
}

test('the machine columns are never visible', () => {
  const ctx = ctxWith();
  ['caixa', 'emp'].forEach((kind) => {
    const cols = ctx.sheetColumns_(kind);
    // projeto joins the three machine fields: this view shows one project's
    // tab, so the column restates the tab's own name on every row.
    ['id', 'criadoEm', 'lastModified', 'projeto'].forEach((hidden) => {
      notOk(cols.indexOf(hidden) > -1, `${hidden} must never be rendered (${kind})`);
    });
  });
});

test('every other column IS visible, in the spreadsheet\'s own order', () => {
  const ctx = ctxWith();
  deepEqual(ctx.sheetColumns_('caixa'),
    ['nome', 'qtd', 'unidade', 'data', 'valor', 'fornecedor', 'nota', 'socio', 'tipo']);
  deepEqual(ctx.sheetColumns_('emp'),
    ['nome', 'qtd', 'unidade', 'data', 'valor', 'fornecedor', 'nota', 'socio']);
});

test('column letters are counted over the FULL schema, not the visible subset', () => {
  // This is the whole reason the letters are computed separately from the
  // visible list: three columns are hidden, but the letters still have to
  // match what the person sees in Google Sheets or the view is lying.
  const ctx = ctxWith();
  equal(ctx.sheetColLetter_('caixa', 'nome'), 'A');
  equal(ctx.sheetColLetter_('caixa', 'valor'), 'E');
  equal(ctx.sheetColLetter_('caixa', 'nota'), 'G');
  equal(ctx.sheetColLetter_('caixa', 'projeto'), 'J');
  equal(ctx.sheetColLetter_('caixa', 'id'), 'K', 'hidden, but its letter is still K');
  // Empreiteiro has no tipo, so everything after it shifts one left.
  equal(ctx.sheetColLetter_('emp', 'projeto'), 'I');
  equal(ctx.sheetColLetter_('emp', 'id'), 'J');
});

test('the letters follow a schema change instead of being hardcoded', () => {
  // The view renders whatever the backend reports. Reorder a column in
  // SHEETS[key].cols and this must move with it, with no frontend edit —
  // that is what keeps one source of truth for the column order.
  const ctx = ctxWith({
    caixaObra: ['valor', 'nome', 'id', 'criadoEm', 'lastModified'],
    empreiteiro: [],
  });
  deepEqual(ctx.sheetColumns_('caixa'), ['valor', 'nome']);
  equal(ctx.sheetColLetter_('caixa', 'valor'), 'A');
  equal(ctx.sheetColLetter_('caixa', 'nome'), 'B');
});

test('a schema that has not arrived yet renders nothing rather than guessing', () => {
  // An empty list is what makes renderEntrySheet_ show "sincronize uma vez"
  // instead of inventing a column order — the failure mode to avoid is a
  // hardcoded fallback quietly becoming a second source of truth.
  const ctx = ctxWith({ caixaObra: [], empreiteiro: [] });
  deepEqual(ctx.sheetColumns_('caixa'), []);
  equal(ctx.sheetColLetter_('caixa', 'nome'), '');
});

test('an unknown field has no letter', () => {
  const ctx = ctxWith();
  equal(ctx.sheetColLetter_('caixa', 'naoexiste'), '');
});

// ---------------------------------------------------------------------------
// Source-level: the frontend must not grow its own copy of the column order.
// ---------------------------------------------------------------------------
test('the frontend hardcodes no entry column order', () => {
  const src = appSourceText();
  ok(/entrySchema\[kind === 'caixa' \? 'caixaObra' : 'empreiteiro'\]/.test(src),
    'columns must come from the backend-supplied schema');
  // The literal A:M order must appear nowhere in index.html — that array lives
  // in backend/Code.js and only there.
  notOk(/'nome'\s*,\s*'qtd'\s*,\s*'unidade'\s*,\s*'data'\s*,\s*'valor'/.test(src),
    'the column order must not be duplicated into the frontend');
});

test('money cells commit through parseDecimalBR, never the browser\'s parser', () => {
  // A cell typed as "1.500" is one thousand five hundred in pt-BR. Reading it
  // with parseFloat/valueAsNumber writes 1.5 — a thousandth of the real
  // amount, silently. This is the one defect class that can corrupt the books.
  const src = appSourceText();
  ok(/function commitSheetCell_/.test(src));
  const fn = src.slice(src.indexOf('function commitSheetCell_'));
  const body = fn.slice(0, fn.indexOf('\n  }'));
  ok(/parseDecimalBR\(raw\)/.test(body), 'numeric commit must use parseDecimalBR');
  notOk(/parseFloat|valueAsNumber|Number\(raw\)/.test(body),
    'no browser-locale number parsing on the money path');
});

test('numeric cells are type=text so the browser cannot pre-parse them', () => {
  // type="number" would hand parsing to the browser's own locale rules before
  // parseDecimalBR ever sees the string, which is exactly the bug above.
  const src = appSourceText();
  ok(/inputmode="decimal"/.test(src), 'numeric keypad without browser parsing');
  const cellFn = src.slice(src.indexOf('function sheetCellHTML_'));
  // Comments stripped first: the code carries a comment that NAMES
  // type="number" to explain why it is not used, and a naive match reads that
  // as the thing it is warning about.
  const body = cellFn.slice(0, cellFn.indexOf('\n  }')).replace(/\/\/[^\n]*/g, '');
  notOk(/type="number"/.test(body), 'never type=number on a money cell');
});
