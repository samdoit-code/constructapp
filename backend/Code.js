/**
 * CONSTRUTORA MOREIRA — Apps Script backend
 * ------------------------------------------------------------
 * This script turns the Google Sheet into a small API the app can talk to,
 * and handles saving photos/documents into the right Google Drive folder.
 *
 * SETUP (one-time, only if pasting this in by hand rather than via the CI
 * deploy below):
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
 * 5. Run installPapeisSheet() ONCE from this editor to create and seed the
 *    "Papeis" role/permission tab in the Usuarios spreadsheet (see the
 *    AUTHORIZATION BLOCK below) — only needed once, ever, same as step 3.
 *
 * NORMAL DEPLOYS: push to `main` under backend/** and
 * .github/workflows/deploy-backend.yml pushes AND redeploys the live Web App
 * automatically — step 2 above is only needed for a from-scratch manual setup.
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
    return {
      email: email,
      nome: row[1] || identity.name,
      role: String(row[2] || '').toLowerCase().trim(),
      // '*' means all projects; otherwise a plain array to check membership against.
      projects: projetosRaw === '*' ? '*' : projetosRaw.split(',').map(p => p.trim()).filter(Boolean),
    };
  }
  throw new Error('usuário não cadastrado');
}
// ==================================================================
// END AUTH BLOCK — identity only. What a role/section/action combination is
// allowed to do lives entirely in the AUTHORIZATION BLOCK below; nothing
// here knows or cares about permissions.
// ==================================================================

// ==================================================================
// AUTHORIZATION BLOCK (Phase B) — section + action permission model, built
// entirely on getCurrentUser_()'s {email, role, projects} contract from
// Phase A. Deliberately kept separate from Phase A: authentication (who is
// calling) never depends on authorization (what they can do).
//
// Every permission check is a (role, section, action) lookup against the
// "Papeis" tab in the same spreadsheet as Usuarios (see loadPermissionMatrix_
// below) — no role name or section name is ever hardcoded in an "if" here.
// Adding a role, changing what an existing role can do, or adding a new
// section is a spreadsheet edit, not a code change. Missing role, missing
// section, missing tab, or any read failure all resolve to "no permissions"
// — deny by default, always (see buildPermissionMatrixFromSheet_).
// ==================================================================

// Each section maps to the business-data sheet(s) it OWNS OUTRIGHT — a sheet
// whose every row belongs to that section, wholesale. 'config' and 'usuarios'
// are sections with no page of their own (see VIEW_FILTERED_SECTIONS below)
// — they exist purely to gate WRITE actions (editing Projetos/Tipos/Unidades;
// a future user-management screen), not to hide a nav tab. 'painel.tarefas'
// is a dotted PAGE.SUBSECTION key, not a data-owning section — it carries no
// sheets of its own (see "Page vs. section" below).
//
// Notas and Fotos are deliberately NOT listed under any section here, even
// though both are real sheets — see "Cross-cutting sheets" below for why.
const SECTIONS = {
  painel: [],
  'painel.tarefas': [],
  lancamentos: ['caixaObra', 'empreiteiro'],
  tarefas: ['tarefas'],
  notas: [],
  docs: ['documentos'],
  config: ['projetos', 'tipos', 'unidades'],
  usuarios: [], // reserved for a future user-management screen — not built yet
};

// Page vs. section: for most of this app a "section" IS a page (painel,
// lancamentos, tarefas, notas, docs each have exactly one nav tab). The one
// exception is 'painel.tarefas' — a WIDGET on the Painel dashboard that
// summarizes Tarefas data. It is deliberately a separate permission from
// both 'painel' (is the dashboard itself reachable) and 'tarefas' (is
// Tarefas data viewable at all, standalone-page-or-otherwise): a role could
// see the Tarefas page but not the dashboard widget, or vice versa. The
// widget can never show MORE than 'tarefas'.view already allows — it only
// additionally hides an already-authorized widget. Reusable pattern: a
// future dashboard widget for another section is just another 'painel.X' key
// here, no new mechanism.
//
// Cross-cutting sheets (Notas, Fotos): unlike every other sheet, a single
// Notas or Fotos row does NOT belong to one fixed section — it belongs to
// whichever section owns its actual parent, and both sheets are rendered
// embedded on MULTIPLE pages (a task's photo shows inside Tarefas AND in the
// Docs gallery; an entry's note shows inside the Lançamentos detail modal AND
// in the standalone Notas feed). A blanket "this whole sheet is section X"
// flag can't express that, and — critically — can't enforce it: a role
// denied 'tarefas' but granted 'docs' would still receive task-photo rows if
// Fotos were blanket-owned by 'docs'. So these two sheets are filtered PER
// ROW instead, via resolveNotaSection_()/resolveFotoSection_() below: a
// standalone note/photo -> 'notas'; one attached to a Lançamento -> matches
// e.g photos or notes embedded in DETAIL MODAL -> 'lancamentos'; a task's
// photo -> 'tarefas'. 'docs' ends up meaning "standalone Documentos only".
// filterAllByAccess_ and assertBatchAccess_ both special-case these two
// sheets for this reason — see there for the enforcement itself.

// Sections whose sheets get wiped wholesale from getAll when the user lacks
// 'view' on them. 'config'/'usuarios' are excluded on purpose: Tipos/Unidades
// are shared reference data (never section-gated, see writeSheet_ comments)
// and Projetos is filtered by PROJECT scope only (below) — neither has ever
// been page/section-view-gated, only action-gated (who may edit them).
// 'painel.tarefas' harmlessly no-ops here (it owns no sheets); Notas/Fotos
// are handled separately, per row, not by this blanket loop.
const VIEW_FILTERED_SECTIONS = Object.keys(SECTIONS).filter(function (s) { return s !== 'config' && s !== 'usuarios'; });

const PERMISSION_ACTIONS = ['view', 'create', 'edit', 'delete', 'upload', 'export'];

// Reverse of SECTIONS — which section owns a given sheet, for the write
// check in assertBatchAccess_. Notas/Fotos intentionally have NO entry here
// (see "Cross-cutting sheets" above) — assertBatchAccess_ resolves their
// section per row instead of looking it up in this map.
const SHEET_TO_SECTION = {};
Object.keys(SECTIONS).forEach(function (section) {
  SECTIONS[section].forEach(function (sheet) { SHEET_TO_SECTION[sheet] = section; });
});

function truthy_(v) {
  return v === true || String(v || '').trim().toUpperCase() === 'SIM';
}

// Reads the Papeis tab into { role: { section: {view,create,edit,delete,upload,export} } }.
// Columns: role | section | view | create | edit | delete | upload | export.
// Any failure (missing tab, unreadable spreadsheet, bad row) returns an EMPTY
// matrix rather than throwing — that is what makes every permission check
// fail closed instead of crashing open or silently granting access.
function buildPermissionMatrixFromSheet_() {
  const matrix = {};
  try {
    const sheet = SpreadsheetApp.openById(AUTH_SHEET_ID).getSheetByName('Papeis');
    if (!sheet) return matrix;
    const lastRow = sheet.getLastRow();
    if (lastRow < 2) return matrix;
    const values = sheet.getRange(2, 1, lastRow - 1, 2 + PERMISSION_ACTIONS.length).getValues();
    values.forEach(function (row) {
      const role = String(row[0] || '').toLowerCase().trim();
      const section = String(row[1] || '').toLowerCase().trim();
      if (!role || !section) return;
      const perms = {};
      PERMISSION_ACTIONS.forEach(function (action, i) { perms[action] = truthy_(row[2 + i]); });
      if (!matrix[role]) matrix[role] = {};
      matrix[role][section] = perms;
    });
  } catch (err) {
    return {}; // read/parse failure — deny everyone rather than guess
  }
  return matrix;
}

// The matrix (role capabilities) changes rarely, so it is cached briefly to
// avoid a spreadsheet read on every request. Nothing user-specific is ever
// cached here — only the role→section→action shape, identical for every user
// sharing a role. getCurrentUser_() itself is NEVER cached, so a role/ativo
// change on one specific user still takes effect on their very next request
// regardless of this TTL.
const PERMISSION_CACHE_KEY = 'papeis_matrix_v1';
const PERMISSION_CACHE_TTL_SECONDS = 300; // 5 min — cuts repeat reads while keeping a Papeis edit landing quickly

function loadPermissionMatrix_() {
  try {
    const cache = CacheService.getScriptCache();
    const cached = cache.get(PERMISSION_CACHE_KEY);
    if (cached) return JSON.parse(cached);
    const matrix = buildPermissionMatrixFromSheet_();
    try { cache.put(PERMISSION_CACHE_KEY, JSON.stringify(matrix), PERMISSION_CACHE_TTL_SECONDS); } catch (e) { /* cache write is best-effort */ }
    return matrix;
  } catch (err) {
    return buildPermissionMatrixFromSheet_(); // cache service itself unavailable — fall back to a direct read
  }
}

