// Loads the REAL, unmodified backend/Code.js into a mocked Apps Script
// environment, so tests exercise the shipped authorization/conflict/write code
// rather than a re-implementation of it. This is the technique CLAUDE.md
// already prescribes for permission work (Section 8); it lives here now instead
// of being rebuilt as a throwaway each time.
//
// The mocks are only as complete as the flows under test need. They are
// deliberately faithful in the two places past bugs hid: a sheet is a plain
// 2D array (so a blank row, a surplus row and a Date-typed cell are all
// representable), and Drive folders are an ARRAY, not a name-keyed map, because
// real Drive has no uniqueness constraint on folder names.
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

// Overridable for the negative control — see tests/README.md.
const CODE_PATH = process.env.CMOREIRA_BACKEND || path.join(__dirname, '..', '..', 'backend', 'Code.js');
const CLIENT_ID = '901942652926-u3enra2v7f0mrd93f5tu26ll8c868io2.apps.googleusercontent.com';

// A stable numeric sheet id, like Sheets' own getSheetId(). Load-bearing for
// the per-project entry tabs: they are resolved by id, never by name, so a
// mock without one cannot exercise that path at all (and a hand-renamed tab
// would look identical to a missing one).
let sheetIdSeq = 100;

function makeSheet(name, header, rows, sheetId) {
  const data = [header.slice()].concat((rows || []).map((r) => r.slice()));
  const width = () => data.reduce((m, r) => Math.max(m, r.length), 0);
  const self = {
    _name: name,
    _sheetId: sheetId === undefined ? ++sheetIdSeq : sheetId,
    _data: data,
    // Every row as an object keyed by the header — what a test wants to assert
    // on, without reaching into the 2D array. Reads the header out of the DATA
    // rather than the constructor argument, because a tab created at runtime
    // (a per-project entry tab) gets its real header written afterwards.
    _objects() {
      const hdr = (data[0] || []).map((h) => String(h));
      return data.slice(1).map((row) => {
        const o = {};
        hdr.forEach((h, i) => { o[h] = row[i]; });
        return o;
      });
    },
    getName: () => self._name,
    setName: (n) => { self._name = n; },
    getSheetId: () => self._sheetId,
    getLastRow: () => data.length,
    getLastColumn: () => width(),
    getMaxColumns: () => Math.max(header.length, width()),
    setFrozenRows: () => {},
    insertColumnBefore: (c) => { data.forEach((row) => row.splice(c - 1, 0, '')); },
    insertColumnsAfter: (afterCol, n) => { data.forEach((row) => { for (let i = 0; i < n; i++) row.splice(afterCol + i, 0, ''); }); },
    getRange(r, c, nr, nc) {
      self._rangeCalls = (self._rangeCalls || 0) + 1;
      const rowCount = nr == null ? 1 : nr;
      const colCount = nc == null ? 1 : nc;
      const cell = (i, j) => {
        const row = data[r - 1 + i];
        const v = row ? row[c - 1 + j] : undefined;
        return v === undefined ? '' : v;
      };
      return {
        // onEdit's event object hands the handler a Range and nothing else, so
        // a Range has to know where it is. Without these, onEdit throws on its
        // first line and — being a simple trigger with nowhere to report —
        // fails completely silently, which is exactly the bug a test here is
        // meant to catch rather than reproduce.
        getSheet: () => self,
        getRow: () => r,
        getColumn: () => c,
        getNumRows: () => rowCount,
        getNumColumns: () => colCount,
        getValue: () => cell(0, 0),
        setValue: (v) => {
          while (data.length < r) data.push([]);
          data[r - 1][c - 1] = v;
        },
        getValues: () => {
          const out = [];
          for (let i = 0; i < rowCount; i++) {
            const row = [];
            for (let j = 0; j < colCount; j++) row.push(cell(i, j));
            out.push(row);
          }
          return out;
        },
        setValues: (vals) => {
          vals.forEach((row, i) => {
            while (data.length < r + i) data.push([]);
            row.forEach((v, j) => { data[r - 1 + i][c - 1 + j] = v; });
          });
        },
        clearContent: () => {
          for (let i = 0; i < rowCount; i++) {
            for (let j = 0; j < colCount; j++) {
              if (data[r - 1 + i]) data[r - 1 + i][c - 1 + j] = '';
            }
          }
        },
      };
    },
    appendRow: (vals) => data.push(vals.slice()),
    deleteRow: (r) => data.splice(r - 1, 1),
    deleteRows: (r, n) => data.splice(r - 1, n),
  };
  return self;
}

