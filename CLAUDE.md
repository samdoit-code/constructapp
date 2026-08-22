# CLAUDE.md — Construtora Moreira App

## 1. Versioning

Versioning

Every time you make a code update or modification to the app, you MUST increment version.json by 1 before considering the task complete.

Example format: {"version": 35} → {"version": 36}

Do this automatically for every code update. Never skip it.

Exception: Do NOT increment the version when the only file being changed is CLAUDE.md.

---

## 1A. Project Overview

**What it is:** A mobile-first business management app for a Brazilian construction company (Construtora Moreira), covering expense tracking (Caixa da Obra), contractor/labor payments (Empreiteiro), tasks, notes, photos, and documents — organized per construction project (e.g., "Obra Gavião", "Obra Boreal").

**Who uses it:** The owner's family/business partners, primarily on iPhone as a home-screen installed PWA, with occasional desktop browser use for administration.

**Production status:** Live and in active use. Hosted on GitHub Pages at `https://samdoit-code.github.io/constructapp/`. Data has been migrated from a manually-maintained Excel spreadsheet (~3,000 historical entries). The app is under active, incremental development — not a finished/frozen product.

**Reusability goal (explicitly established):** This app is intended to become a reusable template/foundation for future internal business apps built on the same stack (HTML/JS → Google Apps Script → Google Sheets + Drive). The authentication/authorization block in particular was deliberately designed to be generic and portable, not app-specific.

---

## 2. Current Tech Stack

- **Frontend:** Single self-contained `construtora_moreira.html` file — HTML/CSS/JS, no framework, no build step, no bundler. All JS is inline in one `<script>` tag wrapped in an IIFE.
- **Backend:** Google Apps Script (`Code.gs`), deployed as a Web App (`doGet`/`doPost`).
- **Database:** Google Sheets — one spreadsheet holds business data (tabs: Projetos, CaixaObra, Empreiteiro, Tarefas, Notas, Fotos, Documentos, Tipos, Unidades). A **separate** spreadsheet holds user/role/permission data (tabs: `Usuarios` for identity, `Papeis` for role capabilities), intentionally isolated from business data for defense-in-depth.
- **File/photo storage:** Google Drive, organized as project-specific subfolders under a parent "Construtora Moreira" folder, plus a `Backups` subfolder for automated daily spreadsheet backups.
- **Authentication:** Google Identity Services (GIS) — the Sign-In/One-Tap API (`google.accounts.id`), not the separate OAuth token-client API.
- **Hosting/deployment:** Frontend on GitHub Pages (static). Backend via Apps Script's own Web App deployment mechanism (URL stays stable across "new version" deploys).
- **Static assets** (logo, generated PWA/iPhone icons, web manifest) live in `/assets`, referenced from `index.html` by relative path. See `assets/README.md` for how the icon set (solid orange background, white logo) and the white header/sign-in logo variant were derived from the original logo. Both a Lottie-based sign-in animation and a follow-up plain-CSS "logo pieces assemble" animation were tried and reverted — neither read well in practice — so the sign-in screen intentionally uses a plain static logo on a flat background. Don't reintroduce motion here without being asked.
- **`apple-mobile-web-app-capable` / `apple-mobile-web-app-status-bar-style` are deliberately NOT set.** They were tried once, changed how iOS computes the safe-area/viewport for the home-screen PWA, and caused a blank gap below the bottom tab bar. Re-test thoroughly on an actual iOS device before reintroducing either.

---

## 2A. Source Control, Branching & Deployment

