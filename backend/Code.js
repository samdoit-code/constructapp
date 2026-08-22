/**
 * CONSTRUTORA MOREIRA — Apps Script backend
 * ------------------------------------------------------------
 * This script turns the Google Sheet into a small API the app can talk to,
 * and handles saving photos/documents into the right Google Drive folder.
 *
 * SETUP:
 * 1. Paste this whole file into Extensions > Apps Script (opened FROM the
 *    Google Sheet itself) — that makes it "container-bound", so it already
 *    knows which Sheet to use. You do not need to set a Sheet ID.
 * 2. Deploy > Manage deployments > Edit (pencil) > New version > Deploy.
 *    Same URL as before, no changes needed on that front.
 * 3. Run installDailyBackupTrigger() ONCE from this editor (select it in the
 *    function dropdown at the top, click Run). This sets up an automatic
 *    daily backup — you only need to do this one time, ever.
 * 4. Every tab used by row-level sync (CaixaObra, Empreiteiro, Tarefas,
 *    Notas, Fotos, Documentos) needs a "lastModified" column added as the
 *    LAST column, after whatever is already there. Projetos/Tipos/Unidades
 *    do not need this column.
 * ------------------------------------------------------------
 */

// ==================================================================
// AUTH BLOCK — reusable across future apps. Only the two constants
// below (GOOGLE_CLIENT_ID, AUTH_SHEET_ID) need to change per app; the
// functions are meant to be copy-pasted as-is.
//
// SETUP (one-time, manual, in Google Cloud Console):
// 1. console.cloud.google.com → APIs & Services → Credentials →
//    Create Credentials → OAuth client ID → Application type: Web application.
// 2. Under "Authorized JavaScript origins", add the exact URL the app is
//    hosted at (e.g. https://yourname.github.io) — Google checks this
//    server-side during sign-in, so it must match exactly, no trailing slash.
// 3. Copy the generated Client ID into GOOGLE_CLIENT_ID below, and the
//    matching constant in the HTML file.
//
// PHASE A SCOPE: this block only establishes WHO is calling (identity).
// It does not yet decide what they're allowed to see or do — every
// recognized, active user passes. Role/project enforcement is Phase B,
// added on top of getCurrentUser_() without changing its contract.
// ==================================================================
const GOOGLE_CLIENT_ID = '901942652926-u3enra2v7f0mrd93f5tu26ll8c868io2.apps.googleusercontent.com';
// ID of the SEPARATE spreadsheet holding Usuarios — deliberately not the
// same file as the business data, so someone with access to CaixaObra etc.
// still can't see who has what role. Reused verbatim by future apps; only
// this ID changes.
const AUTH_SHEET_ID = '1xrIBaMKTNGnVxSWw7eRSszzkRo7otNL8kgucEXLoaZY';

function authSheet_() {
  const sheet = SpreadsheetApp.openById(AUTH_SHEET_ID).getSheetByName('Usuarios');
  if (!sheet) throw new Error('Aba Usuarios não encontrada na planilha de autenticação.');
  return sheet;
}

// Verifies a Google ID token is genuine, was issued for THIS app (not some
// other Google Sign-In client), and carries a verified email — all three
// checks matter; skipping any one of them defeats the point.
function verifyIdToken_(idToken) {
  if (!idToken) throw new Error('não autenticado');
  const resp = UrlFetchApp.fetch(
    'https://oauth2.googleapis.com/tokeninfo?id_token=' + encodeURIComponent(idToken),
    { muteHttpExceptions: true }
  );
  if (resp.getResponseCode() !== 200) throw new Error('não autenticado');
  const info = JSON.parse(resp.getContentText());
  if (info.aud !== GOOGLE_CLIENT_ID) throw new Error('não autenticado');
  if (!info.email || info.email_verified !== 'true') throw new Error('não autenticado');
  return { email: String(info.email).toLowerCase().trim(), name: info.name || info.email };
}