function makeFolder(id, name, registry) {
  const folder = {
    _id: id,
    _name: name,
    _files: [],
    _folders: [],       // an ARRAY: Drive allows duplicate names in one parent
    _trashed: false,
    getId: () => id,
    getName: () => folder._name,
    setName: (n) => { folder._name = n; },
    isTrashed: () => folder._trashed,
    setTrashed: (v) => { folder._trashed = !!v; },
    createFolder: (n) => {
      const child = makeFolder('folder_' + (registry.seq++), n, registry);
      folder._folders.push(child);
      return child;
    },
    getFoldersByName: (n) => iterator(folder._folders.filter((f) => f._name === n && !f._trashed)),
    getFiles: () => iterator(folder._files.filter((f) => !f._trashed)),
    createFile: (blob) => {
      const file = {
        _id: 'file_' + (registry.seq++),
        _trashed: false,
        getId() { return this._id; },
        getUrl() { return 'https://drive.example/' + this._id; },
        getDateCreated: () => new Date(0),
        setTrashed(v) { this._trashed = !!v; },
        setSharing: () => {},
      };
      registry.files[file._id] = file;
      folder._files.push(file);
      return file;
    },
    addFile: (f) => folder._files.push(f),
    removeFile: (f) => { const i = folder._files.indexOf(f); if (i > -1) folder._files.splice(i, 1); },
  };
  registry.folders[id] = folder;
  return folder;
}

function iterator(arr) {
  let i = 0;
  return { hasNext: () => i < arr.length, next: () => arr[i++] };
}

/**
 * @param {object} opts
 *   sheets    {name: {header, rows}}   business-data tabs
 *   usuarios  [[email,nome,role,projetos,ativo,criadoEm], ...]
 *   papeis    [[role,section,view,create,edit,delete,upload,export], ...]
 *   tokens    {tokenString: {email, name}}  what tokeninfo returns
 */
function createSandbox(opts) {
  const registry = { folders: {}, files: {}, seq: 1 };
  const parent = makeFolder('1BN2no3X5zHks6F94X6elC7j1kMROH7yT', 'Construtora Moreira', registry);

  const business = {};
  Object.keys(opts.sheets || {}).forEach((name) => {
    const spec = opts.sheets[name];
    business[name] = makeSheet(name, spec.header, spec.rows, spec.sheetId);
  });

  const auth = {
    Usuarios: makeSheet('Usuarios', ['email', 'nome', 'role', 'projetos', 'ativo', 'criadoEm'], opts.usuarios || []),
    Papeis: makeSheet('Papeis', ['role', 'section', 'view', 'create', 'edit', 'delete', 'upload', 'export'], opts.papeis || []),
  };

  // Tab ORDER matters as little here as it does in Sheets, but tab IDENTITY
  // matters a lot: getSheets() is how the backend enumerates per-project entry
  // tabs, and a sheet found there must be the same object getSheetByName
  // returns, or a rename through one handle would be invisible to the other.
  const ss = {
    getSheetByName: (n) => {
      const keys = Object.keys(business);
      for (let i = 0; i < keys.length; i++) {
        if (business[keys[i]]._name === n) return business[keys[i]];
      }
      return null;
    },
    getSheets: () => Object.keys(business).map((k) => business[k]),
    insertSheet: (n) => {
      const sheet = makeSheet(n, [''], []);
      business['__' + sheet._sheetId] = sheet;   // keyed by identity, not by name
      return sheet;
    },
    deleteSheet: (sheet) => {
      const keys = Object.keys(business);
      for (let i = 0; i < keys.length; i++) {
        if (business[keys[i]] === sheet) { delete business[keys[i]]; return; }
      }
    },
    getSpreadsheetTimeZone: () => 'America/Sao_Paulo',
  };

  const tokens = opts.tokens || {};
  const calls = { tokeninfo: 0 };

  const ctx = {
    console,
    JSON,
    Math,
    Date,
    String,
    Number,
    Object,
    Array,
    Error,
    RegExp,
    isNaN,
    parseInt,
    SpreadsheetApp: {
      getActiveSpreadsheet: () => ss,
      openById: () => ({
        getSheetByName: (n) => auth[n] || null,
        insertSheet: (n) => { auth[n] = makeSheet(n, [''], []); return auth[n]; },
      }),
    },
    // Never cached in tests: a stale permission matrix between two cases in the
    // same process would make one case's roles leak into the next.
    CacheService: { getScriptCache: () => ({ get: () => null, put: () => {}, remove: () => {} }) },
    // A no-op lock. Worth knowing what this CANNOT catch: a nested waitLock
    // from an execution that already holds the script lock, which real
    // LockService will not grant (it burns the full timeout and proceeds).
    // Lock nesting is invisible here, so it has to be reasoned about at the
    // call site — see the note on resolveOrCreateEntrySheet_ in Code.js.
    LockService: { getScriptLock: () => ({ waitLock: () => {}, releaseLock: () => {} }) },
    UrlFetchApp: {
      fetch: (url) => {
        calls.tokeninfo++;
        const raw = decodeURIComponent(String(url).split('id_token=')[1] || '');
        const known = tokens[raw];
        if (!known) return { getResponseCode: () => 400, getContentText: () => '{}' };
        return {
          getResponseCode: () => 200,
          getContentText: () => JSON.stringify({
            aud: known.aud || CLIENT_ID,
            email: known.email,
            email_verified: known.email_verified === undefined ? 'true' : known.email_verified,
            name: known.name || known.email,
          }),
        };
      },
    },
    DriveApp: {
      getFolderById: (id) => {
        const f = registry.folders[id];
        if (!f) throw new Error('folder not found: ' + id);
        return f;
      },
      getFileById: (id) => {
        const f = registry.files[id];
        if (!f) throw new Error('file not found: ' + id);
        return f;
      },
      Access: { ANYONE_WITH_LINK: 'ANYONE_WITH_LINK' },
      Permission: { VIEW: 'VIEW' },
    },
    Utilities: {
      formatDate: (d) => d.toISOString().slice(0, 10),
      base64Decode: (b64) => Buffer.from(String(b64 || ''), 'base64').toJSON().data,
      newBlob: (bytes, mime, name) => ({ bytes, mime, name }),
    },
    ContentService: {
      createTextOutput: (s) => ({ _json: s, setMimeType() { return this; } }),
      MimeType: { JSON: 'application/json' },
    },
    Logger: { log: () => {} },
    ScriptApp: {
      getProjectTriggers: () => [],
      deleteTrigger: () => {},
      newTrigger: () => ({ timeBased: () => ({ everyDays: () => ({ atHour: () => ({ create: () => {} }) }) }) }),
    },
  };

  vm.createContext(ctx);
  vm.runInContext(fs.readFileSync(CODE_PATH, 'utf8'), ctx, { filename: 'backend/Code.js' });

  return {
    ctx,
    sheets: business,
    auth,
    drive: { registry, parent },
    calls,
    // Reads a top-level `const`/`let` out of the loaded Code.js. A function
    // DECLARATION becomes a property of the context (so sandbox.ctx.doPost
    // works), but a const does not — it lives in the context's global lexical
    // scope, which is shared across runInContext calls but invisible on the
    // context object. This is how a test asserts on SHEETS itself.
    eval(expr) {
      return vm.runInContext(expr, ctx);
    },
    // Drives the real doPost exactly as the frontend does.
    post(body) {
      const out = ctx.doPost({ postData: { contents: JSON.stringify(body) } });
      return JSON.parse(out._json);
    },
    // Resolved by the sheet's CURRENT name, so a tab created or renamed at
    // runtime is reachable the same way a fixture tab is.
    sheet(sheetName) {
      return ss.getSheetByName(sheetName);
    },
    sheetNames() {
      return Object.keys(business).map((k) => business[k]._name);
    },
    rows(sheetName) {
      const sheet = ss.getSheetByName(sheetName);
      if (!sheet) throw new Error('no such tab in the mock spreadsheet: ' + sheetName);
      return sheet._objects();
    },
  };
}