- **Source control:** Git, hosted on GitHub at `samdoit-code/constructapp`.
- **Production branch:** `main`. Changes intended for production should ultimately be merged into `main`.
- **Development branches:** Claude Code and other development work should normally occur on a branch rather than directly on `main`.
- **Pull requests:** When practical, use a pull request to review significant changes before merging into `main`. Small, explicitly authorized changes may follow the project's established workflow.
- **GitHub is the source of truth:** The repository contains the authoritative frontend and backend source files. Do not treat manually edited production files as the canonical source.
- **Frontend deployment:** GitHub Pages automatically builds/deploys the frontend from the repository.
- **Backend deployment:** `.github/workflows/deploy-backend.yml` automatically deploys the Apps Script backend using Google `clasp` — it both pushes the source (`clasp push`) AND redeploys the live Web App to that new code (`clasp update-deployment`, targeting the one existing deployment so the `/exec` URL never changes). See Section 7 for why the second step matters and isn't optional.
- **Backend deployment trigger:** Changes to `backend/**` pushed to `main` trigger the Apps Script deployment workflow.
- **Frontend and backend deployment are independent:** A frontend-only change should not require an Apps Script deployment, and a backend-only change should not require a frontend deployment.
- **CI/CD:** GitHub Actions is used for automated deployment. Do not manually copy `Code.js` into the Apps Script editor when the change is already committed to the repository.
- **Production:** `main` represents the production-ready source. GitHub Pages and the Apps Script deployment workflow publish the corresponding frontend/backend changes after they reach `main`.
- 
---

## 3. Architecture

### Frontend ↔ Backend communication
- Frontend calls the Apps Script Web App via `fetch()`.
- **Reads and writes are both `POST`**, with `Content-Type: text/plain;charset=utf-8` — **deliberately not `application/json`**, because Apps Script does not handle the CORS preflight that a JSON content-type would trigger. `Code.gs` parses the raw body as JSON manually on its side. Reads (`action=getAll`) used to be a `GET` with `idToken` as a query param; this was changed (see Security below) so the bearer token never travels in a URL. `doGet` is now an intentional no-op — do not resurrect a GET-based read path.
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

### Roles, sections, and actions (established — page/section/action permission model)
Permissions are no longer hardcoded per role in `Code.gs`. Instead, `Code.gs` defines the *shape* of the model and a **`Papeis` tab** (in the same `Usuarios` spreadsheet) holds the actual role capabilities as data.

**⚠️ MAINTENANCE RULE — read before touching any permission-related code or UI:** the tables below (this subsection and "Current permission map") are the authoritative, must-stay-accurate description of every page, every subsection, and what governs each. Whenever a change adds/removes a page, a subsection, a cross-cutting data type, or changes which section governs something, **update these tables and the `installPapeisSheet()` seed in the same piece of work** — not as a follow-up. A stale map here is worse than no map.

**Page vs. section — these are NOT the same thing**, even though for most of this app they coincide 1:1:
- A **section** is the actual unit of permission — `SECTIONS` in `Code.gs` maps each one to the business-data sheet(s) it owns outright: `painel` (none), `lancamentos` (CaixaObra, Empreiteiro), `tarefas` (Tarefas), `notas` (none — see "Cross-cutting sheets" below), `docs` (Documentos only), `config` (Projetos/Tipos/Unidades), `usuarios` (none, reserved).
- A **page** is a nav tab. Most pages are backed by exactly one section of the same name. The one exception: **`painel` embeds a widget summarizing Tarefas data**, and that widget has its OWN section, `painel.tarefas` (a dotted `page.subsection` key) — independent from both `painel` (is the dashboard reachable) and `tarefas` (is Tarefas data/page viewable at all). A role can have either without the other. The widget can never show more than `tarefas`.view already allows; the dotted key only additionally hides an already-authorized widget. **Reusable pattern:** a future dashboard widget for another section is just another `painel.X` key — no new mechanism, no code branch.
- **Action** — `view | create | edit | delete | upload | export`, defined once in `PERMISSION_ACTIONS`. Every section gets all six columns even where most are meaningless for it (e.g. `painel` only ever uses `view`) — deliberately uniform, so nothing special-cases a section's allowed action set.
- **Papeis tab** — columns `role | section | view | create | edit | delete | upload | export` (`SIM`/blank). A `(role, section)` pair with **no row** means every action on that section is denied — deny-by-default falls out of the data itself, not an `if` naming a role or section. There is deliberately **no wildcard row** (e.g. `role | * | ...`) — every role gets one explicit row per section it has any access to, so a brand-new section never gets accidentally auto-granted to an existing role. Run `installPapeisSheet()` once (Apps Script editor, function dropdown) to create and seed this tab; it won't overwrite a tab that already has content, so it's safe to re-run. **Function naming note:** manually-run setup functions in this file must NOT end in a trailing underscore — Apps Script's editor hides any such function from the "Select function" run dropdown (its own convention for "private helper"), which is exactly why `installPapeisSheet`/`flushPermissionCache` don't have one, unlike every other helper in the Authorization block.
- `sectionsForRole_(role)` resolves a role into an explicit `{section: {action: bool}}` object (every known section/action gets a real `true`/`false`, never an implied default) — attached to the user as `user.sections` in `doPost`, right after `getCurrentUser_()`, **not** inside it (see below). `can_(user, section, action)` is the one generic check every enforcement point uses; no role or section name is ever compared by name in code.
- Role names are lowercase internally; the sheet value is lowercased/trimmed on read, so casing in the sheet (`Partner`, `partner`, `PARTNER`) should not matter.