// The single entry point every request goes through. Verifies the token,
// then confirms the email is a known, active row in Usuarios. Returns the
// user record (role/projects included now so Phase B has zero contract
// changes to make) or throws — callers don't need to know which failed.
function getCurrentUser_(idToken) {
  const identity = verifyIdToken_(idToken);
  const sheet = authSheet_();
  const lastRow = sheet.getLastRow();
  if (lastRow < 2) throw new Error('não autorizado');
  const values = sheet.getRange(2, 1, lastRow - 1, 6).getValues(); // email,nome,role,projetos,ativo,criadoEm

  for (let i = 0; i < values.length; i++) {
    const row = values[i];
    const email = String(row[0]).toLowerCase().trim();
    if (email !== identity.email) continue;

    const ativo = (row[4] === true || String(row[4]).toUpperCase() === 'SIM');
    if (!ativo) throw new Error('usuário desativado');

    const projetosRaw = String(row[3] || '').trim();
    const role = String(row[2] || '').toLowerCase().trim();
    return {
      email: email,
      nome: row[1] || identity.name,
      role: role,
      // '*' means all projects; otherwise a plain array to check membership against.
      projects: projetosRaw === '*' ? '*' : projetosRaw.split(',').map(p => p.trim()).filter(Boolean),
      // '*' means all pages; otherwise a plain array. Resolved here (not left
      // for the frontend to compute) so the UI never re-implements role logic —
      // it just renders what the backend, the actual source of authority, says.
      pages: (ROLES[role] && ROLES[role].pages) || [],
    };
  }
  throw new Error('usuário não cadastrado');
}
// ==================================================================
// END AUTH BLOCK
// ==================================================================

// ==================================================================
// AUTHORIZATION BLOCK (Phase B) — role + project-level enforcement, built
// entirely on getCurrentUser_()'s existing {email, role, projects} contract
// from Phase A. Reusable as-is: ROLES is the only thing a future app would
// likely want to edit (add a role, change what it can do) — everything else
// here reads that config rather than hardcoding role names.
// ==================================================================
const ROLES = {
  admin:   { manageUsers: true,  write: true,  pages: '*' },
  owner:   { manageUsers: false, write: true,  pages: '*' },
  partner: { manageUsers: false, write: false, pages: ['painel', 'lancamentos', 'docs'] },
};

// Maps each page to the sheet(s) whose data belongs to it. Purely additive —
// pages not listed here (dashboard-only reference data, etc.) are unaffected.
// A page's SHEETS are wiped to empty for a user lacking that page — same
// "trim the getAll payload" principle as project filtering, just a second,
// independent axis over the same data.
const PAGE_SHEETS = {
  painel: [],                              // dashboard reads from other sheets already filtered by project
  lancamentos: ['caixaObra', 'empreiteiro'],
  tarefas: ['tarefas'],
  notas: ['notas'],
  docs: ['documentos', 'fotos'],
};

function hasPageAccess_(user, page) {
  const cfg = ROLES[user.role];
  if (!cfg) return false;
  return cfg.pages === '*' || cfg.pages.indexOf(page) > -1;
}

function requireWrite_(user) {
  const cfg = ROLES[user.role];
  if (!cfg || !cfg.write) throw new Error('sem permissão para escrever');
}

function hasProjectAccess_(user, projectName) {
  if (user.projects === '*') return true;
  if (!projectName) return false;
  return user.projects.indexOf(projectName) > -1;
}

