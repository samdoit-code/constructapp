# CLAUDE.md — Construtora Moreira App

## 1. Project Overview

**What it is:** A mobile-first business management app for a Brazilian construction company (Construtora Moreira), covering expense tracking (Caixa da Obra), contractor/labor payments (Empreiteiro), tasks, notes, photos, and documents — organized per construction project (e.g., "Obra Gavião", "Obra Boreal").

**Who uses it:** The owner's family/business partners, primarily on iPhone as a home-screen installed PWA, with occasional desktop browser use for administration.

**Production status:** Live and in active use. Hosted on GitHub Pages at `https://samdoit-code.github.io/constructapp/`. Data has been migrated from a manually-maintained Excel spreadsheet (~3,000 historical entries). The app is under active, incremental development — not a finished/frozen product.

**Reusability goal (explicitly established):** This app is intended to become a reusable template/foundation for future internal business apps built on the same stack (HTML/JS → Google Apps Script → Google Sheets + Drive). The authentication/authorization block in particular was deliberately designed to be generic and portable, not app-specific.

---

## 2. Current Tech Stack

- **Frontend:** Single self-contained `construtora_moreira.html` file — HTML/CSS/JS, no framework, no build step, no bundler. All JS is inline in one `<script>` tag wrapped in an IIFE.
- **Backend:** Google Apps Script (`Code.gs`), deployed as a Web App (`doGet`/`doPost`).
- **Database:** Google Sheets — one spreadsheet holds business data (tabs: Projetos, CaixaObra, Empreiteiro, Tarefas, Notas, Fotos, Documentos, Tipos, Unidades). A **separate** spreadsheet (`Usuarios`) holds user/role/permission data, intentionally isolated from business data for defense-in-depth.
- **File/photo storage:** Google Drive, organized as project-specific subfolders under a parent "Construtora Moreira" folder, plus a `Backups` subfolder for automated daily spreadsheet backups.
- **Authentication:** Google Identity Services (GIS) — the Sign-In/One-Tap API (`google.accounts.id`), not the separate OAuth token-client API.
- **Hosting/deployment:** Frontend on GitHub Pages (static). Backend via Apps Script's own Web App deployment mechanism (URL stays stable across "new version" deploys).

---

## 2A. Source Control, Branching & Deployment

- **Source control:** Git, hosted on GitHub at `samdoit-code/constructapp`.
- **Production branch:** `main`. Changes intended for production should ultimately be merged into `main`.
- **Development branches:** Claude Code and other development work should normally occur on a branch rather than directly on `main`.
- **Pull requests:** When practical, use a pull request to review significant changes before merging into `main`. Small, explicitly authorized changes may follow the project's established workflow.
- **GitHub is the source of truth:** The repository contains the authoritative frontend and backend source files. Do not treat manually edited production files as the canonical source.
- **Frontend deployment:** GitHub Pages automatically builds/deploys the frontend from the repository.
- **Backend deployment:** `.github/workflows/deploy-backend.yml` automatically deploys the Apps Script backend using Google `clasp`.
- **Backend deployment trigger:** Changes to `backend/**` pushed to `main` trigger the Apps Script deployment workflow.
- **Frontend and backend deployment are independent:** A frontend-only change should not require an Apps Script deployment, and a backend-only change should not require a frontend deployment.
- **CI/CD:** GitHub Actions is used for automated deployment. Do not manually copy `Code.js` into the Apps Script editor when the change is already committed to the repository.
- **Production:** `main` represents the production-ready source. GitHub Pages and the Apps Script deployment workflow publish the corresponding frontend/backend changes after they reach `main`.
- 
---

## 3. Architecture

### Frontend ↔ Backend communication
- Frontend calls the Apps Script Web App via `fetch()`.
- **Reads:** `GET ?action=getAll` (plus an `idToken` query param). Simple request, no CORS preflight.
- **Writes:** `POST` with `Content-Type: text/plain;charset=utf-8` — **deliberately not `application/json`**, because Apps Script does not handle the CORS preflight that a JSON content-type would trigger. `Code.gs` parses the raw body as JSON manually on its side.
- The Apps Script Web App URL and `GOOGLE_CLIENT_ID` are configured as constants near the top of the frontend `<script>` and near the top of `Code.gs`. They must match exactly between the two files (case-sensitive, no typos) — a mismatch was the root cause of a real production auth failure once already.