// The schema every business tab actually has, so a test only has to supply
// rows. This is a MIRROR of SHEETS[key].cols in backend/Code.js and therefore
// the one place outside it where a column order is written down — which is
// exactly why schema-partition.test.js asserts the two agree. If someone
// reorders a column in Code.js and forgets this file, that test says so
// instead of the suite quietly testing a shape that no longer ships.
const SCHEMA = {
  Projetos: ['id', 'ativo', 'driveFolderId', 'socios', 'caixaSheetId', 'empSheetId'],
  // The per-project entry tabs, in the accountant's order. `id` is column K
  // on CaixaObra and J on Empreiteiro — a consequence of these arrays, never
  // hardcoded anywhere.
  CaixaObra: ['nome', 'qtd', 'unidade', 'data', 'valor', 'fornecedor', 'nota', 'socio', 'tipo', 'projeto', 'id', 'criadoEm', 'lastModified'],
  Empreiteiro: ['nome', 'qtd', 'unidade', 'data', 'valor', 'fornecedor', 'nota', 'socio', 'projeto', 'id', 'criadoEm', 'lastModified'],
  Tarefas: ['id', 'projeto', 'texto', 'prazo', 'prioridade', 'feito', 'criadoEm', 'lastModified'],
  Notas: ['id', 'projeto', 'texto', 'criadoEm', 'refTipo', 'refId', 'lastModified'],
  Fotos: ['id', 'refTipo', 'refId', 'driveFileId', 'driveUrl', 'criadoEm', 'lastModified'],
  Documentos: ['id', 'projeto', 'nome', 'mimeType', 'driveFileId', 'driveUrl', 'criadoEm', 'lastModified'],
  Tipos: ['tipo'],
  Unidades: ['unidade'],
  Socios: ['socio'],
};