// Notas/Fotos rows don't carry a "projeto" field directly — they link back to
// a parent via refTipo/refId (an entry, a task, or — for a photo attached to
// a note — the note itself, which may in turn be standalone or attached to
// an entry). These resolve that chain once per getAll/write, building simple
// id→projeto lookup maps rather than re-scanning rows repeatedly.
function buildEntryProjectIndex_(caixaObra, empreiteiro, tarefas) {
  const idx = { caixa: {}, emp: {}, tasks: {} };
  caixaObra.forEach(r => { idx.caixa[r.id] = r.projeto; });
  empreiteiro.forEach(r => { idx.emp[r.id] = r.projeto; });
  tarefas.forEach(r => { idx.tasks[r.id] = r.projeto; });
  return idx;
}
function resolveNotaProject_(nota, entryIdx) {
  if (nota.projeto) return nota.projeto; // standalone note
  if (nota.refTipo === 'caixa') return entryIdx.caixa[nota.refId];
  if (nota.refTipo === 'emp') return entryIdx.emp[nota.refId];
  return undefined;
}
function resolveFotoProject_(foto, entryIdx, notaProjectById) {
  if (foto.refTipo === 'caixa') return entryIdx.caixa[foto.refId];
  if (foto.refTipo === 'emp') return entryIdx.emp[foto.refId];
  if (foto.refTipo === 'tasks') return entryIdx.tasks[foto.refId];
  if (foto.refTipo === 'notes') return notaProjectById[foto.refId];
  return undefined;
}

// Trims a freshly-read getAll payload down to what this user is allowed to
// see. Tipos/Unidades pass through untouched — small shared reference lists,
// not project- or page-scoped data.
function filterAllByAccess_(user, data) {
  // Page axis first — independent of project access, so this runs regardless
  // of whether the user has '*' projects or a restricted list.
  Object.keys(PAGE_SHEETS).forEach(page => {
    if (hasPageAccess_(user, page)) return;
    PAGE_SHEETS[page].forEach(sheet => { data[sheet] = []; });
  });

  if (user.projects === '*') return data; // full project access — nothing further to trim

  const entryIdx = buildEntryProjectIndex_(data.caixaObra, data.empreiteiro, data.tarefas);
  const notaProjectById = {};
  data.notas.forEach(n => { notaProjectById[n.id] = resolveNotaProject_(n, entryIdx); });

  data.projetos = data.projetos.filter(p => hasProjectAccess_(user, p.id));
  data.caixaObra = data.caixaObra.filter(r => hasProjectAccess_(user, r.projeto));
  data.empreiteiro = data.empreiteiro.filter(r => hasProjectAccess_(user, r.projeto));
  data.tarefas = data.tarefas.filter(r => hasProjectAccess_(user, r.projeto));
  data.documentos = data.documentos.filter(r => hasProjectAccess_(user, r.projeto));
  data.notas = data.notas.filter(n => hasProjectAccess_(user, notaProjectById[n.id]));
  data.fotos = data.fotos.filter(f => hasProjectAccess_(user, resolveFotoProject_(f, entryIdx, notaProjectById)));
  return data;
}

// Rejects a write outright if ANY row it touches belongs to a project outside
// the user's access — checked BEFORE anything is written, same all-or-nothing
// principle as the existing conflict check. Reads current sheet state once
// (cheap: just id+projeto per row) so it can resolve deletes and edits to
// EXISTING rows, then merges in any new parent rows created within this same
// batch, so "new entry + its new photo/note" (a normal single save) resolves
// correctly without a false rejection.
// Reverse of PAGE_SHEETS — which page owns a given sheet, for the write check below.
const SHEET_TO_PAGE = {};
Object.keys(PAGE_SHEETS).forEach(page => {
  PAGE_SHEETS[page].forEach(sheet => { SHEET_TO_PAGE[sheet] = page; });
});