### Apps Script ↔ Sheets/Drive
- `Code.gs` is a **container-bound** script (opened via Extensions → Apps Script from inside the business-data spreadsheet), so it accesses that spreadsheet via `SpreadsheetApp.getActiveSpreadsheet()` with no explicit ID needed.
- The **separate** `Usuarios` auth spreadsheet is accessed via `SpreadsheetApp.openById(AUTH_SHEET_ID)` — a different spreadsheet than the one the script lives in.
- Drive files are currently uploaded with `DriveApp.Access.ANYONE_WITH_LINK` / `Permission.VIEW` sharing (see Known Limitations — this is an accepted, flagged, not-yet-fixed gap, not an oversight).

### Data flow (frontend)
- **Cache-first load:** on boot, the app renders instantly from a `localStorage` cache (`cmoreira_cache_v1`) if present, then refreshes from the server in the background and re-renders. First-ever load (no cache) or the *initial sign-in* specifically waits on a real network response — cache is never trusted to satisfy the initial auth check.
- **Row-level writes with diffing:** the app keeps an in-memory snapshot (`sheetSnapshot`) of what was last synced per tab. Saves diff the current state against that snapshot and send only the changed/deleted rows (via a `batchMulti` action), not a whole-tab rewrite. This is wrapped behind a stable `saveKey(key, value)` function used by ~30 call sites throughout the app — call sites never changed when the underlying sync mechanism was rewritten from whole-tab to row-level.
- **Conflict detection:** row-level tabs carry a `lastModified` timestamp. A write includes the `expectedLastModified` it last saw; the backend rejects (all-or-nothing per batch) if the current value doesn't match, meaning someone else edited that row in the meantime.
- **Notas/Fotos are "computed union" tabs**, not simple 1:1 arrays: they contain both standalone records and records attached to a parent (an entry, a task, or — for a photo — sometimes a note that is itself attached to an entry). Resolving "what project does this row belong to" requires walking that chain (see Data Structure below).

