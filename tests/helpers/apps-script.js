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

function makeSheet(name, header, rows) {
  const data = [header.slice()].concat((rows || []).map((r) => r.slice()));
  const width = () => data.reduce((m, r) => Math.max(m, r.length), 0);
  return {
    _name: name,
    _data: data,
    // Every row as an object keyed by the header — what a test wants to assert
    // on, without reaching into the 2D array.
    _objects() {
      return data.slice(1).map((row) => {
        const o = {};
        header.forEach((h, i) => { o[h] = row[i]; });
        return o;
      });
    },
    getName: () => name,
    getLastRow: () => data.length,
    getLastColumn: () => width(),
    getMaxColumns: () => Math.max(header.length, width()),
    setFrozenRows: () => {},
    insertColumnBefore: (c) => { data.forEach((row) => row.splice(c - 1, 0, '')); },
    insertColumnsAfter: (afterCol, n) => { data.forEach((row) => { for (let i = 0; i < n; i++) row.splice(afterCol + i, 0, ''); }); },
    getRange(r, c, nr, nc) {
      const rowCount = nr == null ? 1 : nr;
      const colCount = nc == null ? 1 : nc;
      const cell = (i, j) => {
        const row = data[r - 1 + i];
        const v = row ? row[c - 1 + j] : undefined;
        return v === undefined ? '' : v;
      };
      return {
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
    business[name] = makeSheet(name, opts.sheets[name].header, opts.sheets[name].rows);
  });

  const auth = {
    Usuarios: makeSheet('Usuarios', ['email', 'nome', 'role', 'projetos', 'ativo', 'criadoEm'], opts.usuarios || []),
    Papeis: makeSheet('Papeis', ['role', 'section', 'view', 'create', 'edit', 'delete', 'upload', 'export'], opts.papeis || []),
  };

  const ss = {
    getSheetByName: (n) => business[n] || null,
    insertSheet: (n) => { business[n] = makeSheet(n, [''], []); return business[n]; },
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
    // Drives the real doPost exactly as the frontend does.
    post(body) {
      const out = ctx.doPost({ postData: { contents: JSON.stringify(body) } });
      return JSON.parse(out._json);
    },
    rows(sheetName) {
      return business[sheetName]._objects();
    },
  };
}

// The schema every business tab actually has, so a test only has to supply rows.
const SCHEMA = {
  Projetos: ['id', 'ativo', 'driveFolderId', 'socios'],
  CaixaObra: ['id', 'projeto', 'data', 'nome', 'tipo', 'qtd', 'unidade', 'valor', 'fornecedor', 'socio', 'criadoEm', 'lastModified'],
  Empreiteiro: ['id', 'projeto', 'data', 'nome', 'qtd', 'unidade', 'valor', 'fornecedor', 'socio', 'criadoEm', 'lastModified'],
  Tarefas: ['id', 'projeto', 'texto', 'prazo', 'prioridade', 'feito', 'criadoEm', 'lastModified'],
  Notas: ['id', 'projeto', 'texto', 'criadoEm', 'refTipo', 'refId', 'lastModified'],
  Fotos: ['id', 'refTipo', 'refId', 'driveFileId', 'driveUrl', 'criadoEm', 'lastModified'],
  Documentos: ['id', 'projeto', 'nome', 'mimeType', 'driveFileId', 'driveUrl', 'criadoEm', 'lastModified'],
  Tipos: ['tipo'],
  Unidades: ['unidade'],
  Socios: ['socio'],
};

function sheetsFrom(rowsByTab) {
  const out = {};
  Object.keys(SCHEMA).forEach((name) => {
    out[name] = { header: SCHEMA[name], rows: (rowsByTab && rowsByTab[name]) || [] };
  });
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

module.exports = { createSandbox, sheetsFrom, papeisFor, makeSheet, SCHEMA, ALL_SECTIONS, CLIENT_ID };