// The pre-migration shared tabs, in their own (old) column order. A fixture
// built with these puts the backend in its TRANSITIONAL mode, which is what
// every pre-existing test exercises — deliberately, since that is the state a
// real spreadsheet is in between the deploy and the migration.
const LEGACY_SCHEMA = {
  CaixaObra: ['id', 'projeto', 'data', 'nome', 'tipo', 'qtd', 'unidade', 'valor', 'fornecedor', 'socio', 'criadoEm', 'lastModified'],
  Empreiteiro: ['id', 'projeto', 'data', 'nome', 'qtd', 'unidade', 'valor', 'fornecedor', 'socio', 'criadoEm', 'lastModified'],
};

const NON_ENTRY_TABS = Object.keys(SCHEMA).filter((n) => n !== 'CaixaObra' && n !== 'Empreiteiro');

// TRANSITIONAL-mode fixture: the shared CaixaObra/Empreiteiro tabs still
// exist, in the old column order.
function sheetsFrom(rowsByTab) {
  const out = {};
  NON_ENTRY_TABS.forEach((name) => {
    out[name] = { header: SCHEMA[name], rows: (rowsByTab && rowsByTab[name]) || [] };
  });
  ['CaixaObra', 'Empreiteiro'].forEach((name) => {
    out[name] = { header: LEGACY_SCHEMA[name], rows: (rowsByTab && rowsByTab[name]) || [] };
  });
  return out;
}

// PARTITIONED-mode fixture: no shared entry tabs at all, one pair per
// project, named exactly as the backend derives them.
//
//   partitionedSheets({
//     projetos: [['Obra Boreal', 'SIM', '', 'Dalmir', '', '']],
//     entries: { 'Obra Boreal': { caixa: [...rows...], emp: [...] } },
//     Notas: [...],
//   })
//
// Tab ids are assigned here and written into Projetos.caixaSheetId /
// empSheetId, so resolution goes down the ID-first path the same way it does
// in production after the migration.
function partitionedSheets(spec) {
  spec = spec || {};
  const out = {};
  NON_ENTRY_TABS.forEach((name) => {
    if (name === 'Projetos') return;
    out[name] = { header: SCHEMA[name], rows: (spec[name]) || [] };
  });

  const projectNames = Object.keys(spec.entries || {});
  (spec.projectNames || []).forEach((n) => { if (projectNames.indexOf(n) === -1) projectNames.push(n); });

  const ids = {};
  const tabs = [];
  projectNames.forEach((proj) => {
    const caixaId = ++sheetIdSeq;
    const empId = ++sheetIdSeq;
    ids[proj] = { caixa: caixaId, emp: empId };
    const bucket = (spec.entries && spec.entries[proj]) || {};
    tabs.push({ name: proj + ' - CaixaObra', header: SCHEMA.CaixaObra, rows: bucket.caixa || [], sheetId: caixaId });
    tabs.push({ name: proj + ' - Empreiteiro', header: SCHEMA.Empreiteiro, rows: bucket.emp || [], sheetId: empId });
  });
  tabs.forEach((t) => { out[t.name] = { header: t.header, rows: t.rows, sheetId: t.sheetId }; });

  // Projetos rows: [id, ativo, driveFolderId, socios, caixaSheetId, empSheetId]
  out.Projetos = {
    header: SCHEMA.Projetos,
    rows: (spec.projetos || projectNames.map((p) => [p, 'SIM', '', 'Dalmir', '', ''])).map((r) => {
      const row = r.slice();
      const proj = String(row[0]);
      while (row.length < SCHEMA.Projetos.length) row.push('');
      if (ids[proj]) {
        if (!row[4]) row[4] = String(ids[proj].caixa);
        if (!row[5]) row[5] = String(ids[proj].emp);
      }
      return row;
    }),
  };
  return out;
}

// Every action SIM for the named sections — the shape a real admin/owner has.
function papeisFor(role, sections, overrides) {
  return sections.map((section) => {
    const o = (overrides && overrides[section]) || {};
    return [role, section,
      o.view === false ? 'NAO' : 'SIM',
      o.create === false ? 'NAO' : 'SIM',
      o.edit === false ? 'NAO' : 'SIM',
      o.delete === false ? 'NAO' : 'SIM',
      o.upload === false ? 'NAO' : 'SIM',
      o.export === false ? 'NAO' : 'SIM'];
  });
}

const ALL_SECTIONS = ['painel', 'painel.tarefas', 'lancamentos', 'tarefas', 'notas', 'docs', 'config', 'usuarios'];

module.exports = { createSandbox, sheetsFrom, partitionedSheets, papeisFor, makeSheet, SCHEMA, LEGACY_SCHEMA, ALL_SECTIONS, CLIENT_ID };
