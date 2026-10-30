# Moving the app to its own web address

**Why:** browser storage belongs to the *origin* (`https://host`), not the
folder. Every GitHub Pages site under one account shares
`https://samdoit-code.github.io`, so any other app published there could read
this app's stored data and its login (app session) code. Each app must have its
own address. Required before a second app goes live under this account.

**Nothing in the app's code depends on the address** — every path is relative,
and the backend, spreadsheets, Drive and deploys are unaffected.

## Checklist (in this order)

1. **Get the address.** A subdomain on a domain you own, e.g.
   `obra.seudominio.com.br`. At the registrar, add a `CNAME` record pointing
   that subdomain to `samdoit-code.github.io`.
2. **Allow it for Google sign-in.** Google Cloud Console → APIs & Services →
   Credentials → the app's OAuth client → *Authorized JavaScript origins* → add
   `https://obra.seudominio.com.br`. **Keep the old origin** until the move is done.
3. **Make sure no phone has anything unsent.** On every device, open the app
   online and check the activity pill shows nothing pending (no unsent changes,
   no photos uploading). This is the one real risk: once GitHub redirects the
   old address, the old copy on a phone can no longer be opened, and anything
   it had not sent is stranded there.
4. **Switch.** Add a file named `CNAME` at the repo root containing only the
   new hostname, push to `main`, then in GitHub → Settings → Pages tick
   *Enforce HTTPS* once the certificate is issued (minutes to a few hours).
5. **Reinstall on each phone.** Delete the old home-screen icon, open the new
   address in Safari, *Add to Home Screen*, sign in with Google once. All data
   comes down from the spreadsheet in one sync.
6. **Tidy up.** Remove the old origin from the OAuth client, update the
   address in `CLAUDE.md` (Section 1A), bump `version.json`.

**For a brand-new app:** give it its own address and its own OAuth client from
day one — then none of this applies.