// Resolves a role into its full section/action permission object — every
// section this app knows about gets an explicit true/false per action, so
// callers (can_ below, and the frontend) never have to guess what a missing
// key means.
function sectionsForRole_(role) {
  const matrix = loadPermissionMatrix_();
  const roleCfg = matrix[role] || {};
  const out = {};
  Object.keys(SECTIONS).forEach(function (section) {
    const perms = roleCfg[section];
    out[section] = {};
    PERMISSION_ACTIONS.forEach(function (action) { out[section][action] = !!(perms && perms[action]); });
  });
  return out;
}

// The single generic permission check every enforcement point below goes
// through. No role name or section name is ever compared here, by design —
// a new role or a new restricted section never needs a new "if" anywhere in
// this file, only a new row in the Papeis tab.
function can_(user, section, action) {
  const perms = user.sections && user.sections[section];
  return !!(perms && perms[action]);
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

// Section counterparts of resolveNotaProject_/resolveFotoProject_ above —
// same parent-chain walk, but resolving WHICH SECTION owns the row instead
// of which project. See the "Cross-cutting sheets" comment on SECTIONS for
// why this has to be per-row rather than one flag for the whole sheet.
function resolveNotaSection_(nota) {
  if (!nota) return undefined;
  if (nota.projeto) return 'notas'; // standalone note
  if (nota.refTipo === 'caixa' || nota.refTipo === 'emp') return 'lancamentos';
  return undefined;
}
function resolveFotoSection_(foto, notaSectionById) {
  if (!foto) return undefined;
  if (foto.refTipo === 'caixa' || foto.refTipo === 'emp') return 'lancamentos';
  if (foto.refTipo === 'tasks') return 'tarefas';
  if (foto.refTipo === 'notes') return notaSectionById[foto.refId]; // 2-hop: whatever section that note itself belongs to
  return undefined;
}

// Trims a freshly-read getAll payload down to what this user is allowed to
// see. Runs generically over SECTIONS — no section name is special-cased.
// Tipos/Unidades pass through untouched — small shared reference lists, not
// project- or section-scoped data.
function filterAllByAccess_(user, data) {
  // Built from the ORIGINAL unfiltered read, before anything below wipes or
  // trims these arrays — so resolving which section a Notas/Fotos row's
  // parent belongs to is always based on real data, never on what happens to
  // be left after some other section already got wiped.
  const entryIdx = buildEntryProjectIndex_(data.caixaObra, data.empreiteiro, data.tarefas);
  const notaSectionById = {};
  data.notas.forEach(function (n) { notaSectionById[n.id] = resolveNotaSection_(n); });

  // Notas/Fotos are cross-cutting (see SECTIONS above) — filtered per row by
  // whichever section actually owns each row's parent, not by a single
  // blanket flag for the whole sheet. This is what makes deny-by-default
  // reach data embedded on another page: a task's photo shown in the Docs
  // gallery still has to pass the 'tarefas' section, not 'docs'.
  data.notas = data.notas.filter(function (n) { return can_(user, resolveNotaSection_(n), 'view'); });
  data.fotos = data.fotos.filter(function (f) { return can_(user, resolveFotoSection_(f, notaSectionById), 'view'); });

  // Section/view axis for everything else — independent of project access,
  // so this runs regardless of whether the user has '*' projects or a
  // restricted list.
  VIEW_FILTERED_SECTIONS.forEach(function (section) {
    if (can_(user, section, 'view')) return;
    SECTIONS[section].forEach(function (sheet) { data[sheet] = []; });
  });

  if (user.projects === '*') return data; // full project access — nothing further to trim

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

// Rejects a write outright if any op targets a section/action the user
// doesn't have, OR (independently) a project outside their scope — checked
// BEFORE anything is written, same all-or-nothing principle as the existing
// conflict check.
//
// The section/action check runs unconditionally, even for a user with
// projects:'*' — same non-obvious rule the old page check already relied on:
// the two axes must never short-circuit each other, otherwise a future role
// with unrestricted project access but restricted actions would silently
// bypass its action limits.
//
// create vs. edit is decided from the sheet's OWN current state (does this id
// already exist?), never from anything the client claims — a client
// declaring an edit as a "create" (or vice versa) must not be able to dodge
// a per-action restriction.
function assertBatchAccess_(user, ops) {
  const idCache = {};
  function existingRows_(sheetKey) {
    if (!idCache[sheetKey]) {
      idCache[sheetKey] = {};
      readSheet_(sheetKey).forEach(function (r) { idCache[sheetKey][r.id] = r; });
    }
    return idCache[sheetKey];
  }

  // notaSectionById: needed only to resolve a Fotos row attached to a Notas
  // row (refTipo === 'notes') — which section it belongs to depends on
  // whether THAT note is itself standalone or attached to a Lançamento. Built
  // lazily and merges same-batch new/edited notas, same pattern as the
  // project-scope section below.
  let notaSectionById = null;
  function notaSectionMap_() {
    if (notaSectionById) return notaSectionById;
    notaSectionById = {};
    const existingNotas = existingRows_('notas');
    Object.keys(existingNotas).forEach(function (id) { notaSectionById[id] = resolveNotaSection_(existingNotas[id]); });
    ops.forEach(function (op) {
      if (op.sheet === 'notas') (op.upserts || []).forEach(function (u) { notaSectionById[u.id] = resolveNotaSection_(u.row); });
    });
    return notaSectionById;
  }

  // Notas/Fotos can't use SHEET_TO_SECTION like every other sheet (see the
  // "Cross-cutting sheets" comment on SECTIONS) — their section is resolved
  // per row instead, from whichever parent the row (new or existing) actually
  // points to.
  function sectionForOp_(sheet, id, row) {
    if (sheet === 'notas') return resolveNotaSection_(row || existingRows_('notas')[id]);
    if (sheet === 'fotos') return resolveFotoSection_(row || existingRows_('fotos')[id], notaSectionMap_());
    return SHEET_TO_SECTION[sheet];
  }

  ops.forEach(function (op) {
    const existing = existingRows_(op.sheet);
    (op.upserts || []).forEach(function (u) {
      const section = sectionForOp_(op.sheet, u.id, u.row);
      if (!section) throw new Error('sem acesso a esta seção'); // unknown sheet, or a row that resolves to no known parent — fail closed
      const action = existing[u.id] ? 'edit' : 'create';
      if (!can_(user, section, action)) throw new Error('sem permissão para ' + action);
    });
    (op.deletes || []).forEach(function (id) {
      const section = sectionForOp_(op.sheet, id, null);
      if (!section) throw new Error('sem acesso a esta seção');
      if (!can_(user, section, 'delete')) throw new Error('sem permissão para excluir');
    });
  });

  if (user.projects === '*') return; // full project access — nothing further to check

  // Project-scope check below, reusing the same sheet reads already cached
  // above instead of reading caixaObra/empreiteiro/tarefas/notas again.
  const existingCaixaObj = existingRows_('caixaObra');
  const existingEmpObj = existingRows_('empreiteiro');
  const existingTasksObj = existingRows_('tarefas');
  const existingNotasObj = existingRows_('notas');
  const entryIdx = { caixa: {}, emp: {}, tasks: {} };
  Object.keys(existingCaixaObj).forEach(function (id) { entryIdx.caixa[id] = existingCaixaObj[id].projeto; });
  Object.keys(existingEmpObj).forEach(function (id) { entryIdx.emp[id] = existingEmpObj[id].projeto; });
  Object.keys(existingTasksObj).forEach(function (id) { entryIdx.tasks[id] = existingTasksObj[id].projeto; });

  // Merge in same-batch new/edited parents so a brand-new entry's own photos/
  // notes (created in the same request) resolve correctly.
  ops.forEach(op => {
    if (op.sheet === 'caixaObra') (op.upserts || []).forEach(u => { entryIdx.caixa[u.id] = u.row.projeto; });
    if (op.sheet === 'empreiteiro') (op.upserts || []).forEach(u => { entryIdx.emp[u.id] = u.row.projeto; });
    if (op.sheet === 'tarefas') (op.upserts || []).forEach(u => { entryIdx.tasks[u.id] = u.row.projeto; });
  });
  const notaProjectById = {};
  Object.keys(existingNotasObj).forEach(function (id) { notaProjectById[id] = resolveNotaProject_(existingNotasObj[id], entryIdx); });
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

// Drive folder IDs for the two projects that existed before folder lookup was
// name-based (kept only so their existing folders keep being found by ID —
// not required for any project created or renamed since).
const PROJECT_FOLDERS = {
  'Obra Gavião': '1NZ-JdKm7_dATmYDPDgEDJMGJLoXGv6Uu',
  'Obra Boreal': '1WPZnzIzDeBc2x57OArVInOACDIzgUh8F',
};
const FALLBACK_FOLDER_ID = '1BN2no3X5zHks6F94X6elC7j1kMROH7yT'; // "Construtora Moreira" parent

// Resolves a project's Drive folder BY NAME rather than relying only on the
// hardcoded map above — a project added or renamed through the app's own
// Settings screen has no entry there, and previously fell through to the
// shared FALLBACK_FOLDER_ID silently, forever. findProjectFolder_ looks for
// an existing same-named subfolder under the parent; resolveOrCreateProjectFolder_
// (used by uploadFile) creates one on first use if none exists yet.
function findProjectFolder_(projectName) {
  if (!projectName) return null;
  if (PROJECT_FOLDERS[projectName]) return DriveApp.getFolderById(PROJECT_FOLDERS[projectName]);
  const parent = DriveApp.getFolderById(FALLBACK_FOLDER_ID);
  const existing = parent.getFoldersByName(projectName);
  return existing.hasNext() ? existing.next() : null;
}
function resolveOrCreateProjectFolder_(projectName) {
  if (!projectName) return DriveApp.getFolderById(FALLBACK_FOLDER_ID);
  const found = findProjectFolder_(projectName);
  if (found) return found;
  return DriveApp.getFolderById(FALLBACK_FOLDER_ID).createFolder(projectName);
}

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
// adding a new project working without that blast radius. Renaming an
// EXISTING project no longer goes through this path at all — see
// renameProject_ below.
function saveProjetos_(user, rows) {
  if (user.projects === '*') {
    writeSheet_('projetos', rows);
    return;
  }
  const existing = readSheet_('projetos');
  const outOfScope = existing.filter(p => !hasProjectAccess_(user, p.id));
  writeSheet_('projetos', outOfScope.concat(rows || []));
}

// Renames a project as ONE atomic, bulk operation — a fixed handful of
// Sheets service calls regardless of how many rows reference the project —
// instead of the frontend rewriting every referencing row's `projeto` field
// and routing that as a batchMulti of potentially thousands of individual
// upserts. That old path went through assertBatchAccess_/findConflicts_/
// applyBatch_ once PER ROW: for a project with real history it could exceed
// Apps Script's execution time limit and fail with some rows renamed and
// others not, orphaning them (see CLAUDE.md — this is the fix for that).
// Runs inside doPost's existing script lock, same as every other write.
function renameProject_(oldName, newName) {
  oldName = String(oldName || '').trim();
  newName = String(newName || '').trim();
  if (!oldName || !newName) throw new Error('nome de projeto inválido');
  if (oldName === newName) return;

  const existingProjects = readSheet_('projetos');
  const collision = existingProjects.some(function (p) {
    return p.id !== oldName && String(p.id).toLowerCase() === newName.toLowerCase();
  });
  if (collision) throw new Error('já existe um projeto com esse nome');

  const projetosSheet = ss_().getSheetByName(SHEETS.projetos.name);
  if (!projetosSheet) throw new Error('Aba não encontrada: ' + SHEETS.projetos.name);
  const rowIdx = findRowIndexById_(projetosSheet, oldName);
  if (rowIdx === -1) throw new Error('projeto não encontrado');
  projetosSheet.getRange(rowIdx, 1).setValue(sanitizeCell_(newName));

  ['caixaObra', 'empreiteiro', 'tarefas', 'documentos', 'notas'].forEach(function (key) {
    renameProjectColumnBulk_(key, oldName, newName);
  });

  // Best-effort cosmetic rename of the Drive folder too, so it keeps matching
  // the project by name (see findProjectFolder_/resolveOrCreateProjectFolder_
  // above) — Drive is never the source of truth for the project name, so a
  // failure here must not fail (or partially undo) the rename itself.
  try {
    const folder = findProjectFolder_(oldName);
    if (folder) folder.setName(newName);
  } catch (e) { /* cosmetic only */ }
}

// One column read + (at most) one column write per sheet, regardless of row
// count — the whole point of doing this in bulk instead of per row.
function renameProjectColumnBulk_(sheetKey, oldName, newName) {
  const cfg = SHEETS[sheetKey];
  const sheet = ss_().getSheetByName(cfg.name);
  if (!sheet) return;
  const col = cfg.cols.indexOf('projeto') + 1;
  if (col < 1) return;
  const lastRow = sheet.getLastRow();
  if (lastRow < 2) return;
  const range = sheet.getRange(2, col, lastRow - 1, 1);
  const values = range.getValues();
  let changed = false;
  for (let i = 0; i < values.length; i++) {
    if (values[i][0] === oldName) { values[i][0] = sanitizeCell_(newName); changed = true; }
  }
  if (changed) range.setValues(values);
}

function doPost(e) {
  let body;
  try {
    body = JSON.parse(e.postData.contents);
  } catch (err) {
    return jsonOut_({ error: 'JSON inválido' });
  }

  try {
    const user = getCurrentUser_(body.idToken); // AUTH: identity only
    user.sections = sectionsForRole_(user.role); // AUTHZ: effective permissions, resolved fresh every request
    const action = body.action;

    // Pure read — no lock needed, same as this used to behave under doGet.
    if (action === 'getAll') {
      const out = { currentUser: user };
      Object.keys(SHEETS).forEach(key => { out[key] = readSheet_(key); });
      return jsonOut_(filterAllByAccess_(user, out));
    }

    const lock = LockService.getScriptLock();
    try {
      lock.waitLock(15000);
    } catch (err) {
      return jsonOut_({ error: 'Servidor ocupado, tente novamente.' });
    }
    try {
      if (action === 'batchMulti') {
        const ops = body.ops || [];
        assertBatchAccess_(user, ops); // rejects the WHOLE batch if any op is outside the user's section/action or project access
        const conflicts = findConflicts_(ops);
        if (conflicts.length > 0) {
          return jsonOut_({ conflict: true, conflicts: conflicts });
        }
        const updated = applyBatch_(ops);
        return jsonOut_({ ok: true, updated: updated });
      }

      // Legacy whole-tab save — still used for Projetos/Tipos/Unidades, gated
      // by the 'config' section's edit action. Tipos/Unidades are small
      // shared reference lists (no further authorization needed beyond that);
      // Projetos IS access-scoped, see saveProjetos_.
      if (action === 'saveSheet') {
        if (!can_(user, 'config', 'edit')) throw new Error('sem permissão para editar');
        if (body.sheet === 'projetos') {
          saveProjetos_(user, body.rows);
        } else {
          writeSheet_(body.sheet, body.rows);
        }
        return jsonOut_({ ok: true });
      }

      // Renaming an EXISTING project — see renameProject_ for why this is a
      // dedicated bulk action rather than a batchMulti of every referencing
      // row's `projeto` field.
      if (action === 'renameProject') {
        if (!can_(user, 'config', 'edit')) throw new Error('sem permissão para editar');
        renameProject_(body.oldName, body.newName);
        return jsonOut_({ ok: true });
      }

      if (action === 'uploadFile') {
        // uploadFile alone can't leak anything — the file it creates isn't
        // visible anywhere in the app until a subsequent batchMulti attaches
        // it to a Fotos/Documentos row, and THAT step independently resolves
        // its real section from the row's own refTipo (see assertBatchAccess_
        // above), never trusting what the client claims. So body.section here
        // is only a client-declared hint for which upload-permission bucket
        // to check — cheap enough to keep a denied role from writing to Drive
        // at all, but the attach step is what actually enforces the true
        // section either way.
        const uploadSection = String(body.section || '').toLowerCase().trim();
        if (!can_(user, uploadSection, 'upload')) throw new Error('sem permissão para enviar arquivos');
        if (!hasProjectAccess_(user, body.projeto)) throw new Error('sem acesso a este projeto');
        const folder = resolveOrCreateProjectFolder_(body.projeto);
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
        // can access, not just this app's own. Both the section and the
        // project are fully server-resolved from the row itself — nothing
        // here trusts the client — same two independent axes (section/action,
        // then project) every other write path checks.
        const fotoRow = readSheet_('fotos').find(f => f.driveFileId === body.fileId);
        const docRow = !fotoRow && readSheet_('documentos').find(d => d.driveFileId === body.fileId);
        if (!fotoRow && !docRow) throw new Error('arquivo não encontrado');
        let section, project;
        if (fotoRow) {
          const entryIdx = buildEntryProjectIndex_(readSheet_('caixaObra'), readSheet_('empreiteiro'), readSheet_('tarefas'));
          const notaSectionById = {};
          const notaProjectById = {};
          readSheet_('notas').forEach(function (n) {
            notaSectionById[n.id] = resolveNotaSection_(n);
            notaProjectById[n.id] = resolveNotaProject_(n, entryIdx);
          });
          section = resolveFotoSection_(fotoRow, notaSectionById);
          project = resolveFotoProject_(fotoRow, entryIdx, notaProjectById);
        } else {
          section = 'docs';
          project = docRow.projeto;
        }
        if (!section || !can_(user, section, 'delete')) throw new Error('sem permissão para excluir arquivos');
        if (!hasProjectAccess_(user, project)) throw new Error('sem acesso a este projeto');
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

// ------------------------------------------------------------
// One-time setup: creates the "Papeis" tab (role/section/action permission
// matrix, see the AUTHORIZATION BLOCK above) in the Usuarios spreadsheet if
// it doesn't exist yet, and seeds it with the same effective permissions the
// app used to have hardcoded. Run ONCE manually from this editor (select
// installPapeisSheet in the function dropdown, click Run) — same pattern as
// installDailyBackupTrigger. Safe to re-run: it only seeds rows when the tab
// is completely empty, never overwrites rows you've already edited by hand.
//
// The seed below deliberately writes EVERY (role, section) combination this
// app knows about, including the denied ones, spelled out as explicit NAO —
// never a blank cell. This is a human-readability choice, not a security
// one: the sheet being complete makes "what can Partner do" answerable by
// reading one screen, without hunting for an absent row. It changes nothing
// about how the backend actually decides access — buildPermissionMatrixFromSheet_
// / sectionsForRole_ / can_ already treat a missing row, a blank cell, an
// unrecognized role, and a missing Papeis tab entirely as equally denied
// (see the AUTHORIZATION BLOCK above). Do NOT "simplify" that code to rely
// on this sheet always being complete — absence must keep meaning denied,
// on its own, with no assumption that every combination is listed.
// ------------------------------------------------------------
function installPapeisSheet() {
  const ss = SpreadsheetApp.openById(AUTH_SHEET_ID);
  let sheet = ss.getSheetByName('Papeis');
  if (!sheet) sheet = ss.insertSheet('Papeis');

  const header = ['role', 'section', 'view', 'create', 'edit', 'delete', 'upload', 'export'];
  if (sheet.getLastRow() >= 1) return; // already has content (header and/or rows) — don't touch it

  const seed = [
    header,
    ['admin', 'painel', 'SIM', 'NAO', 'NAO', 'NAO', 'NAO', 'NAO'],
    ['admin', 'painel.tarefas', 'SIM', 'NAO', 'NAO', 'NAO', 'NAO', 'NAO'],
    ['admin', 'lancamentos', 'SIM', 'SIM', 'SIM', 'SIM', 'SIM', 'SIM'],
    ['admin', 'tarefas', 'SIM', 'SIM', 'SIM', 'SIM', 'SIM', 'NAO'],
    ['admin', 'notas', 'SIM', 'SIM', 'SIM', 'SIM', 'SIM', 'NAO'],
    ['admin', 'docs', 'SIM', 'SIM', 'SIM', 'SIM', 'SIM', 'SIM'],
    ['admin', 'config', 'SIM', 'SIM', 'SIM', 'SIM', 'NAO', 'NAO'],
    ['admin', 'usuarios', 'SIM', 'SIM', 'SIM', 'SIM', 'NAO', 'NAO'],
    ['owner', 'painel', 'SIM', 'NAO', 'NAO', 'NAO', 'NAO', 'NAO'],
    ['owner', 'painel.tarefas', 'SIM', 'NAO', 'NAO', 'NAO', 'NAO', 'NAO'],
    ['owner', 'lancamentos', 'SIM', 'SIM', 'SIM', 'SIM', 'SIM', 'SIM'],
    ['owner', 'tarefas', 'SIM', 'SIM', 'SIM', 'SIM', 'SIM', 'NAO'],
    ['owner', 'notas', 'SIM', 'SIM', 'SIM', 'SIM', 'SIM', 'NAO'],
    ['owner', 'docs', 'SIM', 'SIM', 'SIM', 'SIM', 'SIM', 'SIM'],
    ['owner', 'config', 'SIM', 'SIM', 'SIM', 'SIM', 'NAO', 'NAO'],
    ['owner', 'usuarios', 'NAO', 'NAO', 'NAO', 'NAO', 'NAO', 'NAO'], // cannot manage users, same as the old manageUsers:false
    ['partner', 'painel', 'SIM', 'NAO', 'NAO', 'NAO', 'NAO', 'NAO'],
    ['partner', 'painel.tarefas', 'NAO', 'NAO', 'NAO', 'NAO', 'NAO', 'NAO'],
    ['partner', 'lancamentos', 'SIM', 'NAO', 'NAO', 'NAO', 'NAO', 'NAO'],
    ['partner', 'tarefas', 'NAO', 'NAO', 'NAO', 'NAO', 'NAO', 'NAO'],
    ['partner', 'notas', 'NAO', 'NAO', 'NAO', 'NAO', 'NAO', 'NAO'],
    ['partner', 'docs', 'SIM', 'NAO', 'NAO', 'NAO', 'NAO', 'NAO'],
    ['partner', 'config', 'NAO', 'NAO', 'NAO', 'NAO', 'NAO', 'NAO'],
    ['partner', 'usuarios', 'NAO', 'NAO', 'NAO', 'NAO', 'NAO', 'NAO'],
  ];
  sheet.getRange(1, 1, seed.length, header.length).setValues(seed);
  sheet.setFrozenRows(1);
}

// Run manually after hand-editing the Papeis tab if you don't want to wait
// out the (short, ~5 min) cache TTL for the change to take effect everywhere.
function flushPermissionCache() {
  CacheService.getScriptCache().remove(PERMISSION_CACHE_KEY);
}
