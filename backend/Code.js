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
// "This token is invalid" and "I could not check the token right now" are
// completely different answers, and collapsing them signs people out for no
// reason. Google's tokeninfo endpoint is rate-limited, and this app calls it
// on EVERY request — so a large photo batch (three concurrent uploads plus
// their row writes) can easily earn a 429. Treating that as a dead session
// cleared the token and threw the user back to the sign-in screen mid-batch,
// abandoning every upload still in flight.
//
// Only a verdict from Google that the token itself is bad (400/401) is an
// auth failure. Anything else — 429, 5xx, a network wobble — is a transient
// server condition the client should retry, exactly like a busy lock.
function verifyIdToken_(idToken) {
  if (!idToken) throw new Error('não autenticado');
  let resp;
  try {
    resp = UrlFetchApp.fetch(
      'https://oauth2.googleapis.com/tokeninfo?id_token=' + encodeURIComponent(idToken),
      { muteHttpExceptions: true }
    );
  } catch (e) {
    throw new Error('Servidor ocupado, tente novamente.');
  }
  const code = resp.getResponseCode();
  if (code !== 200) {
    if (code === 400 || code === 401) throw new Error('não autenticado');
    throw new Error('Servidor ocupado, tente novamente.');
  }
  let info;
  try {
    info = JSON.parse(resp.getContentText());
  } catch (e) {
    throw new Error('Servidor ocupado, tente novamente.');
  }
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
// — they exist purely to gate WRITE actions (editing Projetos/Tipos/Unidades/
// Socios; a future user-management screen), not to hide a nav tab. 'painel.tarefas'
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
  config: ['projetos', 'tipos', 'unidades', 'socios'],
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
// 'view' on them. 'config'/'usuarios' are excluded on purpose: Tipos/Unidades/
// Socios are shared reference data (never section-gated, see writeSheet_ comments)
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
  if (foto.refTipo === 'projeto') return foto.refId; // photo added directly to a project — refId IS the project name
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
  if (foto.refTipo === 'projeto') return 'docs'; // photo added directly to a project, governed the same as Documentos
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

  // Deciding create-vs-edit only needs to know whether an id already exists,
  // which is one narrow column — not every column of every row. Reading just
  // column A here instead of the whole sheet is the difference between
  // shipping ~12 columns × N rows and 1 × N to answer a yes/no question, on
  // the hot path of every single write. Sheets that genuinely need full rows
  // (notas/fotos section resolution, and the project-scope pass below) still
  // go through existingRows_ and are unaffected.
  const idSetCache = {};
  function existingIdSet_(sheetKey) {
    if (idCache[sheetKey]) return null; // full rows already loaded for this sheet — just use them
    if (!idSetCache[sheetKey]) idSetCache[sheetKey] = readIdSet_(sheetKey);
    return idSetCache[sheetKey];
  }
  function idExists_(sheetKey, id) {
    const set = existingIdSet_(sheetKey);
    if (set) return !!set[String(id)];
    return !!existingRows_(sheetKey)[id];
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
    (op.upserts || []).forEach(function (u) {
      const section = sectionForOp_(op.sheet, u.id, u.row);
      if (!section) throw new Error('sem acesso a esta seção'); // unknown sheet, or a row that resolves to no known parent — fail closed
      // Still resolved from the sheet's OWN current state, never from
      // anything the client claims — only the read backing it is narrower.
      const action = idExists_(op.sheet, u.id) ? 'edit' : 'create';
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
// ------------------------------------------------------------
// Usuarios.projetos is a foreign key by NAME (see the Usuarios tab schema) —
// it stores exact project names as text, in a DIFFERENT spreadsheet from the
// business data. Nothing kept it in step with a project rename or delete, so
// renaming a project silently revoked every scoped user's access to it: their
// getAll went to zero projects and zero rows, with no error anywhere and no
// way for a non-technical user to understand or fix it.
//
// Both helpers are exact-match, same as hasProjectAccess_'s own indexOf — a
// looser (case-insensitive) match here would grant or revoke access the real
// check would not agree with. '*' is never touched: it means "all projects",
// not a list containing this one.
// ------------------------------------------------------------
function rewriteUsuariosProjects_(mapFn) {
  const sheet = authSheet_();
  const lastRow = sheet.getLastRow();
  if (lastRow < 2) return 0;
  const col = 4; // email,nome,role,projetos,ativo,criadoEm
  const range = sheet.getRange(2, col, lastRow - 1, 1);
  const values = range.getValues();
  let changed = false;
  for (let i = 0; i < values.length; i++) {
    const raw = String(values[i][0] || '').trim();
    if (!raw || raw === '*') continue;
    const list = raw.split(',').map(function (x) { return x.trim(); }).filter(Boolean);
    const next = mapFn(list);
    const joined = next.join(', ');
    if (joined !== raw) { values[i][0] = joined; changed = true; }
  }
  if (changed) range.setValues(values);
  return changed ? 1 : 0;
}

function renameProjectInUsuarios_(oldName, newName) {
  return rewriteUsuariosProjects_(function (list) {
    const out = [];
    list.forEach(function (name) {
      const mapped = (name === oldName) ? newName : name;
      if (out.indexOf(mapped) === -1) out.push(mapped); // never duplicate if they already had both
    });
    return out;
  });
}

function removeProjectFromUsuarios_(name) {
  return rewriteUsuariosProjects_(function (list) {
    return list.filter(function (p) { return p !== name; });
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
// Hard ceiling on a single upload, enforced on the DECODED bytes. Photos are
// compressed client-side to ~100-200KB, and documents are capped at 15MB in
// the picker, so this only ever catches something abnormal.
const MAX_UPLOAD_BYTES = 25 * 1024 * 1024;

// Resolves a project's Drive folder BY NAME — the FALLBACK path, used only
// when a project has no stored driveFolderId yet (never touched by
// resolveOrCreateProjectFolder_ below) or when a caller explicitly wants the
// name-based lookup regardless of the sheet (renameProject_'s pre-ID-era
// callers). PROJECT_FOLDERS is the same legacy map as before — those two
// projects are just pre-seeded name lookups, not exempt from anything.
// getFoldersByName only ever returns the FIRST match if there happen to be
// duplicates; see auditProjectFolders() for surfacing that ambiguity instead
// of silently picking one.
function findProjectFolder_(projectName) {
  if (!projectName) return null;
  if (PROJECT_FOLDERS[projectName]) {
    // A hardcoded legacy seed, not the backend-owned canonical id — so if it
    // no longer resolves, falling through to the name search below is the
    // right move, not an error. (This is NOT the stale-canonical case that
    // lookupProjectFolder_ deliberately refuses to name-guess around: this map
    // is only ever consulted on the 'unset' path, for a project that has never
    // had a driveFolderId persisted.) Without this it threw a raw Drive error
    // straight out of every upload for those two projects.
    try { return DriveApp.getFolderById(PROJECT_FOLDERS[projectName]); }
    catch (e) { /* seed id no longer valid — fall through to the name search */ }
  }
  const parent = DriveApp.getFolderById(FALLBACK_FOLDER_ID);
  const existing = parent.getFoldersByName(projectName);
  return existing.hasNext() ? existing.next() : null;
}

// Column index computed lazily (not at module top-level, which runs before
// SHEETS below is defined) — cheap, and cols never changes at runtime.
function projetosFolderIdCol_() {
  return SHEETS.projetos.cols.indexOf('driveFolderId') + 1;
}
// Single-cell, single-row write — never writeSheet_, which would read-modify-
// write the WHOLE tab and race a concurrent add/rename of a different
// project. Silently a no-op if the row is gone (project deleted between the
// lookup and this write) or the column is somehow missing.
function persistProjectFolderId_(projectName, folderId) {
  const sheet = ss_().getSheetByName(SHEETS.projetos.name);
  const col = projetosFolderIdCol_();
  if (!sheet || col < 1) return;
  const rowIdx = findRowIndexById_(sheet, projectName);
  if (rowIdx === -1) return;
  sheet.getRange(rowIdx, col).setValue(folderId);
}

// THE canonical resolver — ID-first, so a folder renamed directly in Drive
// (by a person, outside the app) has ZERO effect on finding it again: the id
// doesn't care what the folder is currently called. Falls back to the old
// name-based lookup only for a project that has never had its folder
// resolved through this function before (driveFolderId still blank), and
// self-heals by persisting whatever it finds/creates — so there is no
// separate migration step; the existing fleet of projects backfills itself
// the next time anything touches their folder (an upload, a rename, a
// delete). A stored id that no longer resolves (folder trashed/deleted
// directly in Drive) is deliberately NOT treated as "unresolved and eligible
// for a fresh name-based guess" — that would silently create a second,
// unrelated folder under a name that might now belong to something else.
// It surfaces as a null folder to the caller, same as "never had one".
//
// Returns an explicit STATE, not just a folder-or-null, because the two ways
// of "not getting a folder back" demand opposite handling and collapsing them
// is what let a name guess sneak back in:
//   'unset'    — no driveFolderId stored yet. A name lookup IS legitimate here
//                (that is the self-healing backfill for pre-ID-era projects).
//   'stale'    — an id IS stored but no longer resolves. A name lookup here
//                could silently attach to an unrelated folder that happens to
//                now hold the project's name, so it is NEVER attempted; the
//                caller must surface this rather than guess.
//   'trashed'  — the id resolves but the folder is in the Drive trash.
//                getFolderById happily returns a trashed folder, so without
//                this check an upload would land inside a trash tree and be
//                purged after 30 days while its Fotos row still pointed at it.
//   'resolved' — the canonical folder, live and usable.
// Callers that previously wrote `resolveProjectFolderById_(x) || findProjectFolder_(x)`
// must go through this instead: that `||` was exactly the name fallback the
// stale case exists to prevent.
const PROJECT_FOLDER_UNSET = 'unset';
const PROJECT_FOLDER_STALE = 'stale';
const PROJECT_FOLDER_TRASHED = 'trashed';
const PROJECT_FOLDER_RESOLVED = 'resolved';

function lookupProjectFolder_(projectName, projetosRows) {
  if (!projectName) return { state: PROJECT_FOLDER_UNSET, folder: null, storedId: '' };
  const rows = projetosRows || readSheet_('projetos');
  const row = rows.find(function (p) { return p.id === projectName; });
  const storedId = (row && row.driveFolderId) || '';
  if (!storedId) return { state: PROJECT_FOLDER_UNSET, folder: null, storedId: '' };
  let folder;
  try {
    folder = DriveApp.getFolderById(storedId);
  } catch (e) {
    return { state: PROJECT_FOLDER_STALE, folder: null, storedId: storedId };
  }
  let trashed = false;
  try { trashed = !!folder.isTrashed(); } catch (e) { /* older Drive shim — treat as live */ }
  if (trashed) return { state: PROJECT_FOLDER_TRASHED, folder: folder, storedId: storedId };
  return { state: PROJECT_FOLDER_RESOLVED, folder: folder, storedId: storedId };
}

// Resolves a project's folder for a READ-ONLY caller (the sweeper, the merge
// repair, the audit report) without ever creating or persisting anything.
// Honours the same stale/trashed rule as lookupProjectFolder_, and only falls
// back to a name search for a project that has genuinely never been backfilled.
function resolveExistingProjectFolder_(projectName, projetosRows) {
  const found = lookupProjectFolder_(projectName, projetosRows);
  if (found.state === PROJECT_FOLDER_UNSET) {
    let byName = null;
    try { byName = findProjectFolder_(projectName); } catch (e) { byName = null; }
    return byName
      ? { state: PROJECT_FOLDER_RESOLVED, folder: byName, storedId: '', viaName: true }
      : { state: PROJECT_FOLDER_UNSET, folder: null, storedId: '' };
  }
  return found;
}
// Same check-then-create race as resolveOrCreateSubfolderLocked_ below, one
// level up: the first upload ever made to a brand-new project (one without a
// stored driveFolderId yet) could race two concurrent uploadFile calls into
// creating two same-named project folders. Locked for the same reason and the
// same way — only the cheap lookup-or-create-or-backfill, never the upload.
// Thrown (rather than silently working around) when a project's canonical
// folder id is stored but unusable. Deliberately NOT phrased as a permission
// or auth error, so the frontend treats it as an ordinary retryable failure
// and shows it per-file instead of signing anyone out.
const DRIVE_FOLDER_UNAVAILABLE = 'pasta do projeto indisponível no Drive';

function resolveOrCreateProjectFolder_(projectName) {
  if (!projectName) return DriveApp.getFolderById(FALLBACK_FOLDER_ID);
  const byId = lookupProjectFolder_(projectName);
  if (byId.state === PROJECT_FOLDER_RESOLVED) return byId.folder;
  // A stored id that is gone or in the trash is a real problem to report, not
  // one to route around: guessing by name could attach every future upload to
  // an unrelated folder AND overwrite the canonical id with that guess, and
  // uploading into a trashed folder loses the files 30 days later.
  if (byId.state !== PROJECT_FOLDER_UNSET) throw new Error(DRIVE_FOLDER_UNAVAILABLE);
  const lock = LockService.getScriptLock();
  try {
    lock.waitLock(15000);
  } catch (e) { /* losing this race is fine — re-check below finds the winner's folder */ }
  try {
    // Re-check by id first (another request may have just backfilled it
    // while we waited for the lock), THEN fall back to name/create — all
    // still under the lock, so the eventual persistProjectFolderId_ below
    // can't race a concurrent resolution for the same project.
    const recheckById = lookupProjectFolder_(projectName);
    if (recheckById.state === PROJECT_FOLDER_RESOLVED) return recheckById.folder;
    if (recheckById.state !== PROJECT_FOLDER_UNSET) throw new Error(DRIVE_FOLDER_UNAVAILABLE);
    let folder = findProjectFolder_(projectName);
    if (!folder) folder = DriveApp.getFolderById(FALLBACK_FOLDER_ID).createFolder(projectName);
    persistProjectFolderId_(projectName, folder.getId());
    return folder;
  } finally {
    lock.releaseLock();
  }
}

// Every project folder gets its own Fotos/Documentos subfolders on first
// use, rather than dumping every upload straight into the project root.
// Routed on an explicit "kind" the client sends (see uploadFile below) —
// never inferred from "section" (a photo and a document can share the same
// section, e.g. both 'docs') or from mimeType (a scanned receipt uploaded as
// a "document" is legitimately an image). Existing files are never moved:
// every reference in the app is by driveFileId, so where a file physically
// sits has no effect on behavior — this only changes where NEW uploads land.
//
// Check-then-create, so it MUST be serialized even though uploadFile itself
// runs outside the script lock (see the comment on that action). Without a
// lock here, the first batch of uploads to a brand-new project's Fotos/
// folder raced: multiple concurrent workers each saw "no Fotos folder yet"
// and each created their own — Drive allows several folders with the same
// name in one parent, so nothing stopped it. Reproduced live: a project
// ended up with 3 separate "Fotos" folders after one 61-photo batch, with
// uploads scattered across all three. The lock is held only for this cheap
// lookup-or-create, never for the upload itself, so it doesn't reintroduce
// the throughput problem moving uploadFile out of the lock was fixing.
function resolveOrCreateSubfolderLocked_(parentFolder, name) {
  const lock = LockService.getScriptLock();
  try {
    lock.waitLock(15000);
  } catch (e) {
    // Someone else is creating a folder right now — losing this race is fine,
    // the retry below will find what they made.
  }
  try {
    return resolveOrCreateSubfolder_(parentFolder, name);
  } finally {
    lock.releaseLock();
  }
}
function resolveOrCreateSubfolder_(parentFolder, name) {
  const existing = parentFolder.getFoldersByName(name);
  if (existing.hasNext()) return existing.next();
  return parentFolder.createFolder(name);
}

// Which sheet tabs are exposed, and their column order (must match the header
// row exactly). Tabs with "rowLevel:true" support the new upsert/delete/conflict
// flow and need a trailing "lastModified" column; the other three (small
// reference lists, rarely edited concurrently) still use simple whole-tab saves.
const SHEETS = {
  // driveFolderId is BACKEND-OWNED: the canonical id of this project's Drive
  // folder, so folder resolution never depends on the folder's current NAME
  // (which a person can change in Drive at any time, silently breaking a
  // name lookup). It is resolved lazily and self-heals — see
  // resolveOrCreateProjectFolder_ — and is deliberately never sent by, or
  // accepted from, the client: the frontend's whole-tab Projetos save has no
  // concept of it and must not be able to blank it (see saveProjetos_).
  // 'socios' is the project <-> socio ASSIGNMENT: a comma-separated list of
  // socio names, exactly the same shape (and the same "foreign key by name")
  // convention Usuarios.projetos already uses on the auth spreadsheet. Unlike
  // driveFolderId this one IS client-owned — the frontend's projects array
  // carries it and toSheetRows('projects', ...) sends it — so a whole-tab
  // Projetos save round-trips it normally. It is CURRENT CONFIGURATION only:
  // it decides which socios a project OFFERS when creating a lancamento, and
  // never touches the `socio` already recorded on an existing CaixaObra /
  // Empreiteiro row (see normalizeSociosCell_ / ensureSociosSchema_).
  projetos:    { name: 'Projetos',    cols: ['id', 'ativo', 'driveFolderId', 'socios'] },
  caixaObra:   { name: 'CaixaObra',   cols: ['id','projeto','data','nome','tipo','qtd','unidade','valor','fornecedor','socio','criadoEm','lastModified'], rowLevel: true },
  empreiteiro: { name: 'Empreiteiro', cols: ['id','projeto','data','nome','qtd','unidade','valor','fornecedor','socio','criadoEm','lastModified'], rowLevel: true },
  tarefas:     { name: 'Tarefas',     cols: ['id','projeto','texto','prazo','prioridade','feito','criadoEm','lastModified'], rowLevel: true },
  notas:       { name: 'Notas',       cols: ['id','projeto','texto','criadoEm','refTipo','refId','lastModified'], rowLevel: true },
  fotos:       { name: 'Fotos',       cols: ['id','refTipo','refId','driveFileId','driveUrl','criadoEm','lastModified'], rowLevel: true },
  documentos:  { name: 'Documentos',  cols: ['id','projeto','nome','mimeType','driveFileId','driveUrl','criadoEm','lastModified'], rowLevel: true },
  tipos:       { name: 'Tipos',       cols: ['tipo'] },
  unidades:    { name: 'Unidades',    cols: ['unidade'] },
  // The master list of socios — a small shared reference list, exactly like
  // Tipos/Unidades: single column, whole-tab replace, no conflict tracking.
  // Assigning a socio to a project never adds a row here (that is Projetos.
  // socios), and unassigning never removes one — the two are deliberately
  // independent, so removing someone from a project can't delete the socio.
  socios:      { name: 'Socios',      cols: ['socio'] },
};

// The two socios this app offered as hardcoded buttons before project-level
// assignment existed. Seeded into the Socios tab on first run so the master
// list starts out matching what the app has always actually allowed, rather
// than empty. DEFAULT_PROJECT_SOCIO is the one automatically assigned to a
// newly created project (and to a pre-existing project whose history carries
// no socio at all) — see ensureSociosSchema_.
const LEGACY_SOCIOS = ['Pedro', 'Dalmir'];
const DEFAULT_PROJECT_SOCIO = 'Dalmir';

function ss_() { return SpreadsheetApp.getActiveSpreadsheet(); }

function uid_(prefix) {
  return prefix + '_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8);
}

function fmtDate_(val) {
  if (val instanceof Date) {
    // Deliberately the SPREADSHEET's timezone, not Session.getScriptTimeZone()
    // (the script project's own timeZone in appsscript.json). Sheets builds a
    // date-only cell's Date object in the spreadsheet's own timezone — if the
    // script's timezone ever disagrees with it (they are two independent
    // settings, easy to let drift apart), every date silently shifts by a
    // day. Reading it from the spreadsheet itself makes the two settings
    // agreeing a non-issue rather than a requirement to remember.
    return Utilities.formatDate(val, ss_().getSpreadsheetTimeZone(), 'yyyy-MM-dd');
  }
  return val || '';
}

// A criadoEm/lastModified cell should always hold a plain millisecond
// timestamp (Date.now()), never a calendar date — but Sheets can still
// silently reinterpret ANY numeric cell as a Date if that column ever
// inherits a date/time number format (manual reformatting, or Sheets'
// fill-pattern extending a format from a neighboring column). If that
// happens, getValues() hands back a Date object instead of the raw number,
// and left alone it serializes to an ISO string over JSON — breaking
// arithmetic sort order (`a.criadoEm - b.criadoEm` → NaN) and, for
// lastModified specifically, permanently spurious conflict errors from
// buildRowIndexes_'s String(current) !== String(expected) check, since a
// Date's default String() ("Mon Sep 01 2026 ...") can never equal the
// client's numeric baseline. Coercing via getTime() is safe unconditionally
// — a legitimate numeric cell is never `instanceof Date`, so this only ever
// fires on the corrupted case. Same defensive shape as fmtDate_ above, just
// for a field that must stay a number, never become a 'yyyy-MM-dd' string.
function coerceTimestamp_(v) {
  return v instanceof Date ? v.getTime() : v;
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

  const rows = values.map((row) => {
    const obj = {};
    cfg.cols.forEach((col, c) => {
      let v = row[c];
      // 'prazo' (Tarefas' deadline) is exactly as date-shaped as 'data' —
      // same fmtDate_ treatment, for the same reason: a plain 'yyyy-MM-dd'
      // string written into a cell with no explicit text format gets
      // silently reinterpreted by Sheets as a real date, and without this
      // it would come back as a raw Date object → a full ISO timestamp over
      // JSON → an Invalid Date the moment the frontend's parseDateLocal()
      // (which expects exactly 3 '-'-separated parts) tries to parse it.
      if (col === 'data' || col === 'prazo') v = fmtDate_(v);
      if (col === 'criadoEm' || col === 'lastModified') v = coerceTimestamp_(v) || Date.now();
      if (col === 'feito' || col === 'ativo') v = (v === true || String(v).toUpperCase() === 'SIM' || String(v).toUpperCase() === 'TRUE');
      obj[col] = v;
    });
    // A blank id only happens for a row typed directly into the sheet by
    // hand. Give it one for THIS response so the row is usable, but do not
    // persist it here — backfillMissingIds_ (under the lock, at the top of
    // getAll) is the single place that writes ids back. This used to
    // setValues() the entire range, every column of every row, which is a
    // read-modify-write over data a concurrent batchMulti may have changed
    // in the meantime: a row deleted between this getValues() and that
    // setValues() would be resurrected by the stale write-back. That was
    // survivable only while the whole getAll sat inside the write lock;
    // now that it deliberately doesn't, the write-back has to go. Worst
    // case a hand-typed row carries an ephemeral id for one response and
    // gets its stable one on the next getAll.
    if (hasId && !obj.id) obj.id = uid_(key);
    return obj;
  });

  return rows;
}

// Companion to readSheet_'s own backfill logic above, but touching ONLY the
// id column instead of the whole sheet — called once per sheet at the top
// of the 'getAll' action, inside a short-lived lock, specifically so that by
// the time readSheet_ itself runs (lock-free) there is nothing left for it
// to write. A blank id is rare (only from a row typed directly into the
// sheet by hand), so this pays its own small cost only on that rare case.
function backfillMissingIds_(key) {
  const cfg = SHEETS[key];
  if (cfg.cols[0] !== 'id') return;
  const sheet = ss_().getSheetByName(cfg.name);
  if (!sheet) return;
  const lastRow = sheet.getLastRow();
  if (lastRow < 2) return;
  const idRange = sheet.getRange(2, 1, lastRow - 1, 1);
  const ids = idRange.getValues();
  let changed = false;
  for (let i = 0; i < ids.length; i++) {
    if (!ids[i][0]) { ids[i][0] = uid_(key); changed = true; }
  }
  if (changed) idRange.setValues(ids);
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
  const existingRows = Math.max(0, lastRow - 1);

  // A whole-tab replace rewrites rows POSITIONALLY, but only across the
  // schema's own columns — so any column a person added by hand to the right
  // of the schema kept its original row position while the data above it
  // shifted up, silently re-attaching every manual note to the wrong record.
  // That was harmless while this only ever touched Projetos/Tipos/Unidades,
  // and became a live data-corruption path the moment deleteProject_ started
  // using it on CaixaObra/Empreiteiro/Tarefas/Notas/Fotos/Documentos.
  //
  // So carry those extra cells along WITH their row, keyed by column A (the
  // id for every id-bearing sheet; the value itself for the single-column
  // reference lists). A row that is genuinely new simply gets blanks.
  const schemaWidth = cfg.cols.length;
  const sheetWidth = Math.max(schemaWidth, sheet.getLastColumn());
  const extraWidth = sheetWidth - schemaWidth;
  const extraByKey = {};
  if (extraWidth > 0 && existingRows > 0) {
    const current = sheet.getRange(2, 1, existingRows, sheetWidth).getValues();
    current.forEach(function (row) {
      const k = String(row[0]);
      if (k !== '') extraByKey[k] = row.slice(schemaWidth);
    });
  }
  const blankExtra = [];
  for (let i = 0; i < extraWidth; i++) blankExtra.push('');

  const values = (rows || []).map(r => {
    const base = cfg.cols.map(c => {
      const v = r[c];
      if (v === undefined || v === null) return '';
      if (typeof v === 'boolean') return v ? 'SIM' : 'NAO';
      return sanitizeCell_(v);
    });
    if (!extraWidth) return base;
    // Keyed on the row's OWN key value, not the sanitized cell — sanitizeCell_
    // can prefix an apostrophe, which would never match what was read back.
    const key = String(r[cfg.cols[0]] === undefined || r[cfg.cols[0]] === null ? '' : r[cfg.cols[0]]);
    return base.concat(extraByKey[key] || blankExtra);
  });

  if (values.length) {
    sheet.getRange(2, 1, values.length, sheetWidth).setValues(values);
  }
  // Surplus rows must be DELETED, not merely cleared. clearContent() leaves
  // the physical rows behind, and a blank row is not inert here: readSheet_
  // maps it to an object and mints an id for it, and backfillMissingIds_
  // (top of every getAll, under the lock) then writes that generated id
  // back — turning a leftover blank into a PERMANENT phantom record with a
  // real id, which shows up in the app as an empty lançamento/tarefa that
  // nobody created and nobody can explain. Only mattered once a caller
  // shrank a sheet, which whole-tab saves rarely did until deleteProject_;
  // it was always latent for saveProjetos_ (removing a project) too.
  if (existingRows > values.length) {
    sheet.deleteRows(2 + values.length, existingRows - values.length);
  }
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

// {id: true} for one sheet, reading ONLY column A. Used by assertBatchAccess_
// to answer "does this id already exist" without pulling every column.
function readIdSet_(key) {
  const cfg = SHEETS[key];
  const out = {};
  if (!cfg || cfg.cols[0] !== 'id') return out;
  const sheet = ss_().getSheetByName(cfg.name);
  if (!sheet) return out;
  const lastRow = sheet.getLastRow();
  if (lastRow < 2) return out;
  const ids = sheet.getRange(2, 1, lastRow - 1, 1).getValues();
  for (let i = 0; i < ids.length; i++) {
    const v = ids[i][0];
    if (v !== '' && v !== null && v !== undefined) out[String(v)] = true;
  }
  return out;
}

// Builds, ONCE per batch, the id → sheet-row-number map plus the current
// lastModified per row, for every row-level sheet the batch touches.
// Previously findConflicts_ and applyBatch_ each re-scanned the whole id
// column for EVERY row (findRowIndexById_ per upsert, twice over), and the
// conflict check additionally issued one single-cell getValue() per upsert —
// so a batch of N rows cost roughly 2N column scans plus N cell reads. This
// makes it two narrow reads per sheet, total, regardless of N.
function buildRowIndexes_(ops) {
  const indexes = {};
  ops.forEach(function (op) {
    const cfg = SHEETS[op.sheet];
    if (!cfg || !cfg.rowLevel || indexes[op.sheet]) return;
    const sheet = ss_().getSheetByName(cfg.name);
    if (!sheet) return;
    const lastRow = sheet.getLastRow();
    const map = {};
    const lastModifiedByRow = {};
    if (lastRow >= 2) {
      const lmCol = cfg.cols.indexOf('lastModified') + 1;
      const ids = sheet.getRange(2, 1, lastRow - 1, 1).getValues();
      const lms = lmCol > 0 ? sheet.getRange(2, lmCol, lastRow - 1, 1).getValues() : null;
      for (let i = 0; i < ids.length; i++) {
        const v = ids[i][0];
        if (v === '' || v === null || v === undefined) continue;
        const rowNum = i + 2;
        map[String(v)] = rowNum;
        // This reads lastModified straight off the sheet, bypassing
        // readSheet_ entirely — coerceTimestamp_ has to be applied here too,
        // or a Date-typed lastModified cell would flow into findConflicts_'s
        // String(current) !== String(expected) check as a Date's default
        // String() (e.g. "Mon Sep 01 2026 ...") and never match the client's
        // numeric baseline, permanently conflicting every write to that row.
        if (lms) lastModifiedByRow[rowNum] = coerceTimestamp_(lms[i][0]);
      }
    }
    indexes[op.sheet] = { sheet: sheet, map: map, lastModifiedByRow: lastModifiedByRow };
  });
  return indexes;
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
// Each conflict entry carries the row's CURRENT lastModified, not just its id
// — this lets the frontend rebase its stale baseline and retry once without
// a second round trip (see syncSheetsNow_'s retry-with-rebase in index.html).
// Purely additive: a frontend that ignores the extra field behaves exactly
// as before.
function findConflicts_(ops, indexes) {
  const conflicts = [];
  ops.forEach(op => {
    const cfg = SHEETS[op.sheet];
    if (!cfg || !cfg.rowLevel) return;
    const idx = indexes && indexes[op.sheet];
    if (!idx) return;
    (op.upserts || []).forEach(u => {
      if (!u.expectedLastModified) return; // brand-new row, nothing to conflict with
      const rowIdx = idx.map[String(u.id)];
      if (!rowIdx) {
        // The row is GONE. This used to fall through as "treat as new", which
        // silently re-appended it — so a device holding stale state could
        // resurrect a record another device (or deleteProject_) had deleted,
        // and re-creating a row of an already-deleted project left an orphan
        // nothing could resolve or clean up.
        //
        // An expectedLastModified is only ever set for a row the client has
        // actually seen the server hold (diffRows_ takes it from a snapshot
        // built from a getAll or a confirmed write), so "it had one and the
        // row is gone" can only mean deleted-elsewhere. Reported as its own
        // kind of conflict so the client drops it locally instead of
        // resurrecting it. Purely additive — an older frontend that ignores
        // the flag just sees a conflict and stops, which is still safer than
        // the silent resurrection it replaces.
        conflicts.push({ sheet: op.sheet, id: u.id, deleted: true });
        return;
      }
      const current = idx.lastModifiedByRow[rowIdx];
      if (String(current) !== String(u.expectedLastModified)) {
        conflicts.push({ sheet: op.sheet, id: u.id, currentLastModified: current });
      }
    });
  });
  return conflicts;
}

function applyBatch_(ops, indexes) {
  const updated = {};
  ops.forEach(op => {
    const cfg = SHEETS[op.sheet];
    if (!cfg || !cfg.rowLevel) return;
    const idx = indexes && indexes[op.sheet];
    const sheet = (idx && idx.sheet) || ss_().getSheetByName(cfg.name);
    if (!sheet) return;
    updated[op.sheet] = [];

    (op.upserts || []).forEach(u => {
      const newLastModified = Date.now();
      const rowObj = Object.assign({}, u.row, { lastModified: newLastModified });
      // Safe to trust the prebuilt index here: setValues never shifts rows,
      // and appendRow only adds past the end — so an index built before this
      // loop stays valid throughout it, as long as appends are recorded.
      const usableIdx = idx && !idx.stale ? idx : null;
      const rowIdx = usableIdx ? usableIdx.map[String(u.id)] : findRowIndexById_(sheet, u.id);
      const values = rowValuesFromObj_(cfg, rowObj);
      if (rowIdx && rowIdx > -1) {
        sheet.getRange(rowIdx, 1, 1, cfg.cols.length).setValues([values]);
      } else {
        sheet.appendRow(values);
        if (usableIdx) usableIdx.map[String(u.id)] = sheet.getLastRow(); // keep the index truthful for anything later in this batch
      }
      updated[op.sheet].push({ id: u.id, lastModified: newLastModified });
    });

    // Deletes deliberately keep re-scanning: deleteRow SHIFTS every row below
    // it, so any prebuilt index is stale the moment the first one lands.
    (op.deletes || []).forEach(id => {
      const rowIdx = findRowIndexById_(sheet, id);
      if (rowIdx > -1) sheet.deleteRow(rowIdx);
    });
    // Mark (don't null) so a later op on this same sheet falls back to a
    // fresh scan instead of trusting now-shifted row numbers.
    if (idx && (op.deletes || []).length) idx.stale = true;
  });
  return updated;
}

// Removes rows by id from one sheet. Same discipline as applyBatch_'s delete
// branch: deleteRow shifts everything below it, so each id is re-scanned
// rather than trusting a prebuilt index. Bottom-up so a single pass is enough
// even when several ids land in one sheet.
function deleteRowsByIds_(sheetKey, ids) {
  const cfg = SHEETS[sheetKey];
  const sheet = ss_().getSheetByName(cfg.name);
  if (!sheet) return 0;
  const wanted = {};
  ids.forEach(function (id) { wanted[String(id)] = true; });
  const lastRow = sheet.getLastRow();
  if (lastRow < 2) return 0;
  const col = sheet.getRange(2, 1, lastRow - 1, 1).getValues();
  let removed = 0;
  for (let i = col.length - 1; i >= 0; i--) {
    if (wanted[String(col[i][0])]) { sheet.deleteRow(i + 2); removed++; }
  }
  return removed;
}

// GET is no longer used for anything — reads now go through doPost (see
// 'getAll' below) so the bearer idToken never has to travel in a URL/query
// string, where it'd be liable to end up in logs. Kept as a harmless no-op
// rather than removed outright, since Apps Script always requires a doGet.
function doGet(e) {
  return jsonOut_({ error: 'Use POST.' });
}

// ------------------------------------------------------------
// PROJECT <-> SOCIO ASSIGNMENT
//
// Two pieces of storage, deliberately separate:
//   * Socios (a single-column tab)  -> the master list of people. Shared
//     reference data, same shape and same whole-tab-replace treatment as
//     Tipos/Unidades.
//   * Projetos.socios (a cell)      -> which of those people are currently
//     assigned to that one project, as a comma-separated list of names.
//
// Keeping them apart is what makes the two rules in the spec structurally
// true rather than merely "handled": assigning someone to a project can
// never duplicate the socio (the master list is untouched), and removing
// someone from a project can never delete the socio (only that one cell
// changes). A socio assigned to several projects is several independent
// cells, so removing them from one is invisible to the others.
//
// The assignment is CURRENT CONFIGURATION. The `socio` column already
// written on a CaixaObra/Empreiteiro row is HISTORY, and nothing in this
// file ever rewrites it from an assignment change — not even the migration
// below, which only ever READS entries to decide what to assign.
// ------------------------------------------------------------

// Splits a "A, B, C" cell into a clean, de-duplicated list. Deduplication is
// the whole reason writes go through here rather than storing the client's
// string verbatim: "prevent duplicate assignments" has to hold at the
// persistence layer, not just in whichever UI happened to produce the value.
function parseSociosCell_(cell) {
  const seen = {};
  const out = [];
  String(cell === undefined || cell === null ? '' : cell).split(',').forEach(function (part) {
    const name = String(part).trim();
    if (!name) return;
    const key = name.toLowerCase();
    if (seen[key]) return;
    seen[key] = true;
    out.push(name);
  });
  return out;
}
function normalizeSociosCell_(cell) {
  return parseSociosCell_(cell).join(', ');
}
// Case-insensitive lookup against a list, returning the list's OWN spelling —
// so a name only ever gets stored in one casing no matter how it was typed.
function canonicalSocio_(list, name) {
  const key = String(name || '').trim().toLowerCase();
  if (!key) return '';
  for (let i = 0; i < list.length; i++) {
    if (String(list[i]).trim().toLowerCase() === key) return list[i];
  }
  return '';
}

// Does the Projetos sheet already carry the 'socios' header? This is the
// one-shot migration's guard, and it is deliberately the SHEET's own shape
// rather than a stored flag: the header is created by the migration itself,
// so "the column exists" is exactly "this has already run", with nothing to
// keep in sync. After it has run, a BLANK socios cell genuinely means "no
// socios assigned" — which is why the backfill can never run twice and
// silently re-add someone the user deliberately removed.
function projetosSociosCol_() {
  return SHEETS.projetos.cols.indexOf('socios') + 1;
}
function hasSociosColumn_(projetosSheet) {
  const col = projetosSociosCol_();
  if (projetosSheet.getMaxColumns() < col) return false;
  return String(projetosSheet.getRange(1, col).getValue()).trim().toLowerCase() === 'socios';
}

// Creates the Socios tab and the Projetos.socios column if this spreadsheet
// predates the feature, and backfills both from data that already exists.
// Idempotent, cheap on the common path (two getSheetByName calls plus one
// header read), and called from the same short-lived lock that already
// backfills missing ids at the top of getAll — a schema repair is a write,
// so it must never run lock-free alongside a concurrent batchMulti.
function ensureSociosSchema_() {
  const ss = ss_();
  let sociosSheet = ss.getSheetByName(SHEETS.socios.name);
  const projetosSheet = ss.getSheetByName(SHEETS.projetos.name);
  const needsColumn = !!projetosSheet && !hasSociosColumn_(projetosSheet);
  if (sociosSheet && !needsColumn) return;

  // Everything both halves need, read once. Only CaixaObra/Empreiteiro carry
  // a socio, and they are read strictly to OBSERVE what each project has
  // historically used — no entry row is written by any of this.
  const entries = readSheet_('caixaObra').concat(readSheet_('empreiteiro'));

  // --- Master list -------------------------------------------------------
  // Starts as the two names this app has always offered, plus every distinct
  // socio that actually appears in the data (a row typed straight into the
  // spreadsheet can carry a name the buttons never had). Derived from real
  // data; nothing invented beyond preserving the app's existing two options.
  const master = LEGACY_SOCIOS.slice();
  entries.forEach(function (e) {
    const name = String(e.socio || '').trim();
    if (name && !canonicalSocio_(master, name)) master.push(name);
  });
  if (!sociosSheet) {
    sociosSheet = ss.insertSheet(SHEETS.socios.name);
    sociosSheet.getRange(1, 1).setValue('socio');
    sociosSheet.setFrozenRows(1);
    sociosSheet.getRange(2, 1, master.length, 1).setValues(master.map(function (n) { return [n]; }));
  }

  // --- Projetos.socios column + one-shot backfill -------------------------
  if (!needsColumn) return;
  const col = projetosSociosCol_();
  if (projetosSheet.getMaxColumns() < col) {
    projetosSheet.insertColumnsAfter(projetosSheet.getMaxColumns(), col - projetosSheet.getMaxColumns());
  } else if (String(projetosSheet.getRange(1, col).getValue()).trim() !== '') {
    // Something else already occupies this position — a column a person added
    // by hand to the right of the schema. Shift it right instead of writing
    // over it; writeSheet_ already carries such columns along with their row,
    // and it would start reading that one AS 'socios' the moment the schema
    // grew past it.
    projetosSheet.insertColumnBefore(col);
  }
  projetosSheet.getRange(1, col).setValue('socios');

  const lastRow = projetosSheet.getLastRow();
  if (lastRow < 2) return;
  const ids = projetosSheet.getRange(2, 1, lastRow - 1, 1).getValues();
  // Per project, the socios its OWN history actually used — so an existing
  // project keeps offering exactly the people it has always been used with,
  // and nothing about the app's behaviour changes for it on the day this
  // ships. A project with no socio in its history at all falls back to the
  // same default a brand-new project gets. This is why the migration reads
  // entries: assigning every project every known socio would be an invention,
  // and assigning none would silently remove the ability to record who paid.
  const byProject = {};
  entries.forEach(function (e) {
    const proj = String(e.projeto || '').trim();
    const name = String(e.socio || '').trim();
    if (!proj || !name) return;
    const list = byProject[proj] || (byProject[proj] = []);
    const canon = canonicalSocio_(master, name) || name;
    if (!canonicalSocio_(list, canon)) list.push(canon);
  });
  const fallback = canonicalSocio_(master, DEFAULT_PROJECT_SOCIO) || DEFAULT_PROJECT_SOCIO;
  const out = ids.map(function (row) {
    const id = String(row[0] || '').trim();
    if (!id) return [''];
    const list = byProject[id];
    return [(list && list.length ? list : [fallback]).join(', ')];
  });
  projetosSheet.getRange(2, col, out.length, 1).setValues(out);
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
// driveFolderId is backend-owned (see the SHEETS.projetos comment) and the
// client has no concept of it — toSheetRows('projects', ...) on the frontend
// only ever sends {id, ativo, socios}. Whatever the client sends for an id that
// already exists in the sheet gets its CURRENT driveFolderId stamped back on
// before writing, so adding or renaming one project can never blank another
// project's (or even its own) already-resolved folder id. A brand-new id
// correctly starts blank — resolveOrCreateProjectFolder_ fills it in lazily
// on first use, same as it always has for a project with no folder yet.
function preserveProjectFolderIds_(rows) {
  const existing = readSheet_('projetos');
  const folderById = {};
  existing.forEach(function (p) { folderById[p.id] = p.driveFolderId || ''; });
  return (rows || []).map(function (r) {
    // socios IS client-owned (unlike driveFolderId, above) — the frontend
    // holds it on every project object and sends the whole array back — but
    // it still gets normalized here rather than written verbatim, so a
    // duplicate assignment can't exist in the sheet even if some future
    // caller sends one.
    return Object.assign({}, r, {
      driveFolderId: folderById[r.id] || '',
      socios: normalizeSociosCell_(r.socios),
    });
  });
}
function saveProjetos_(user, rows) {
  const merged = preserveProjectFolderIds_(rows);
  if (user.projects === '*') {
    writeSheet_('projetos', merged);
    return;
  }
  const existing = readSheet_('projetos');
  const outOfScope = existing.filter(p => !hasProjectAccess_(user, p.id));
  writeSheet_('projetos', outOfScope.concat(merged));
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

  // Usuarios.projetos FIRST, deliberately. Nothing else has been written yet,
  // so a failure here is a clean no-op; and if the business-data rewrite below
  // fails part-way, re-running the rename still works (the Projetos row still
  // says oldName) and this step is idempotent — no entry matches oldName any
  // more, so it simply changes nothing the second time.
  renameProjectInUsuarios_(oldName, newName);

  // Resolve the Drive folder BEFORE renaming the row's id below, since the id
  // lookup only works while the row still says oldName. A manually-renamed-in-
  // Drive folder is found correctly, because the id — once known — doesn't
  // care what it's called. A STALE or TRASHED stored id resolves to nothing
  // here on purpose: renaming a folder found by a name guess would rename an
  // unrelated folder (see lookupProjectFolder_).
  let folder = null;
  let folderNeedsBackfill = false;
  try {
    const found = resolveExistingProjectFolder_(oldName);
    if (found.state === PROJECT_FOLDER_RESOLVED) {
      folder = found.folder;
      folderNeedsBackfill = !!found.viaName; // found by name -> persist its id under the new name below
    }
  } catch (e) { /* cosmetic only, see below */ }

  projetosSheet.getRange(rowIdx, 1).setValue(sanitizeCell_(newName));

  ['caixaObra', 'empreiteiro', 'tarefas', 'documentos', 'notas'].forEach(function (key) {
    renameProjectColumnBulk_(key, oldName, newName);
  });
  // Fotos has no 'projeto' column — a project-level photo (refTipo:'projeto')
  // carries the project name in refId instead (see resolveFotoProject_ /
  // resolveFotoSection_). Without this, renaming a project would silently
  // orphan every photo added directly to it, since nothing else in this
  // function ever touches the Fotos sheet.
  renameProjectFotoRefsBulk_(oldName, newName);

  // Best-effort cosmetic rename of the Drive folder too, so it keeps LOOKING
  // like the project even though the app no longer depends on its name to
  // find it. Drive is never the source of truth for the project name, so a
  // failure here must not fail (or partially undo) the rename itself. The
  // row's own driveFolderId cell is untouched by this whole function (only
  // column 1, the id, is written above) so it survives the rename intact —
  // no re-persistence needed.
  try {
    if (folder) folder.setName(newName);
  } catch (e) { /* cosmetic only */ }
  // Self-healing backfill: a pre-ID-era project whose folder we just had to
  // find by name gets its canonical id persisted now (under the NEW name, the
  // row's current id), so nothing has to name-guess for it ever again — which
  // is what the sweeper and the merge repair now depend on.
  try {
    if (folder && folderNeedsBackfill) persistProjectFolderId_(newName, folder.getId());
  } catch (e) { /* best-effort backfill */ }
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

// Same one-read/one-write-per-sheet shape as renameProjectColumnBulk_ above,
// but for Fotos specifically: it has no 'projeto' column, so a project-level
// photo's project lives in refId (only where refTipo==='projeto' — every
// other refTipo's refId is an entry/task/note id, never a project name, and
// must not be touched).
function renameProjectFotoRefsBulk_(oldName, newName) {
  const cfg = SHEETS.fotos;
  const sheet = ss_().getSheetByName(cfg.name);
  if (!sheet) return;
  const lastRow = sheet.getLastRow();
  if (lastRow < 2) return;
  const refTipoCol = cfg.cols.indexOf('refTipo') + 1;
  const refIdCol = cfg.cols.indexOf('refId') + 1;
  const refTipoValues = sheet.getRange(2, refTipoCol, lastRow - 1, 1).getValues();
  const refIdRange = sheet.getRange(2, refIdCol, lastRow - 1, 1);
  const refIdValues = refIdRange.getValues();
  let changed = false;
  for (let i = 0; i < refIdValues.length; i++) {
    if (refTipoValues[i][0] === 'projeto' && refIdValues[i][0] === oldName) {
      refIdValues[i][0] = sanitizeCell_(newName);
      changed = true;
    }
  }
  if (changed) refIdRange.setValues(refIdValues);
}

// Deletes a project and EVERYTHING that belongs to it, as one atomic bulk
// operation — same reasoning (and the same one-read/one-write-per-sheet
// shape) as renameProject_ above: expressing this as a batchMulti of every
// referencing row would run assertBatchAccess_/findConflicts_/applyBatch_
// once per row and, for a project with real history, blow through Apps
// Script's execution limit leaving the project half-deleted.
//
// Order is load-bearing, in TWO separate places, and both are the same rule
// ("a parent-deletion cascade must delete the children FIRST") applied one
// level up. Fotos/Notas rows don't carry a project of their own — they
// resolve it by walking up to their parent entry/task/note (see
// resolveFotoProject_/resolveNotaProject_):
//   (a) RESOLUTION must happen while the parents still exist — hence the
//       single up-front read pass below, before anything is written.
//   (b) DELETION must ALSO run children-before-parents, because nothing here
//       is transactional. Sheets has no rollback, so a failure between two
//       writes (a Sheets error, or the 6-minute execution limit — likeliest
//       on exactly the large projects this bulk path exists for) leaves the
//       operation half-done, and the user's only recovery is to run it
//       again. Deleting parents first made that retry UNABLE to finish:
//       with the parents already gone, the second run's entryIdx no longer
//       contains them, resolveFotoProject_/resolveNotaProject_ return
//       undefined, and those child rows never match the project again —
//       permanently orphaned, and invisible to sweepOrphanFiles too, since
//       it iterates readSheet_('projetos') and the project is gone. Doing
//       children first costs nothing (resolution already happened in step 1)
//       and makes every failure point recoverable: die before the children
//       and nothing was deleted yet; die after them and the parents are
//       still resolvable; die during the parents and each remaining one
//       still matches on its own `projeto` column, needing no chain at all.
function deleteProject_(name) {
  name = String(name || '').trim();
  if (!name) throw new Error('nome de projeto inválido');

  const projetosSheet = ss_().getSheetByName(SHEETS.projetos.name);
  if (!projetosSheet) throw new Error('Aba não encontrada: ' + SHEETS.projetos.name);
  if (findRowIndexById_(projetosSheet, name) === -1) throw new Error('projeto não encontrado');

  // Resolve the Drive folder BY ID now, while the Projetos row still exists
  // (step 3 below deletes it) — falls back to name only for a project never
  // backfilled yet. A folder renamed directly in Drive has zero effect on
  // this once an id is known: deleteProject_ trashes exactly the one folder
  // this project owns, never every folder that currently happens to share
  // its name (see auditProjectFolders() for surfacing name-collisions
  // instead of guessing which one is "right").
  let projectFolder = null;
  let folderState = PROJECT_FOLDER_UNSET;
  try {
    const found = resolveExistingProjectFolder_(name);
    folderState = found.state;
    if (found.state === PROJECT_FOLDER_RESOLVED) projectFolder = found.folder;
  } catch (e) { /* best-effort, see step 4 below */ }

  // Same ordering reasoning as renameProject_: a failure here has written
  // nothing else yet, and a retry after a partial failure below is idempotent.
  removeProjectFromUsuarios_(name);

  // Stabilise ids BEFORE resolving what to delete. readSheet_ mints a FRESH
  // random id for a blank-id row on every call, so the doomed-id set built
  // from the read below would never match the ids the second read (inside
  // deleteProjectRowsBulk_) invents — the row was reported as deleted and
  // silently survived, pointing at a Drive file that had just been trashed
  // along with the folder. Backfilling first makes every id stable and real.
  // Safe here: deleteProject_ already runs inside the write lock.
  ['fotos', 'notas', 'caixaObra', 'empreiteiro', 'tarefas', 'documentos'].forEach(function (k) {
    backfillMissingIds_(k);
  });

  // --- 1. Resolve what belongs to this project, parents still intact. ---
  const caixaObra = readSheet_('caixaObra');
  const empreiteiro = readSheet_('empreiteiro');
  const tarefas = readSheet_('tarefas');
  const notas = readSheet_('notas');
  const fotos = readSheet_('fotos');
  const documentos = readSheet_('documentos');

  const entryIdx = buildEntryProjectIndex_(caixaObra, empreiteiro, tarefas);
  const notaProjectById = {};
  notas.forEach(function (n) { notaProjectById[n.id] = resolveNotaProject_(n, entryIdx); });

  const doomedNotas = notas.filter(function (n) { return notaProjectById[n.id] === name; });
  const doomedFotos = fotos.filter(function (f) {
    return resolveFotoProject_(f, entryIdx, notaProjectById) === name;
  });
  const doomedDocs = documentos.filter(function (d) { return d.projeto === name; });

  const report = {
    lancamentos: caixaObra.filter(function (r) { return r.projeto === name; }).length
               + empreiteiro.filter(function (r) { return r.projeto === name; }).length,
    tarefas: tarefas.filter(function (r) { return r.projeto === name; }).length,
    notas: doomedNotas.length,
    fotos: doomedFotos.length,
    documentos: doomedDocs.length,
  };

  // --- 2. Drop the rows, one read+write per sheet regardless of row count.
  // CHILDREN FIRST (fotos, then notas — a foto can hang off a nota, so it is
  // the deeper of the two), THEN the parents. See the ordering note above:
  // this is what makes a retry after a partial failure able to finish the
  // job instead of stranding unresolvable orphans. ---
  const doomedFotoIds = {};
  doomedFotos.forEach(function (f) { doomedFotoIds[String(f.id)] = true; });
  deleteProjectRowsBulk_('fotos', function (r) { return doomedFotoIds[String(r.id)]; });
  const doomedNotaIds = {};
  doomedNotas.forEach(function (n) { doomedNotaIds[String(n.id)] = true; });
  deleteProjectRowsBulk_('notas', function (r) { return doomedNotaIds[String(r.id)]; });
  ['caixaObra', 'empreiteiro', 'tarefas', 'documentos'].forEach(function (key) {
    deleteProjectRowsBulk_(key, function (r) { return r.projeto === name; });
  });

  // --- 3. The project row itself, last: while it exists the operation is
  // still resumable by simply re-running it, and a failure part-way through
  // leaves a project that visibly still exists rather than orphaned rows
  // pointing at a project that doesn't. ---
  const rowIdx = findRowIndexById_(projetosSheet, name);
  if (rowIdx !== -1) projetosSheet.deleteRow(rowIdx);

  // --- 4. Drive. Trashing the project's FOLDER takes every file inside it in
  // one call — deliberately not one setTrashed() per driveFileId, which is
  // exactly the unbounded-cost-per-id shape DELETE_CHUNK_SIZE exists to
  // avoid and would time out on a project with hundreds of photos. A stray
  // file that somehow lives outside the folder is not chased here; its row
  // is gone, so sweepOrphanFiles reclaims it on the next run. Best-effort:
  // Drive is never the source of truth, so a failure here must not fail (or
  // half-undo) a delete that has already committed to the sheets. ---
  try {
    if (projectFolder) projectFolder.setTrashed(true);
    else if (folderState === PROJECT_FOLDER_STALE || folderState === PROJECT_FOLDER_TRASHED) {
      // A stored id we could not use. Deliberately NOT resolved by name — that
      // could trash a folder belonging to something else entirely. Reported so
      // the user is told the rows are gone but the Drive files may not be,
      // rather than being left to assume everything was cleaned up.
      report.driveFolderUnresolved = true;
    }
  } catch (e) { /* rows are already gone; sweepOrphanFiles cleans up the rest */ }

  return report;
}

// One read + one clear + one write per sheet, regardless of how many rows
// match — same bulk discipline as renameProjectColumnBulk_. Deliberately NOT
// deleteRowsByIds_, which calls deleteRow() once per matching row: fine for a
// handful of ids, but a project can own thousands of rows.
function deleteProjectRowsBulk_(sheetKey, shouldDelete) {
  const rows = readSheet_(sheetKey);
  const keep = rows.filter(function (r) { return !shouldDelete(r); });
  if (keep.length === rows.length) return 0;
  writeSheet_(sheetKey, keep);
  return rows.length - keep.length;
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

    // Identity/permissions only, no sheet data, no lock — the cheapest
    // possible confirmation that a token is genuinely valid. Lets the
    // frontend open the app (render from local cache) the moment identity
    // is proven, instead of waiting on the full getAll to even open the
    // gate. See onGoogleSignIn/loadAll in index.html.
    if (action === 'verify') {
      return jsonOut_({ currentUser: user });
    }

    if (action === 'getAll') {
      // readSheet_ can write: a row typed directly into the sheet with a
      // blank id gets one assigned and saved back, so it stays stable
      // across future reads. That write must not race a concurrent
      // batchMulti's own writes to the same sheet. Rather than holding the
      // lock across the whole (expensive) multi-sheet read below, backfill
      // ids first in their own short-lived lock — a cheap, id-column-only
      // pass — so the actual reads that follow never need to write, and
      // therefore never need the lock either. This is what lets a
      // background getAll stop blocking a small user-initiated write
      // behind it.
      const idLock = LockService.getScriptLock();
      try {
        idLock.waitLock(15000);
      } catch (err) {
        return jsonOut_({ error: 'Servidor ocupado, tente novamente.' });
      }
      try {
        // Same short-lived lock, same reason: both of these repair the
        // spreadsheet's own shape and therefore WRITE, so neither may run
        // alongside a concurrent batchMulti. ensureSociosSchema_ is a no-op
        // on every request after the first one following this feature's
        // deploy (see there).
        ensureSociosSchema_();
        Object.keys(SHEETS).forEach(function (key) { backfillMissingIds_(key); });
      } finally {
        idLock.releaseLock();
      }

      const out = { currentUser: user };
      Object.keys(SHEETS).forEach(key => { out[key] = readSheet_(key); });
      return jsonOut_(filterAllByAccess_(user, out));
    }

    if (action === 'uploadFile') {
      // Deliberately OUTSIDE the script lock below — this action touches
      // ONLY Drive, never a sheet, so it has nothing to serialize against.
      // It used to sit inside the same lock as batchMulti/saveSheet/
      // renameProject, which meant every upload queued behind every other
      // upload AND behind the user's own task/entry saves — this was the
      // stated reason concurrent client-side uploads kept getting declined
      // (see CLAUDE.md §9): parallelizing the client just relocated the
      // wait into lock contention. Moving this out removes that reason.
      // Security is unchanged: the file this creates isn't visible anywhere
      // in the app until a later batchMulti (still fully locked) attaches it
      // to a Fotos/Documentos row, and THAT step independently re-resolves
      // its real section from the row's own refTipo — never trusting what
      // this action was told. body.section here is only a client-declared
      // hint for which upload-permission bucket to check, cheap enough to
      // keep a denied role from writing to Drive at all.
      const uploadSection = String(body.section || '').toLowerCase().trim();
      if (!can_(user, uploadSection, 'upload')) throw new Error('sem permissão para enviar arquivos');
      if (!hasProjectAccess_(user, body.projeto)) throw new Error('sem acesso a este projeto');
      const projectFolder = resolveOrCreateProjectFolder_(body.projeto);
      // "kind" is a separate, explicit field from "section" — a photo and a
      // document can share the same section (e.g. 'docs' for a project
      // photo), so section alone can't say which subfolder a file belongs
      // in. An unrecognized/missing kind falls back to the project root
      // rather than guessing, so an old, not-yet-redeployed frontend still
      // uploads successfully.
      const uploadKind = String(body.kind || '').toLowerCase().trim();
      const folder = uploadKind === 'photo' ? resolveOrCreateSubfolderLocked_(projectFolder, 'Fotos')
        : uploadKind === 'doc' ? resolveOrCreateSubfolderLocked_(projectFolder, 'Documentos')
        : projectFolder;
      const bytes = Utilities.base64Decode(body.base64);
      // Photos had no size ceiling anywhere — not in the picker, not here —
      // while documents were capped client-side only. Since uploadFile now
      // runs outside the script lock, an authenticated client could push
      // unbounded bytes at Drive with nothing to stop it. Server-side is the
      // only place this can actually be enforced.
      if (bytes.length > MAX_UPLOAD_BYTES) throw new Error('arquivo grande demais');
      const blob = Utilities.newBlob(bytes, body.mimeType, body.filename);
      const file = folder.createFile(blob);
      file.setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW);
      return jsonOut_({ ok: true, fileId: file.getId(), url: file.getUrl() });
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
        // One id+lastModified read per touched sheet, shared by both the
        // conflict check and the write below — see buildRowIndexes_.
        const rowIndexes = buildRowIndexes_(ops);
        const conflicts = findConflicts_(ops, rowIndexes);
        if (conflicts.length > 0) {
          return jsonOut_({ conflict: true, conflicts: conflicts });
        }
        const updated = applyBatch_(ops, rowIndexes);
        return jsonOut_({ ok: true, updated: updated });
      }

      // Legacy whole-tab save — still used for Projetos/Tipos/Unidades, gated
      // by the 'config' section's edit action. Tipos/Unidades are small
      // shared reference lists (no further authorization needed beyond that);
      // Projetos IS access-scoped, see saveProjetos_.
      if (action === 'saveSheet') {
        if (!can_(user, 'config', 'edit')) throw new Error('sem permissão para editar');
        // A write must never be the thing that discovers the Socios tab or
        // the Projetos.socios column doesn't exist yet — writeSheet_ throws
        // on a missing tab, and saveProjetos_ would otherwise write the
        // column into whatever position happens to be free. Idempotent and
        // cheap once the schema is in place; see ensureSociosSchema_.
        if (body.sheet === 'projetos' || body.sheet === 'socios') ensureSociosSchema_();
        if (body.sheet === 'projetos') {
          saveProjetos_(user, body.rows);
        } else if (body.sheet === 'socios') {
          // Same de-duplication rule the assignment cell gets, applied to the
          // master list: two socios differing only in casing are one socio.
          const seen = {};
          const rows = (body.rows || []).map(function (r) {
            return String((r && r.socio !== undefined ? r.socio : r) || '').trim();
          }).filter(function (name) {
            const key = name.toLowerCase();
            if (!name || seen[key]) return false;
            seen[key] = true;
            return true;
          }).map(function (name) { return { socio: name }; });
          writeSheet_('socios', rows);
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
        // Project scope, checked independently of the section/action above —
        // the same two-axis rule deleteProject enforces below, and the one
        // this action was silently missing. Without it a project-scoped user
        // could rename a project they cannot even see, bulk-rewriting the
        // projeto column across five sheets outside their scope (and, via
        // renameProjectInUsuarios_, moving other people's access with it).
        if (!hasProjectAccess_(user, String(body.oldName || '').trim())) throw new Error('sem acesso a este projeto');
        renameProject_(body.oldName, body.newName);
        return jsonOut_({ ok: true });
      }

      // Deleting a project and everything under it. Two independent axes, as
      // everywhere else: the section/action check (config.delete — NOT
      // config.edit, so a role allowed to add and rename projects is not
      // automatically allowed to destroy one), and then project scope, so a
      // project-restricted user can never delete a project outside their own
      // scope even if their role carries config.delete.
      if (action === 'deleteProject') {
        if (!can_(user, 'config', 'delete')) throw new Error('sem permissão para excluir');
        if (!hasProjectAccess_(user, String(body.name || '').trim())) throw new Error('sem acesso a este projeto');
        const removed = deleteProject_(body.name);
        return jsonOut_({ ok: true, removed: removed });
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

      // Deletes photo/document RECORDS by their own id: trashes each Drive
      // file AND removes each sheet row, together, inside this one lock.
      //
      // This exists because the two-step client flow it replaces could never
      // work. The client removed the row first (via batchMulti) and then asked
      // deleteFile to trash the file — but deleteFile deliberately refuses any
      // fileId that is not present in Fotos/Documentos, which by then it never
      // was. Every delete therefore threw 'arquivo não encontrado', the error
      // was swallowed client-side, and the file stayed in Drive forever. Two
      // documented rules were in direct contradiction and the security rule
      // silently won.
      //
      // Doing it server-side also *narrows* the security surface rather than
      // widening it: the client can no longer name a Drive file at all. It
      // names an app record; the server resolves the row, authorizes it on
      // both axes, and derives the fileId itself.
      if (action === 'deletePhotos' || action === 'deleteDocumentos') {
        const isFoto = action === 'deletePhotos';
        const sheetKey = isFoto ? 'fotos' : 'documentos';
        const ids = (body.ids || []).map(String);
        if (!ids.length) return jsonOut_({ ok: true, deleted: [] });

        const rows = readSheet_(sheetKey);
        const byId = {};
        rows.forEach(function (r) { byId[String(r.id)] = r; });

        // Resolve section/project for every requested row BEFORE touching
        // anything, so an unauthorized id in the list rejects the whole
        // request rather than leaving a half-applied delete behind.
        let resolveSection, resolveProject;
        if (isFoto) {
          const entryIdx = buildEntryProjectIndex_(readSheet_('caixaObra'), readSheet_('empreiteiro'), readSheet_('tarefas'));
          const notaSectionById = {};
          const notaProjectById = {};
          readSheet_('notas').forEach(function (n) {
            notaSectionById[n.id] = resolveNotaSection_(n);
            notaProjectById[n.id] = resolveNotaProject_(n, entryIdx);
          });
          resolveSection = function (row) { return resolveFotoSection_(row, notaSectionById); };
          resolveProject = function (row) { return resolveFotoProject_(row, entryIdx, notaProjectById); };
        } else {
          resolveSection = function () { return 'docs'; };
          resolveProject = function (row) { return row.projeto; };
        }

        const targets = [];
        ids.forEach(function (id) {
          const row = byId[id];
          if (!row) return; // already gone — deleting twice is not an error
          const section = resolveSection(row);
          const project = resolveProject(row);
          if (!section || !can_(user, section, 'delete')) throw new Error('sem permissão para excluir arquivos');
          if (!hasProjectAccess_(user, project)) throw new Error('sem acesso a este projeto');
          targets.push(row);
        });

        // Trash first, then drop the rows. If trashing fails the row survives,
        // so the app still knows about the file and can retry — the opposite
        // ordering is what created untraceable orphans.
        targets.forEach(function (row) {
          if (!row.driveFileId) return;
          try {
            DriveApp.getFileById(row.driveFileId).setTrashed(true);
          } catch (e) {
            // Already trashed, or removed from Drive by hand. The row should
            // still go — leaving it would point at nothing.
          }
        });
        const deletedIds = targets.map(function (r) { return String(r.id); });
        if (deletedIds.length) deleteRowsByIds_(sheetKey, deletedIds);
        return jsonOut_({ ok: true, deleted: deletedIds });
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

// ------------------------------------------------------------
// Orphan sweeper. Trashes Drive files under a project's Fotos//Documentos/
// subfolders that no Fotos/Documentos row references any more.
//
// Two things create orphans: an upload that reached Drive but whose row was
// never written (the app was closed, or the metadata save failed and was never
// retried), and — historically — every single delete, because the old
// client-side flow removed the row before asking Drive to trash the file (see
// deletePhotos above). Nothing could clean those up from the client without
// loosening the rule that stops an unchecked fileId reaching the deploying
// account's whole Drive, so it has to happen here.
//
// Deliberately conservative:
//   - only looks inside project folders this app created, never the parent;
//   - only touches files older than ORPHAN_MIN_AGE_MS, so it can never race an
//     upload that is still in flight;
//   - dry-run by default. Call sweepOrphanFiles(true) to actually trash.
// Safe to re-run: trashing is idempotent and Drive keeps trash for 30 days.
// ------------------------------------------------------------
const ORPHAN_MIN_AGE_MS = 24 * 60 * 60 * 1000;

function sweepOrphanFiles(commit) {
  const referenced = {};
  readSheet_('fotos').forEach(function (r) { if (r.driveFileId) referenced[r.driveFileId] = true; });
  readSheet_('documentos').forEach(function (r) { if (r.driveFileId) referenced[r.driveFileId] = true; });

  const cutoff = Date.now() - ORPHAN_MIN_AGE_MS;
  const report = { scanned: 0, orphans: 0, trashed: 0, tooNew: 0, folders: [], unresolved: [], committed: !!commit };

  function scanFolder(folder, label) {
    report.folders.push(label);
    const files = folder.getFiles();
    while (files.hasNext()) {
      const f = files.next();
      report.scanned++;
      if (referenced[f.getId()]) continue;
      if (f.getDateCreated().getTime() > cutoff) { report.tooNew++; continue; }
      report.orphans++;
      if (commit) { f.setTrashed(true); report.trashed++; }
    }
  }

  const projetosRows = readSheet_('projetos');
  projetosRows.forEach(function (p) {
    // BY ID, not by name. A project whose Drive folder was renamed by hand —
    // the exact case driveFolderId exists to survive — used to fall out of a
    // getFoldersByName lookup entirely, so the sweeper scanned nothing for it
    // and reported a reassuring zero orphans while leftovers piled up.
    const found = resolveExistingProjectFolder_(p.id, projetosRows);
    if (found.state !== PROJECT_FOLDER_RESOLVED) {
      if (found.state !== PROJECT_FOLDER_UNSET) report.unresolved.push({ project: p.id, reason: found.state });
      return;
    }
    const projectFolder = found.folder;
    // Files sitting directly in the project root (not inside Fotos/
    // Documentos) — the uploadFile fallback for a missing/unrecognized `kind`
    // lands there deliberately, and it was invisible to this sweeper until
    // now: getFiles() on a folder only returns that folder's own immediate
    // files, never recursing into its subfolders, so this can't double-count
    // anything already caught below.
    scanFolder(projectFolder, p.id + '/(raiz)');
    ['Fotos', 'Documentos'].forEach(function (subName) {
      // Scan EVERY folder with this name, not just the first. A pre-fix race
      // (see resolveOrCreateSubfolderLocked_) let concurrent uploads create
      // duplicate same-named subfolders — stopping at the first match meant
      // whatever landed in the other copies was invisible to the sweeper,
      // which is why a Drive full of visible leftovers still swept to zero.
      const subs = projectFolder.getFoldersByName(subName);
      let subCount = 0;
      while (subs.hasNext()) {
        const folder = subs.next();
        subCount++;
        scanFolder(folder, p.id + '/' + subName + (subCount > 1 ? ' (dup ' + subCount + ')' : ''));
      }
    });
  });
  Logger.log(JSON.stringify(report));
  return report;
}

// Zero-arg wrappers so these can be run directly from the Apps Script
// editor's "Run" button, which always calls a function with NO arguments —
// sweepOrphanFiles()/mergeDuplicateProjectFolders() called that way silently
// stay in dry-run mode (commit defaults to undefined/falsy) and report as if
// they succeeded, having actually deleted or moved nothing. This was the
// real cause of "I ran both and nothing changed" — the functions were
// working correctly, but every manual run through the editor was a dry run.
function sweepOrphanFilesCommit() {
  return sweepOrphanFiles(true);
}
function mergeDuplicateProjectFoldersCommit() {
  return mergeDuplicateProjectFolders(true);
}

// ------------------------------------------------------------
// One-time repair for duplicate Fotos/Documentos folders created by the race
// resolveOrCreateSubfolderLocked_ now prevents. Run manually once — safe to
// re-run, and a no-op once nothing is duplicated any more.
//
// For each project, for each of Fotos/Documentos: if more than one same-named
// folder exists, keeps the OLDEST as canonical, moves every file out of the
// others into it (addFile + removeFile — files are never deleted, only
// relocated), and trashes the now-empty duplicates. Nothing here touches
// which rows point at which driveFileId, because it never needed to: every
// reference in the app is by id, never by folder path.
//
// Dry-run by default, same as sweepOrphanFiles — call
// mergeDuplicateProjectFolders(true) to actually move anything.
// ------------------------------------------------------------
function mergeDuplicateProjectFolders(commit) {
  const report = { projects: [], filesMoved: 0, foldersTrashed: 0, skipped: [], committed: !!commit };

  // Every live project's canonical driveFolderId. Two rules come out of this
  // set, and both exist because this function is a REPAIR tool — it must never
  // be the thing that destroys the folder the sheet points at:
  //   1. If a duplicate group contains a canonical folder, that folder is the
  //      one kept, regardless of age. "Oldest wins" used to trash the stored
  //      folder whenever the stored id happened to be a newer duplicate, and
  //      since the sheet was never repointed, every later upload landed inside
  //      a trashed tree and was purged 30 days later.
  //   2. A canonical folder is never trashed as somebody else's duplicate.
  const canonicalIds = {};
  readSheet_('projetos').forEach(function (p) {
    if (p.driveFolderId) canonicalIds[String(p.driveFolderId)] = p.id;
  });

  function mergeSameNamed(parent, label) {
    const folders = [];
    const it = parent.getFolders();
    while (it.hasNext()) folders.push(it.next());
    // Group by name — Drive lets siblings share a name, which is the whole bug.
    const byName = {};
    folders.forEach(function (f) {
      const n = f.getName();
      (byName[n] = byName[n] || []).push(f);
    });
    Object.keys(byName).forEach(function (name) {
      const group = byName[name];
      if (group.length < 2) return;
      group.sort(function (a, b) { return a.getDateCreated().getTime() - b.getDateCreated().getTime(); });
      // Prefer a folder the sheet actually points at over the merely-oldest one.
      const canonicalOwned = group.filter(function (f) { return canonicalIds[f.getId()]; });
      if (canonicalOwned.length > 1) {
        // Two live projects' canonical folders share a name. Merging would
        // destroy one project's files — never automate that; report it.
        report.skipped.push({
          where: label + '/' + name,
          reason: 'multiple live projects claim same-named folders',
          projects: canonicalOwned.map(function (f) { return canonicalIds[f.getId()]; }),
        });
        return;
      }
      const canonical = canonicalOwned.length === 1 ? canonicalOwned[0] : group[0];
      const dupes = group.filter(function (f) {
        if (f === canonical) return false;
        if (canonicalIds[f.getId()]) return false; // another project's canonical folder — never touch it
        return true;
      });
      if (!dupes.length) return;
      let moved = 0;
      dupes.forEach(function (dupe) {
        const files = dupe.getFiles();
        while (files.hasNext()) {
          const f = files.next();
          if (commit) {
            canonical.addFile(f);
            dupe.removeFile(f);
          }
          moved++;
        }
      });
      report.projects.push({
        where: label + '/' + name,
        duplicateFolders: dupes.length,
        filesMoved: moved,
      });
      report.filesMoved += moved;
      if (commit) {
        dupes.forEach(function (dupe) { dupe.setTrashed(true); });
      }
      report.foldersTrashed += dupes.length;
    });
  }

  const projetosRows = readSheet_('projetos');
  projetosRows.forEach(function (p) {
    const found = resolveExistingProjectFolder_(p.id, projetosRows); // BY ID — same reason as the sweeper above
    if (found.state !== PROJECT_FOLDER_RESOLVED) {
      if (found.state !== PROJECT_FOLDER_UNSET) report.skipped.push({ where: p.id, reason: found.state });
      return;
    }
    mergeSameNamed(found.folder, p.id);
  });
  // The project folders themselves, one level up, share the same bug window.
  mergeSameNamed(DriveApp.getFolderById(FALLBACK_FOLDER_ID), '(projeto)');

  Logger.log(JSON.stringify(report));
  return report;
}

// ------------------------------------------------------------
// Read-only reconciliation report for project-level Drive folders. STRICTLY
// dry-run — there is no commit argument, and nothing in this function calls
// setTrashed/deleteRow/setValue/createFolder/addFile/removeFile or any other
// mutation. It exists to surface two things nothing else does:
//   - a DUPLICATE: a folder sharing a live project's NAME but not its
//     canonical driveFolderId — a leftover from the pre-lock creation race
//     (see resolveOrCreateProjectFolder_'s history), or a second folder a
//     person created by hand with the same name.
//   - an ORPHAN: a folder matching no live project at all, by id or by
//     name — almost always the Drive folder of a project deleted before
//     deleteProject_ existed, or a project's folder left behind after a
//     rename it predates.
// deleteProject_ deliberately only ever trashes the ONE folder it resolves
// by id, so it can never widen into deleting an unrelated duplicate — which
// means duplicates and orphans accumulate here for a human to act on,
// instead of the sweep functions guessing which folder is "right" from a
// name match alone (see the deleteProject_ ordering note in CLAUDE.md for
// why "looks like a match" isn't sufficient signal to automate).
// Resolution reuses resolveProjectFolderById_/findProjectFolder_ — the same
// read-only lookups resolveOrCreateProjectFolder_ uses before it creates or
// persists anything — so a project that has never been backfilled is still
// correctly recognized as "canonical" here without this function being the
// one to backfill it.
// ------------------------------------------------------------
function auditProjectFolders() {
  const liveProjects = readSheet_('projetos');
  const canonicalIdToProject = {};
  const unresolved = []; // projects whose stored driveFolderId is stale or trashed
  liveProjects.forEach(function (p) {
    let folder = null;
    try {
      const found = resolveExistingProjectFolder_(p.id, liveProjects);
      if (found.state === PROJECT_FOLDER_RESOLVED) folder = found.folder;
      else if (found.state === PROJECT_FOLDER_STALE || found.state === PROJECT_FOLDER_TRASHED) {
        unresolved.push({ project: p.id, storedId: found.storedId, reason: found.state });
        // Its stored id still names a real (if trashed) folder, so keep that id
        // out of the duplicate/orphan buckets — it is not an unrelated folder.
        if (found.storedId) canonicalIdToProject[found.storedId] = p.id;
      }
    } catch (e) { /* left unresolved; its Drive folder (if any) reports as an orphan below */ }
    if (folder) canonicalIdToProject[folder.getId()] = p.id;
  });

  // Immediate contents only (name + file count), not a recursive walk — this
  // is meant to give an admin enough to decide, not to enumerate every file.
  function describeFolder(folder) {
    const files = folder.getFiles();
    let fileCountInRoot = 0;
    while (files.hasNext()) { files.next(); fileCountInRoot++; }
    const subfolders = [];
    const subs = folder.getFolders();
    while (subs.hasNext()) {
      const sub = subs.next();
      const subFiles = sub.getFiles();
      let subCount = 0;
      while (subFiles.hasNext()) { subFiles.next(); subCount++; }
      subfolders.push({ name: sub.getName(), id: sub.getId(), fileCount: subCount });
    }
    return {
      name: folder.getName(),
      id: folder.getId(),
      createdAt: folder.getDateCreated().toISOString(),
      fileCountInRoot: fileCountInRoot,
      subfolders: subfolders,
    };
  }

  const duplicates = [];
  const orphaned = [];
  let canonicalCount = 0;

  const parent = DriveApp.getFolderById(FALLBACK_FOLDER_ID);
  const it = parent.getFolders();
  while (it.hasNext()) {
    const folder = it.next();
    const id = folder.getId();
    const name = folder.getName();
    if (name === 'Backups') continue; // not a project folder at all

    if (canonicalIdToProject[id]) { canonicalCount++; continue; }
    const suspectedOwner = liveProjects.find(function (p) { return p.id === name; });
    if (suspectedOwner) {
      duplicates.push(Object.assign({ suspectedProject: suspectedOwner.id }, describeFolder(folder)));
    } else {
      orphaned.push(describeFolder(folder));
    }
  }

  // canonicalCount alone (not the full list) confirms the scan actually ran
  // and saw the expected number of live projects' folders — there's nothing
  // suspicious about a canonical folder worth listing in full here.
  const report = { canonicalCount: canonicalCount, unresolved: unresolved, duplicates: duplicates, orphaned: orphaned };
  Logger.log(JSON.stringify(report));
  return report;
}

function getOrCreateBackupFolder_() {
  const parent = DriveApp.getFolderById(FALLBACK_FOLDER_ID);
  const existing = parent.getFoldersByName('Backups');
  if (existing.hasNext()) return existing.next();
  return parent.createFolder('Backups');
}

function backupSpreadsheet_() {
  const backupFolder = getOrCreateBackupFolder_();
  const dateStr = Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'yyyy-MM-dd_HHmm');
  DriveApp.getFileById(ss_().getId()).makeCopy('Backup ' + dateStr, backupFolder);
  // The Usuarios/Papeis spreadsheet is the entire access-control configuration
  // and lives in a DIFFERENT file, so the business-data copy above never
  // covered it. Losing or corrupting it locks everyone out (correctly, since
  // every check fails closed) with nothing to restore from. Best-effort and
  // separate, so a failure to copy it can never cost us the business backup.
  try {
    DriveApp.getFileById(AUTH_SHEET_ID).makeCopy('Backup Usuarios ' + dateStr, backupFolder);
  } catch (e) {
    Logger.log('auth spreadsheet backup failed: ' + (e && e.message));
  }

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