function assertBatchProjectAccess_(user, ops) {
  // Page axis first, unconditionally — independent of project access, so this
  // must run even for a user with projects:'*' but a restricted page list.
  ops.forEach(op => {
    const page = SHEET_TO_PAGE[op.sheet];
    if (page && !hasPageAccess_(user, page)) throw new Error('sem acesso a esta página');
  });

  if (user.projects === '*') return; // full project access — nothing further to check

  const existingCaixa = readSheet_('caixaObra');
  const existingEmp = readSheet_('empreiteiro');
  const existingTasks = readSheet_('tarefas');
  const existingNotas = readSheet_('notas');
  const entryIdx = buildEntryProjectIndex_(existingCaixa, existingEmp, existingTasks);

  // Merge in same-batch new/edited parents so a brand-new entry's own photos/
  // notes (created in the same request) resolve correctly.
  ops.forEach(op => {
    if (op.sheet === 'caixaObra') (op.upserts || []).forEach(u => { entryIdx.caixa[u.id] = u.row.projeto; });
    if (op.sheet === 'empreiteiro') (op.upserts || []).forEach(u => { entryIdx.emp[u.id] = u.row.projeto; });
    if (op.sheet === 'tarefas') (op.upserts || []).forEach(u => { entryIdx.tasks[u.id] = u.row.projeto; });
  });
  const notaProjectById = {};
  existingNotas.forEach(n => { notaProjectById[n.id] = resolveNotaProject_(n, entryIdx); });
  ops.forEach(op => {
    if (op.sheet === 'notas') (op.upserts || []).forEach(u => { notaProjectById[u.id] = resolveNotaProject_(u.row, entryIdx); });
  });

  function projectOfRow(sheet, id, row) {
    if (sheet === 'caixaObra' || sheet === 'empreiteiro' || sheet === 'tarefas' || sheet === 'documentos') {
      return row ? row.projeto : (entryIdx.caixa[id] || entryIdx.emp[id] || entryIdx.tasks[id]);
    }
    if (sheet === 'notas') return row ? resolveNotaProject_(row, entryIdx) : notaProjectById[id];
    if (sheet === 'fotos') return row ? resolveFotoProject_(row, entryIdx, notaProjectById) : undefined;
    return undefined;
  }

  ops.forEach(op => {
    (op.upserts || []).forEach(u => {
      if (!hasProjectAccess_(user, projectOfRow(op.sheet, u.id, u.row))) {
        throw new Error('sem acesso a este projeto');
      }
    });
    (op.deletes || []).forEach(id => {
      if (!hasProjectAccess_(user, projectOfRow(op.sheet, id, null))) {
        throw new Error('sem acesso a este projeto');
      }
    });
  });
}
// ==================================================================
// END AUTHORIZATION BLOCK
// ==================================================================

// Drive folder IDs — one per project, plus a fallback "unfiled" folder.
const PROJECT_FOLDERS = {
  'Obra Gavião': '1NZ-JdKm7_dATmYDPDgEDJMGJLoXGv6Uu',
  'Obra Boreal': '1WPZnzIzDeBc2x57OArVInOACDIzgUh8F',
};
const FALLBACK_FOLDER_ID = '1BN2no3X5zHks6F94X6elC7j1kMROH7yT'; // "Construtora Moreira" parent

// Which sheet tabs are exposed, and their column order (must match the header
// row exactly). Tabs with "rowLevel:true" support the new upsert/delete/conflict
// flow and need a trailing "lastModified" column; the other three (small
// reference lists, rarely edited concurrently) still use simple whole-tab saves.
const SHEETS = {
  projetos:    { name: 'Projetos',    cols: ['id', 'ativo'] },
  caixaObra:   { name: 'CaixaObra',   cols: ['id','projeto','data','nome','tipo','qtd','unidade','valor','fornecedor','socio','criadoEm','lastModified'], rowLevel: true },
  empreiteiro: { name: 'Empreiteiro', cols: ['id','projeto','data','nome','qtd','unidade','valor','fornecedor','socio','criadoEm','lastModified'], rowLevel: true },
  tarefas:     { name: 'Tarefas',     cols: ['id','projeto','texto','prazo','prioridade','feito','criadoEm','lastModified'], rowLevel: true },
  notas:       { name: 'Notas',       cols: ['id','projeto','texto','criadoEm','refTipo','refId','lastModified'], rowLevel: true },
  fotos:       { name: 'Fotos',       cols: ['id','refTipo','refId','driveFileId','driveUrl','criadoEm','lastModified'], rowLevel: true },
  documentos:  { name: 'Documentos',  cols: ['id','projeto','nome','mimeType','driveFileId','driveUrl','criadoEm','lastModified'], rowLevel: true },
  tipos:       { name: 'Tipos',       cols: ['tipo'] },
  unidades:    { name: 'Unidades',    cols: ['unidade'] },
};