### Cross-cutting sheets: Notas and Fotos (established, non-obvious — read before touching either)
Unlike every other sheet, a single **Notas** or **Fotos** row does not belong to one fixed section — it belongs to whichever section owns its actual parent, and both sheets are rendered **embedded on multiple pages simultaneously**: a task's photo shows inside Tarefas *and* in the Docs gallery; an entry's note shows inside the Lançamentos detail modal *and* in the standalone Notas feed. A blanket "this whole sheet is section X" flag cannot express or enforce that — a role denied `tarefas` but granted `docs` would still receive task-photo rows if Fotos were blanket-owned by `docs` (this was a real gap in an earlier version of this model, closed by the per-row design below).

So both sheets are filtered/authorized **per row**, both for reads and writes:
- `resolveNotaSection_(nota)` / `resolveFotoSection_(foto, notaSectionById)` in `Code.gs` (mirroring the existing `resolveNotaProject_`/`resolveFotoProject_` project-resolution chain) return the section that actually owns a row's parent:
  - Standalone note (no `refTipo`, has `projeto`) → `notas`.
  - Note or photo attached to a Lançamento entry (`refTipo` = `caixa`/`emp`) → `lancamentos`.
  - Photo attached to a task (`refTipo` = `tasks`) → `tarefas`.
  - Photo attached to a note (`refTipo` = `notes`) → a 2-hop lookup: whatever section *that note itself* resolves to (`notas` if standalone, `lancamentos` if it's attached to an entry).
- `filterAllByAccess_()` filters `data.notas`/`data.fotos` row-by-row against `resolveNotaSection_`/`resolveFotoSection_` **before** the generic per-section sheet wipe runs, using project/section indexes built from the **original, unfiltered** read (never from arrays some earlier step already trimmed).
- `assertBatchAccess_()` resolves the section the same way for writes — `sectionForOp_()` special-cases `notas`/`fotos` sheets to call the resolvers instead of the normal `SHEET_TO_SECTION` lookup every other sheet uses.
- `uploadFile` cannot know a row's true parent yet (the Fotos/Documentos row doesn't exist until the follow-up `batchMulti` attaches it) — the frontend sends a `section` hint so a denied role can be stopped before writing to Drive at all, but this is *not* the real security boundary: the subsequent `batchMulti` independently re-resolves the row's actual section from its own `refTipo` and would reject it regardless of what `uploadFile` was told. `deleteFile`, by contrast, has a real existing row to resolve from — it is **fully server-resolved**, no client input trusted at all, same principle as create-vs-edit.
- **Reusable pattern:** if a future data type is similarly embedded across multiple pages, resolve its section per row the same way — never add it to a single section's blanket sheet list.