### Important architectural decisions already made
- `window.storage` (an earlier, Claude-artifact-specific storage mechanism) was **fully removed** early in this project's history in favor of the Sheets/Drive backend — this was a deliberate migration, not leftover cruft to "clean up."
- IndexedDB was tried and **rejected** for photo storage (blocked by desktop browsers' third-party-iframe storage restrictions in some contexts) in favor of routing photo/doc blobs through the same `window.storage`-style mechanism, which was itself later superseded by Drive upload once the Sheets/Drive backend was built.
- A shared-secret query-param scheme (`SHARED_SECRET`) was the **original** auth mechanism and has been **fully replaced** by real Google Sign-In + backend token verification. No trace of it should remain in either file.

---

## 4. Authentication & Permissions

### How users are authenticated
- Google Identity Services issues a signed ID token client-side after Sign-In/One-Tap.
- The token is sent with **every** request (`idToken` param) and is **verified independently by the backend on every single request** via `verifyIdToken_()`, which calls Google's `tokeninfo` endpoint and checks: token validity, `aud` matches `GOOGLE_CLIENT_ID`, and `email_verified`.
- The verified email is then looked up in the `Usuarios` sheet by `getCurrentUser_()`. Unknown or deactivated (`ativo` ≠ SIM) users are rejected.
- **Critical established principle:** hiding UI elements is a courtesy only. All real enforcement happens server-side, on every `doGet`/`doPost`, independent of what the frontend shows or hides.

### Session/token storage rules (established, must not be violated)
- The raw Google ID token is held **only in an in-memory JS variable** (`googleIdToken`), never written to `localStorage` or any persistent storage.
- A lightweight **session hint** (`cmoreira_session_hint` in `localStorage`) stores only `{email, timestamp}` — never the token. It is a UI hint only ("should I attempt a silent restore on load?"), never treated as proof of authentication. Real access always requires the backend to independently re-verify a fresh token.

### Roles (established, exactly three)
Defined in a `ROLES` config object in `Code.gs`:
- `admin` — `manageUsers: true, write: true, pages: '*'`
- `owner` — `manageUsers: false, write: true, pages: '*'`
- `partner` — `manageUsers: false, write: false, pages: ['painel', 'lancamentos', 'docs']`

Role names are lowercase internally; the sheet value is lowercased/trimmed on read, so casing in the sheet (`Partner`, `partner`, `PARTNER`) should not matter.

### Where users/roles are stored
Separate `Usuarios` spreadsheet (not the business-data spreadsheet), single tab, columns:
`email | nome | role | projetos | ativo | criadoEm`

- `projetos`: `*` (all projects) or a comma-separated list of exact project names.
- `pages` is **not** a column in `Usuarios` — it is *derived* from `role` via the `ROLES` config and resolved server-side in `getCurrentUser_()`, then sent to the frontend as part of the user object. The frontend never re-implements role→pages logic; it only renders what the backend says.

### How page permissions are determined
- `PAGE_SHEETS` in `Code.gs` maps each page name (`painel`, `lancamentos`, `tarefas`, `notas`, `docs`) to the sheet(s) that belong to it.
- `filterAllByAccess_()` wipes disallowed pages' sheets to empty arrays in the `getAll` response.
- `assertBatchProjectAccess_()` rejects writes to sheets outside the user's allowed pages (via a `SHEET_TO_PAGE` reverse map), checked server-side regardless of what the frontend UI shows.
- **Established, non-obvious rule:** page access and project access are **independent axes**. The page check must run unconditionally, even for a user with unrestricted (`'*'`) project access — an early-return for `projects === '*'` must never skip the page check. (This was caught as a real bug during implementation and fixed; worth re-verifying if this logic is ever touched again.)
- Frontend: nav buttons are hidden based on `currentUser.pages`, **and** `switchView()` itself refuses to activate a disallowed page — guarding against both a hidden-button bypass and a direct function-call bypass. This is still just a courtesy; the backend is the real authority.

### Session behavior (iOS/PWA-specific, established through direct investigation)
- **Home-screen PWA (standalone mode) cannot silently restore a session on a fresh launch.** A standalone PWA runs in a WKWebView with a storage partition fully separate from Safari — there is no shared Google session for `google.accounts.id.prompt()` to find, regardless of how recently the user signed in within the PWA previously. This is a confirmed platform limitation, not a bug, and is not fixable via GIS configuration.
- The app detects standalone mode (`display-mode: standalone` / `navigator.standalone`) and **skips** the silent-restore attempt there entirely — showing the sign-in button immediately rather than a "Restaurando sessão..." message that could never succeed.
- In a regular (non-standalone) browser tab, silent restore via `prompt()` **is** attempted when a fresh session hint exists, since that context can share a real Google session.
- **Proactive token refresh on foreground return:** a `visibilitychange` listener checks token age when the app becomes visible again; if older than 45 minutes (Google ID tokens last ~1 hour, not app-configurable), it attempts a silent `prompt()` before the user's next action would otherwise fail. Whether this reliably succeeds in practice on real iOS depends on live Google session state that could not be verified from a sandboxed environment — this should be treated as "implemented and reasoned through" but **not** as "confirmed working end-to-end on device."
- `google.accounts.id.prompt()` should never be called unconditionally on every load — doing so previously caused an unwanted One Tap popup for every visitor, including first-time users with no session to restore. It should only be called when there's a specific reason to believe a restore might succeed.

### Known open issue (unresolved as of end of this conversation)
A user changed their `Usuarios` row `role` to `Partner` and refreshed, but the app still showed all pages/tabs. An investigation was requested and only partially completed:
- ✅ Checked: role parsing in `getCurrentUser_()` — confirmed it does `.toLowerCase().trim()`, so `"Partner"` → `"partner"` should normalize correctly. This specific step is not the bug.
- ❌ **NEEDS VERIFICATION:** what `currentUser.pages` the backend actually returns for this user in practice.
- ❌ **NEEDS VERIFICATION:** whether the deployed Apps Script is genuinely running the latest `Code.gs` (this project has a strong recurring history of bugs traced back to an edit being saved but not deployed as a "new version" — this should be checked early, not last).
- ❌ **NEEDS VERIFICATION:** whether `finishLoadSetup()` on the frontend is receiving and correctly applying `currentUser.pages`.
- ❌ **NEEDS VERIFICATION:** whether the frontend's page-name strings (`painel`, `lancamentos`, etc.) exactly match what the backend sends.

This should be the first thing investigated when work resumes.

---

## 5. Data Structure

### Business data spreadsheet (tabs and key columns)
- **Projetos:** `id, ativo` — `id` **is** the project's display name (e.g., "Obra Gavião"), used directly as the foreign key everywhere else. Renaming a project requires cascading the update to every referencing row (already implemented).
- **CaixaObra:** `id, projeto, data, nome, tipo, qtd, unidade, valor, fornecedor, socio, criadoEm, lastModified`
- **Empreiteiro:** same shape as CaixaObra, minus `tipo`.
- **Tarefas:** `id, projeto, texto, prazo, prioridade, feito, criadoEm, lastModified`
- **Notas:** `id, projeto, texto, criadoEm, refTipo, refId, lastModified` — a **union** of standalone notes (`projeto` filled, `refTipo`/`refId` blank) and notes attached to an entry (`refTipo` = `caixa`/`emp`, `refId` = the entry's id, `projeto` blank/implied).
- **Fotos:** `id, refTipo, refId, driveFileId, driveUrl, criadoEm, lastModified` — `refTipo` can be `caixa`, `emp`, `tasks`, or `notes` (a photo can be attached to a note, which may itself be attached to an entry — a two-hop chain).
- **Documentos:** `id, projeto, nome, mimeType, driveFileId, driveUrl, criadoEm, lastModified`
- **Tipos:** `tipo` (single column, expense category reference list).
- **Unidades:** `unidade` (single column, unit-of-measure reference list).

### Row-level vs. whole-tab tabs
- **Row-level (support upsert/delete + `lastModified` conflict detection):** CaixaObra, Empreiteiro, Tarefas, Notas, Fotos, Documentos.
- **Whole-tab replace (simpler, no conflict tracking — small reference lists, rarely concurrently edited):** Projetos, Tipos, Unidades.

### Auth spreadsheet
**Usuarios** (separate spreadsheet): `email, nome, role, projetos, ativo, criadoEm` — see Section 4.

### Relationships worth knowing
- Determining which project a Nota or Foto belongs to requires resolving through `refTipo`/`refId`, potentially two hops deep (photo → note → entry). This logic lives in `buildEntryProjectIndex_`, `resolveNotaProject_`, `resolveFotoProject_` in `Code.gs` and is duplicated conceptually (not literally) on the frontend for local state reconstruction after a `getAll` fetch.

---

## 6. Frontend/UI Rules

- **Mobile-first, iPhone home-screen PWA is the primary target.** Desktop browser support matters but is secondary.
- **Fixed header pattern:** the topbar is `position:fixed` (not `sticky`) specifically to prevent iOS's rubber-band overscroll from revealing a gap above it; the page background is dark (matching the header) as a fallback in case any edge case still exposes space. Content below is offset by a JS-measured header height (`ResizeObserver`), not a hardcoded padding value.
- **Date fields** use a "fake formatted display + invisible native `<input type=date>`" pattern (for custom `dd/mm/aaaa` formatting). On desktop browsers, the invisible native calendar icon must be triggered via `showPicker()` on click — tapping alone only works natively on iOS.
- **Empty states have no icon** — a "+" icon was previously used and removed because it visually read as a tappable button when it wasn't one.
- **Sort default for Lançamentos is most-recent-first**, using the underlying Google Sheet's row order as the tiebreaker (not `criadoEm`) — `criadoEm` is not a meaningful signal for rows typed directly into the sheet by hand, since they can all get stamped with nearly the same value on first read.
- **Multi-file selection is supported** on all photo/document upload inputs (7 total across the app) — each processes and uploads every selected file, with a combined success/partial-failure message.
- **No manual zoom buttons** on photo/PDF viewers (removed per explicit request) — the underlying zoom-reset-on-open mechanism was kept, just not exposed via visible +/− controls.
- **Visual design system:** a small set of CSS custom properties (`--shadow`, `--shadow-hover`, `--ease`) drive card elevation and transition timing app-wide. Changes to these tokens cascade broadly — prefer adjusting the token over one-off overrides.
- **Things established as intentional, not to be "fixed" without asking:** the tactile 3D press-down style on the primary button; the dark, minimal sign-in gate; pagination page sizes (see below) chosen deliberately for performance at scale.

---

## 7. Backend Rules

- **Every `doGet`/`doPost` must authenticate first** via `getCurrentUser_()` before touching any data. No action should read or write before this succeeds.
- **Error responses must use `err.message`, not `String(err)`.** `String()` on a real `Error` object prepends `"Error: "`, which silently breaks the frontend's exact-string matching between auth errors, permission errors, and generic errors. This was a real, previously-shipped bug — do not reintroduce it.
- **Row-level writes:** identify the target row by `id` in column A; update in place if found, append if not. Never rewrite an entire tab for a single-row change on the row-level tabs listed in Section 5.
- **Conflict handling:** check every row in a batch for a stale `lastModified` **before** writing anything in that batch (all-or-nothing), not after partial writes.
- **Concurrency:** `doPost` is wrapped in `LockService.getScriptLock()` to prevent simultaneous requests from interleaving badly.
- **Backups:** a time-based trigger (`installDailyBackupTrigger`, run once manually to install) copies the business-data spreadsheet daily into a `Backups` folder in Drive, pruning copies older than 30 days. This must be manually re-installed if ever removed — it is not automatic on deploy.
- **Deployment discipline:** editing `Code.gs` in the script editor does **not** take effect for the live Web App until explicitly redeployed (Deploy → Manage deployments → Edit existing deployment → "New version" → Deploy). This exact step has been the root cause of multiple confusing bugs in this project's history — always suspect this first when backend changes don't seem to take effect.
- **OAuth scopes:** the script needs `spreadsheets`, `drive`, `script.external_request` (for `UrlFetchApp` calls to verify tokens), and `userinfo.email`. If these are not explicitly declared in `appsscript.json`'s `oauthScopes`, Apps Script's automatic scope detection has previously been unreliable across edits — explicit declaration is safer. **NEEDS VERIFICATION:** whether `oauthScopes` is currently explicitly declared in the live `appsscript.json` or still relying on auto-detection.

---

## 8. Development Rules

- Preserve the existing architecture unless an architectural change is explicitly requested.
- Prefer the smallest change that solves the requested problem.
- Do not modify unrelated code.
- Do not introduce frameworks, dependencies, databases, or infrastructure unless explicitly requested.
- Do not create unnecessary tests or abstractions.
- When something is unclear, inspect the existing code rather than guessing.
- Before making significant architectural or authentication changes, explain the proposed change first and wait for confirmation.
- For investigation/debugging requests, investigate first and do **not** modify code unless explicitly told to.

### Token-efficient editing
- Before reading a large file, search for the specific code relevant to the requested change when practical.
- Read only the necessary surrounding context unless the task requires understanding the broader architecture.
- For localized changes, prefer targeted edits/replacements over rewriting or rereading the entire file.
- Use exact, sufficiently unique strings for targeted replacements to avoid unintended changes.
- Batch related changes into a single operation when practical.
- Avoid unnecessary file exploration, verbose explanations, redundant verification, or rebuilding code that doesn't need to change.
- For simple CSS/text/localized UI changes, don't reread the entire frontend file unless genuinely needed.
- For new features, architecture, authentication, backend changes, debugging, or ambiguous situations, prioritize understanding context correctly over saving tokens.
- Never sacrifice correctness or safety merely to reduce token usage.

---

## 9. Known Limitations / Important Decisions

- **Drive files are currently shared as `ANYONE_WITH_LINK` (view-only), not private.** This was explicitly identified as a security gap. A fix was designed (per-project `addViewer()`/domain-restricted sharing synced automatically with `Usuarios` role/project changes, with a manual "reconcile now" function rather than a scheduled job) but **not implemented**. Anyone possessing a direct file link can currently view it without going through the app's auth at all.
- **iOS standalone PWA cannot silently restore a session on a fresh (fully-closed) launch** — this is a confirmed platform limitation (separate WKWebView storage partition from Safari), not something fixable in this app's code. The app is designed to fail gracefully here (show the button immediately) rather than pretend otherwise.
- **Page permissions are role-based, not per-user.** All users sharing a role (e.g., all `partner` users) get identical page access. Per-user page customization would require a new column in `Usuarios` (analogous to how `projetos` already works) and is not currently supported.
- **`deleteFile` (Drive) has no project-level authorization check.** It only receives a `fileId`; the only role that would need this check (`partner`) is already blocked earlier by the write-role gate, so this was judged an acceptable, deliberate scope boundary — not an oversight.
- **Entry-attached notes are the one nested feature requiring the two-tab (Notas ↔ parent entry) resolution logic described in Section 5** — any future data model change touching Notas or Fotos should account for this union/multi-hop structure rather than assuming a flat 1:1 relationship.

---

## 10. Current Project State

**Implemented and working:**
- Full CRUD for lançamentos (Caixa da Obra + Empreiteiro), tasks, notes (standalone + attached), photos, and documents.
- Google Sheets + Drive backend via Apps Script, replacing an earlier `window.storage`-based approach entirely.
- Row-level writes with conflict detection, locking, and daily backups.
- Google Sign-In authentication with backend-verified ID tokens.
- Two-axis authorization: project-level and page-level, both enforced server-side.
- Session-restoration UX tuned specifically for iOS PWA constraints (session hint, standalone detection, proactive foreground-return refresh).
- Cache-first loading, offline-tolerant reads, clear-fail writes, retry logic for transient network errors.
- App-version update-check banner (dismissible, never forces a reload).
- Pagination throughout (Entries, Tasks, Notes, Docs, Fotos) — stress-tested at ~3,000-entry scale.
- Mobile-focused UI polish pass (typography, shadows, transitions) — token-level, no layout changes.

**Not yet implemented / open work:**
- The open page-permissions bug described in Section 4 (role change not taking visible effect) — **investigate before any new feature work on the permissions system.**
- Private Drive file sharing (Section 9) — designed but not built.
- Per-user (rather than per-role) page permission customization — not built, no current requirement for it.