function ss_() { return SpreadsheetApp.getActiveSpreadsheet(); }

function uid_(prefix) {
  return prefix + '_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8);
}

function fmtDate_(val) {
  if (val instanceof Date) {
    return Utilities.formatDate(val, Session.getScriptTimeZone(), 'yyyy-MM-dd');
  }
  return val || '';
}

// Reads a sheet fully into an array of objects, using the header row as keys.
// Any row missing an "id" gets one assigned AND written back to the sheet,
// so IDs stay stable across every future read — this is what lets you leave
// the id column blank when filling data in by hand.
function readSheet_(key) {
  const cfg = SHEETS[key];
  const sheet = ss_().getSheetByName(cfg.name);
  if (!sheet) return [];
  const lastRow = sheet.getLastRow();
  const lastCol = cfg.cols.length;
  if (lastRow < 2) return [];

  const range = sheet.getRange(2, 1, lastRow - 1, lastCol);
  const values = range.getValues();
  const hasId = cfg.cols[0] === 'id';
  let idsWereAssigned = false;

  const rows = values.map((row) => {
    const obj = {};
    cfg.cols.forEach((col, c) => {
      let v = row[c];
      if (col === 'data') v = fmtDate_(v);
      if (col === 'criadoEm' || col === 'lastModified') v = v || Date.now();
      if (col === 'feito' || col === 'ativo') v = (v === true || String(v).toUpperCase() === 'SIM' || String(v).toUpperCase() === 'TRUE');
      obj[col] = v;
    });
    if (hasId && !obj.id) {
      obj.id = uid_(key);
      row[0] = obj.id;
      idsWereAssigned = true;
    }
    return obj;
  });

  if (idsWereAssigned) {
    range.setValues(values); // write the newly-assigned IDs back to the sheet
  }
  return rows;
}

// A cell value starting with =, +, -, or @ is live-formula syntax the moment
// anyone opens the sheet directly (or exports it to CSV/Excel) — a leading
// apostrophe forces Sheets to treat it as literal text instead. Only applies
// to free-text string fields typed by users (nome, fornecedor, texto, etc.);
// numbers/booleans are untouched.
function sanitizeCell_(v) {
  if (typeof v === 'string' && /^[=+\-@]/.test(v)) return "'" + v;
  return v;
}

// Legacy whole-tab replace — still used for Projetos/Tipos/Unidades, the small
// reference lists that don't need row-level conflict tracking.
function writeSheet_(key, rows) {
  const cfg = SHEETS[key];
  const sheet = ss_().getSheetByName(cfg.name);
  if (!sheet) throw new Error('Aba não encontrada: ' + cfg.name);

  const lastRow = sheet.getLastRow();
  if (lastRow > 1) {
    sheet.getRange(2, 1, lastRow - 1, cfg.cols.length).clearContent();
  }
  if (!rows || rows.length === 0) return;

  const values = rows.map(r => cfg.cols.map(c => {
    const v = r[c];
    if (v === undefined || v === null) return '';
    if (typeof v === 'boolean') return v ? 'SIM' : 'NAO';
    return sanitizeCell_(v);
  }));
  sheet.getRange(2, 1, values.length, cfg.cols.length).setValues(values);
}

function findRowIndexById_(sheet, id) {
  const lastRow = sheet.getLastRow();
  if (lastRow < 2) return -1;
  const ids = sheet.getRange(2, 1, lastRow - 1, 1).getValues();
  for (let i = 0; i < ids.length; i++) {
    if (String(ids[i][0]) === String(id)) return i + 2; // actual sheet row number
  }
  return -1;
}

function rowValuesFromObj_(cfg, rowObj) {
  return cfg.cols.map(c => {
    const v = rowObj[c];
    if (v === undefined || v === null) return '';
    if (typeof v === 'boolean') return v ? 'SIM' : 'NAO';
    return sanitizeCell_(v);
  });
}