### Authentication vs. authorization are two separate blocks, on purpose
`getCurrentUser_()` (AUTH BLOCK) returns identity only — `{email, nome, role, projects}` — read live from `Usuarios` on every request, never cached. It has no idea what a role is allowed to do. `user.sections = sectionsForRole_(user.role)` (AUTHORIZATION BLOCK) is attached separately in `doPost()`. Keep this split if either block is touched again: authentication must never depend on authorization, and vice versa.

### Where users/roles are stored
Separate `Usuarios` spreadsheet (not the business-data spreadsheet):
- **`Usuarios` tab** — identity/eligibility only: `email | nome | role | projetos | ativo | criadoEm`. `projetos`: `*` (all projects) or a comma-separated list of exact project names. Deliberately has **no** permission columns — those live in `Papeis` instead, so a permission change is a `Papeis` edit, never a `Usuarios` schema change.
- **`Papeis` tab** — role capabilities, see above.
- `user.sections` is *derived* server-side and sent to the frontend as part of the user object on every `getAll`. The frontend never re-implements role→permission logic; it only renders what the backend says (`currentUser.sections`).

### How section/action permissions are determined and cached
- `filterAllByAccess_()` wipes a section's sheets to empty arrays in the `getAll` response when the user lacks `view` on that section — runs generically over `SECTIONS`, no section name special-cased. (Notas/Fotos are handled separately, per row — see above.)
- `assertBatchAccess_()` rejects a write when an op's section+action isn't permitted, independently of the existing project-scope check, checked server-side regardless of what the frontend UI shows.
- **create vs. edit is resolved from the sheet's own current state** (does this row id already exist?), **never from anything the client claims** — a client mislabeling an edit as a create (or vice versa) cannot use that to dodge a per-action restriction.
- **Established, non-obvious rule:** section/action access and project access are **independent axes**. The section/action check must run unconditionally, even for a user with unrestricted (`'*'`) project access — an early-return for `projects === '*'` must never skip it. (Originally caught as a page-vs-project bug; the same rule now also covers action vs. project — re-verify if this logic is ever touched again.)
- **Permission matrix caching:** `loadPermissionMatrix_()` caches the *role→section→action shape* (from `Papeis`) via `CacheService`, TTL 300s — this is safe because that shape is identical for every user sharing a role. **Never cache a specific user's resolved permissions or identity** — `getCurrentUser_()` stays uncached so a role/`ativo` change on one user takes effect on their very next request. Any cache/read failure falls back to an **empty matrix — fail closed**, not open. Run `flushPermissionCache()` after hand-editing `Papeis` if you don't want to wait out the TTL.
- Frontend: nav buttons are hidden based on `currentUser.sections[section].view` (via a `VIEW_ACCESS` map of view name → `{section, actions}`, supporting an "any of these actions" check — needed because the Lançamentos "add" tab requires `create` OR `edit`, since the same form serves both), **and** `switchView()` itself refuses to activate a disallowed page. Write-affordances within a page (add/edit/delete buttons, photo/document upload inputs, per-item note/photo edit-delete controls) are likewise hidden via a generic `canSection(section, action)` helper (`applySectionUIAccess()` for static elements; inline checks inside render functions for dynamically-generated lists like the Notas feed or Docs gallery, since each row/category can have a different owning section) — reusing the same pages/components, never a role-specific duplicate view. All of this is still just a courtesy; the backend is the real authority.
- **Reusable pattern for future apps on this stack:** to add a genuinely new restricted section (not just a new role), add it to `SECTIONS` (and `VIEW_FILTERED_SECTIONS` if it should gate a nav page's data), add `Papeis` rows granting it to the roles that should have it, and — if it's a page — a `VIEW_ACCESS` entry on the frontend. No existing role's code path needs to change. If it's a dashboard-style widget rather than a full page, add a `painel.X`-style dotted key instead.

### Current permission map (keep in sync — see maintenance rule above)

| Page (nav) | Own section | Embedded subsection(s) | Notes |
|---|---|---|---|
| painel (dashboard) | `painel` (view only) | `painel.tarefas` (Tarefas widget + count) | Stat cards + "Últimos lançamentos" draw from `lancamentos` (no separate flag — tying that widget to `lancamentos`.view was judged sufficient, no independent flag needed today). |
| entries/add (Lançamentos) | `lancamentos` | notes thread + photos in the entry detail/edit modal | Both governed by `lancamentos`, not `notas`/`docs` — see "Cross-cutting sheets". |
| tasks (Tarefas) | `tarefas` | task photos | |
| notes (Notas) | `notas` | — | The feed itself is a union of standalone notes (`notas`) and notes attached to a Lançamento (governed by `lancamentos`, shown here too) — permission is resolved per item, not once for the page. |
| docs (Documentos) | `docs` (Documentos only) | photo gallery grouped by source: caixa/emp → `lancamentos`, tasks → `tarefas`, notes → `notas` | Each category's view AND delete rights come from its owning section, not `docs` — a role with `docs`.view but no `tarefas` access sees zero task photos here, automatically, because the backend already withheld that data. |
| (settings modal, no nav tab) | `config` (Projetos/Tipos/Unidades) | — | No subsections — kept as one section deliberately, see Section 9. |
| (none yet) | `usuarios` | — | Reserved for a future user-management screen. |

### Session behavior (iOS/PWA-specific, established through direct investigation)
- **Home-screen PWA (standalone mode) cannot silently restore a session on a fresh launch.** A standalone PWA runs in a WKWebView with a storage partition fully separate from Safari — there is no shared Google session for `google.accounts.id.prompt()` to find, regardless of how recently the user signed in within the PWA previously. This is a confirmed platform limitation, not a bug, and is not fixable via GIS configuration.
- The app detects standalone mode (`display-mode: standalone` / `navigator.standalone`) and **skips** the silent-restore attempt there entirely — showing the sign-in button immediately rather than a "Restaurando sessão..." message that could never succeed.
- In a regular (non-standalone) browser tab, silent restore via `prompt()` **is** attempted when a fresh session hint exists, since that context can share a real Google session.
- **Proactive token refresh on foreground return:** a `visibilitychange` listener checks token age when the app becomes visible again; if older than 45 minutes (Google ID tokens last ~1 hour, not app-configurable), it attempts a silent `prompt()` before the user's next action would otherwise fail. Whether this reliably succeeds in practice on real iOS depends on live Google session state that could not be verified from a sandboxed environment — this should be treated as "implemented and reasoned through" but **not** as "confirmed working end-to-end on device."
- `google.accounts.id.prompt()` should never be called unconditionally on every load — doing so previously caused an unwanted One Tap popup for every visitor, including first-time users with no session to restore. It should only be called when there's a specific reason to believe a restore might succeed.

### Formerly-open issue: role change not taking visible effect (superseded)
A user once changed their `Usuarios` row `role` to `Partner` and refreshed, but the app still showed all pages/tabs; the investigation was never fully completed on the old `ROLES`/`pages` model. That entire model (`ROLES` object, `currentUser.pages`, `PAGE_SHEETS`) has since been replaced by the section/action permission model in Section 4 (`Papeis` tab, `currentUser.sections`, `SECTIONS`) — so the specific code paths named in the old investigation no longer exist. If a similar symptom (role change not taking effect) recurs under the new model, first check: the deployed Apps Script is genuinely running the latest `Code.gs` (see Section 7 — this project has a strong recurring history of bugs traced back to an edit being saved but not deployed as a "new version"); then whether `Papeis` actually has a row for that role+section; then the `flushPermissionCache()` / 5-minute TTL on the (role-shape-only, never per-user) permission cache — note `getCurrentUser_()` itself is never cached, so this narrows to the `Papeis` matrix specifically.

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
Separate spreadsheet, two tabs — see Section 4:
- **Usuarios**: `email, nome, role, projetos, ativo, criadoEm`.
- **Papeis**: `role, section, view, create, edit, delete, upload, export` — role capability matrix.

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
- **Every value interpolated into an `innerHTML` template must go through `escapeHTML()`** — including URLs built from sheet data (e.g. a Drive-derived photo `src`), not just visible text. A URL/attribute value is exactly as capable of breaking out of its attribute as any other string; an audit found one such gap (an unescaped photo `src`) that has since been fixed. `window.open()` targets built from sheet data (`driveUrl`, etc.) should also go through a protocol allowlist (see `openSafeUrl()`), not be passed straight through.

---

## 7. Backend Rules

- **Every `doGet`/`doPost` must authenticate first** via `getCurrentUser_()` before touching any data. No action should read or write before this succeeds.
- **Error responses must use `err.message`, not `String(err)`.** `String()` on a real `Error` object prepends `"Error: "`, which silently breaks the frontend's exact-string matching between auth errors, permission errors, and generic errors. This was a real, previously-shipped bug — do not reintroduce it.
- **Row-level writes:** identify the target row by `id` in column A; update in place if found, append if not. Never rewrite an entire tab for a single-row change on the row-level tabs listed in Section 5.
- **Conflict handling:** check every row in a batch for a stale `lastModified` **before** writing anything in that batch (all-or-nothing), not after partial writes.
- **Concurrency:** `doPost` is wrapped in `LockService.getScriptLock()` to prevent simultaneous requests from interleaving badly.
- **Backups:** a time-based trigger (`installDailyBackupTrigger`, run once manually to install) copies the business-data spreadsheet daily into a `Backups` folder in Drive, pruning copies older than 30 days. This must be manually re-installed if ever removed — it is not automatic on deploy.
- **Deployment discipline:** neither editing `Code.gs` in the script editor NOR pushing to `backend/**` on `main` takes effect for the live Web App on its own — `clasp push` (or a manual editor save) only updates the script project's *source*; the `/exec` URL keeps serving whatever deployment version it was last pointed at until that deployment is explicitly redeployed to the new version. This exact gap — source updated, live URL still serving old code — has been the root cause of multiple confusing bugs in this project's history, including a real outage where a security fix's frontend half went live but the backend half didn't, breaking login for everyone. `deploy-backend.yml` now automates the redeploy step too (`clasp update-deployment` against the one existing deployment, right after `clasp push`), so a push to `main` alone is sufficient again — but if a change is ever made by hand directly in the Apps Script editor instead of through a commit, it still needs a manual redeploy (Deploy → Manage deployments → Edit existing deployment → "New version" → Deploy). Always suspect this first when backend changes don't seem to take effect, especially after any manual editor changes.
- **OAuth scopes:** the script needs `spreadsheets`, `drive`, `script.external_request` (for `UrlFetchApp` calls to verify tokens), and `userinfo.email`. If these are not explicitly declared in `appsscript.json`'s `oauthScopes`, Apps Script's automatic scope detection has previously been unreliable across edits — explicit declaration is safer. **NEEDS VERIFICATION:** whether `oauthScopes` is currently explicitly declared in the live `appsscript.json` or still relying on auto-detection.

### Security practices established (from a full security audit; reusable in future apps on this stack)
- **Reads never go over GET.** A bearer `idToken` must never travel in a URL/query string (server logs, browser history, proxies can all capture it) — `getAll` is `POST`, same as writes. `doGet` is kept only because Apps Script requires it to exist; it must stay an inert no-op, not a second read path.
- **Every free-text value written to a sheet cell is run through `sanitizeCell_()`** (prefixes a value starting with `=+-@` with a leading apostrophe) before `setValues()`. Without this, a value planted through the write API becomes a live formula the moment anyone opens the sheet directly or exports it — a real CSV/formula-injection vector, not hypothetical.
- **A whole-tab "clear and replace" write (`writeSheet_`) must never be used for data that is also access-scoped** (i.e. anything `hasProjectAccess_` filters). A project-scoped user's in-memory copy only ever contains what they're allowed to see, so replacing the whole tab with it silently deletes everything else. `saveProjetos_` is the pattern to copy: preserve out-of-scope rows, only replace the caller's own subset. `Tipos`/`Unidades` are fine to whole-tab-replace because they are genuinely shared, not access-scoped.
- **Any action that operates on a raw Drive `fileId` from the client (e.g. `deleteFile`) must first confirm that ID is one this app actually issued** (present in `Fotos`/`Documentos`), before touching it via `DriveApp`. Because the script runs `executeAs: USER_DEPLOYING`, an unchecked fileId can reach anything that Google account can access — not just this app's own files.

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
- **Section/action permissions are role-based, not per-user.** All users sharing a role (e.g., all `partner` users) get identical `Papeis` capabilities. Per-user customization would require a new per-user override, layered on top of `sectionsForRole_()` — not currently supported, no current requirement for it.
- **`deleteFile` (Drive) has no project-level authorization check.** It only receives a `fileId`; it IS gated on the `docs`/`delete` action via `can_()`, but not on which project the file belongs to. The only role that would need a project-level check here (`partner`) has no delete rights on `docs` at all today, so this was judged an acceptable, deliberate scope boundary — not an oversight. Worth adding a project check if a future project-scoped role ever gets `docs`/`delete`.
- **Entry-attached notes are the one nested feature requiring the two-tab (Notas ↔ parent entry) resolution logic described in Section 5** — any future data model change touching Notas or Fotos should account for this union/multi-hop structure rather than assuming a flat 1:1 relationship.

---

## 10. Current Project State

**Implemented and working:**
- Full CRUD for lançamentos (Caixa da Obra + Empreiteiro), tasks, notes (standalone + attached), photos, and documents.
- Google Sheets + Drive backend via Apps Script, replacing an earlier `window.storage`-based approach entirely.
- Row-level writes with conflict detection, locking, and daily backups.
- Google Sign-In authentication with backend-verified ID tokens.
- Two-axis authorization: project-level and section/action-level (role capabilities data-driven via the `Papeis` tab), both enforced server-side, independently of each other.
- Session-restoration UX tuned specifically for iOS PWA constraints (session hint, standalone detection, proactive foreground-return refresh).
- Cache-first loading, offline-tolerant reads, clear-fail writes, retry logic for transient network errors.
- App-version update-check banner (dismissible, never forces a reload).
- Pagination throughout (Entries, Tasks, Notes, Docs, Fotos) — stress-tested at ~3,000-entry scale.
- Mobile-focused UI polish pass (typography, shadows, transitions) — token-level, no layout changes.

**Not yet implemented / open work:**
- Private Drive file sharing (Section 9) — designed but not built.
- Per-user (rather than per-role) permission customization — not built, no current requirement for it.
- A user-management UI (the `usuarios` section in `Papeis`/`SECTIONS` is reserved for this but nothing reads/writes it yet).

---

## 11. CLAUDE.md Maintenance

Keep `CLAUDE.md` up to date. When a code change introduces or changes an important:

- Architecture decision
- Workflow or convention
- Security rule
- Development instruction
- Pattern or practice that should be replicated as a foundation for future apps

...update `CLAUDE.md` accordingly, in the same piece of work that makes the change (not as a separate follow-up to remember later).

Do not update it for trivial implementation changes or app-specific details that have no future value.

**Standing rule, permissions specifically:** any change to permission-related code or UI — a new page, a new subsection/widget, a new cross-cutting data type, or a change to which section governs something — must update, in the same piece of work: the "Current permission map" table and the `SECTIONS`/`VIEW_FILTERED_SECTIONS` description in Section 4, and the `installPapeisSheet()` seed data in `Code.js` if the set of valid `(role, section)` keys changed. The permission map is only useful if it's never allowed to drift from what the code actually enforces.