// Checks every upsert in a batch for a stale lastModified BEFORE writing
// anything — avoids a half-applied batch when one row in it has a conflict.
function findConflicts_(ops) {
  const conflicts = [];
  ops.forEach(op => {
    const cfg = SHEETS[op.sheet];
    if (!cfg || !cfg.rowLevel) return;
    const sheet = ss_().getSheetByName(cfg.name);
    if (!sheet) return;
    const lmCol = cfg.cols.indexOf('lastModified') + 1;
    (op.upserts || []).forEach(u => {
      if (!u.expectedLastModified) return; // brand-new row, nothing to conflict with
      const rowIdx = findRowIndexById_(sheet, u.id);
      if (rowIdx === -1) return; // row vanished (deleted elsewhere) — treat as new
      const current = sheet.getRange(rowIdx, lmCol).getValue();
      if (String(current) !== String(u.expectedLastModified)) {
        conflicts.push({ sheet: op.sheet, id: u.id });
      }
    });
  });
  return conflicts;
}

function applyBatch_(ops) {
  const updated = {};
  ops.forEach(op => {
    const cfg = SHEETS[op.sheet];
    if (!cfg || !cfg.rowLevel) return;
    const sheet = ss_().getSheetByName(cfg.name);
    if (!sheet) return;
    updated[op.sheet] = [];

    (op.upserts || []).forEach(u => {
      const newLastModified = Date.now();
      const rowObj = Object.assign({}, u.row, { lastModified: newLastModified });
      const rowIdx = findRowIndexById_(sheet, u.id);
      const values = rowValuesFromObj_(cfg, rowObj);
      if (rowIdx > -1) {
        sheet.getRange(rowIdx, 1, 1, cfg.cols.length).setValues([values]);
      } else {
        sheet.appendRow(values);
      }
      updated[op.sheet].push({ id: u.id, lastModified: newLastModified });
    });

    (op.deletes || []).forEach(id => {
      const rowIdx = findRowIndexById_(sheet, id);
      if (rowIdx > -1) sheet.deleteRow(rowIdx);
    });
  });
  return updated;
}

// GET is no longer used for anything — reads now go through doPost (see
// 'getAll' below) so the bearer idToken never has to travel in a URL/query
// string, where it'd be liable to end up in logs. Kept as a harmless no-op
// rather than removed outright, since Apps Script always requires a doGet.
function doGet(e) {
  return jsonOut_({ error: 'Use POST.' });
}

// Whole-tab save for Projetos is access-scoped data (unlike Tipos/Unidades,
// shared reference lists) — a user restricted to specific projects only ever
// has THOSE rows in memory (getAll already filtered the rest out for them),
// so a plain clear-and-replace would silently delete every project outside
// their own view. Preserving whatever's currently in the sheet that they
// can't see, and only replacing the portion they do have access to, keeps
// their normal add/rename actions working without that blast radius.
function saveProjetos_(user, rows) {
  if (user.projects === '*') {
    writeSheet_('projetos', rows);
    return;
  }
  const existing = readSheet_('projetos');
  const outOfScope = existing.filter(p => !hasProjectAccess_(user, p.id));
  writeSheet_('projetos', outOfScope.concat(rows || []));
}

function doPost(e) {
  let body;
  try {
    body = JSON.parse(e.postData.contents);
  } catch (err) {
    return jsonOut_({ error: 'JSON inválido' });
  }

  try {
    const user = getCurrentUser_(body.idToken);
    const action = body.action;

    // Pure read — no lock needed, same as this used to behave under doGet.
    if (action === 'getAll') {
      const out = { currentUser: user };
      Object.keys(SHEETS).forEach(key => { out[key] = readSheet_(key); });
      return jsonOut_(filterAllByAccess_(user, out));
    }

    requireWrite_(user); // every remaining action is a write — Partner is rejected here, before any of them

    const lock = LockService.getScriptLock();
    try {
      lock.waitLock(15000);
    } catch (err) {
      return jsonOut_({ error: 'Servidor ocupado, tente novamente.' });
    }
    try {
      if (action === 'batchMulti') {
        const ops = body.ops || [];
        assertBatchProjectAccess_(user, ops); // rejects the WHOLE batch if any row is outside the user's projects
        const conflicts = findConflicts_(ops);
        if (conflicts.length > 0) {
          return jsonOut_({ conflict: true, conflicts: conflicts });
        }
        const updated = applyBatch_(ops);
        return jsonOut_({ ok: true, updated: updated });
      }

      // Legacy whole-tab save — still used for Projetos/Tipos/Unidades. Tipos/
      // Unidades are small shared reference lists (no further authorization
      // needed beyond the write-role check above); Projetos IS access-scoped,
      // see saveProjetos_.
      if (action === 'saveSheet') {
        if (body.sheet === 'projetos') {
          saveProjetos_(user, body.rows);
        } else {
          writeSheet_(body.sheet, body.rows);
        }
        return jsonOut_({ ok: true });
      }

      if (action === 'uploadFile') {
        if (!hasProjectAccess_(user, body.projeto)) throw new Error('sem acesso a este projeto');
        const folderId = PROJECT_FOLDERS[body.projeto] || FALLBACK_FOLDER_ID;
        const folder = DriveApp.getFolderById(folderId);
        const bytes = Utilities.base64Decode(body.base64);
        const blob = Utilities.newBlob(bytes, body.mimeType, body.filename);
        const file = folder.createFile(blob);
        file.setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW);
        return jsonOut_({ ok: true, fileId: file.getId(), url: file.getUrl() });
      }

      if (action === 'deleteFile') {
        // Only allow trashing a file this app actually knows about (a photo or
        // document it uploaded) — otherwise, since the script runs as the
        // deploying account, a raw fileId could reach ANY file that account
        // can access, not just this app's own.
        const isKnown = readSheet_('fotos').some(f => f.driveFileId === body.fileId) ||
          readSheet_('documentos').some(d => d.driveFileId === body.fileId);
        if (!isKnown) throw new Error('arquivo não encontrado');
        const file = DriveApp.getFileById(body.fileId);
        file.setTrashed(true);
        return jsonOut_({ ok: true });
      }

      return jsonOut_({ error: 'Ação desconhecida: ' + action });
    } finally {
      lock.releaseLock();
    }
  } catch (err) {
    return jsonOut_({ error: err.message || String(err) });
  }
}

function jsonOut_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}

// ------------------------------------------------------------
// Scheduled backups — run installDailyBackupTrigger() ONCE, manually, from
// this editor. After that it just runs on its own, daily, forever.
// ------------------------------------------------------------
function installDailyBackupTrigger() {
  ScriptApp.getProjectTriggers().forEach(t => {
    if (t.getHandlerFunction() === 'backupSpreadsheet_') ScriptApp.deleteTrigger(t);
  });
  ScriptApp.newTrigger('backupSpreadsheet_')
    .timeBased()
    .everyDays(1)
    .atHour(3)
    .create();
}

function getOrCreateBackupFolder_() {
  const parent = DriveApp.getFolderById(FALLBACK_FOLDER_ID);
  const existing = parent.getFoldersByName('Backups');
  if (existing.hasNext()) return existing.next();
  return parent.createFolder('Backups');
}

function backupSpreadsheet_() {
  const ss = ss_();
  const file = DriveApp.getFileById(ss.getId());
  const backupFolder = getOrCreateBackupFolder_();
  const dateStr = Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'yyyy-MM-dd_HHmm');
  file.makeCopy('Backup ' + dateStr, backupFolder);

  // Keep the last 30 days of backups, delete anything older.
  const cutoff = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
  const files = backupFolder.getFiles();
  while (files.hasNext()) {
    const f = files.next();
    if (f.getDateCreated() < cutoff) f.setTrashed(true);
  }
}
