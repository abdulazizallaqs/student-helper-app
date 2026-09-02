# Pre-release audit — Student Helper

Run before publishing to GitHub and deploying. Everything below was verified
against the running application, not inferred from reading code.

**Result: 265 automated tests pass, 0 dependency vulnerabilities, 4 security
holes found and closed, 1 privacy problem in git history that you must fix by
hand, and Vercel will not run this app.**

---

## 1. Do these before you push — in this order

### 1.1 Rotate the Gemini API key. It was about to be published.

`.env.example` contained a real, working-format key:

```
GEMINI_API_KEY=
```

`.env` is correctly git-ignored, but `.env.example` is not — it is *meant* to
be committed. `git add .` would have published that key, and anyone could then
spend your Gemini quota.

The file is fixed (the value is now empty). **The key itself is still live:
revoke it at https://aistudio.google.com/apikey and issue a new one.** Treat
any key that has ever been written into a file you might commit as burned.

A test now fails the build if a real-looking key reappears in `.env.example`.

### 1.2 Start a fresh git history. Student PDFs are in the current one.

Eleven uploaded files are in your **Initial commit**, including
`20-Abdulaziz math.pdf` and `19-Integration rules.pdf`. They are deleted from
the working tree, but deleting a file does not remove it from history — anyone
who clones a public repo gets every one of them.

`.gitignore` covers `public/uploads/` correctly *now*; it did not when that
first commit was made.

Since you are publishing this as a new version anyway, the simplest safe fix is
to start clean:

```bash
cd "Student Helper App"
rm -rf .git
git init
git add .
git commit -m "Student Helper v2"
git remote add origin <your new repo url>
git push -u origin HEAD          # pushes whatever branch you are on
```

Whichever branch you end up on is fine — just make it the repository's default
branch in GitHub's settings, and keep only that one. Two branches pointing at
the same commit is the thing that makes a deploy platform ask you which to
build.

Check `git status` before that commit and confirm `.env` is not listed. If you
want to keep the old history instead, you have to rewrite it with
`git filter-repo --path public/uploads --invert-paths`, force-push, and accept
that any existing clone or fork still has the files.

### 1.3 Set a real session secret and admin password

`.env` still has `SESSION_SECRET=your_super_secret_key_change_this`. With the
example value, anyone who has seen this project can forge a session cookie for
any account, including admin. The app already refuses to start in production
without a real one:

```bash
node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"
node scripts/setAdminPassword.js
```

The admin password is now enforced too: **the server exits at boot in
production if the admin account still has the password `admin`.** It used to
print a warning into a log nobody reads.

---

## 2. Vercel will not run this app

Not "needs configuration" — three core features have no working form on that
platform. Vercel runs serverless functions; this is a stateful server.

| The app does this | Vercel provides | Result |
|---|---|---|
| Keeps sessions in server memory (`express-session`, default store) | A fresh, empty instance per request | Users are logged out at random. Login is unusable. |
| Writes uploads to `public/uploads/` and reads them back later | A read-only filesystem; only `/tmp`, wiped between invocations | Every upload fails or vanishes. |
| Connects to MySQL on `localhost` | No database, no localhost | Nothing loads. |

No `vercel.json` setting changes any of that.

**Recommended: host it on Render, Railway or Fly.io instead.** They run
`npm start` against a persistent container with a real disk and a managed MySQL
add-on. Nothing in the repo has to change — set the `DB_*` variables,
`SESSION_SECRET` and `NODE_ENV=production`, attach a volume for
`public/uploads`, and it behaves exactly as it does on your machine.

If it has to be Vercel, `DEPLOYMENT.md` now has the three pieces of work
required (shared session store, object storage for uploads, hosted MySQL with a
smaller connection pool) plus the `api/index.js` entry point.

---

## 3. Security holes found and closed

Each was reproduced against the running app, then fixed, then re-tested. All
four now have regression tests in `tests/integration/hardening-v2.test.js`.

### 3.1 Stored XSS — any student could take over any account (critical)

The upload filter trusted `file.mimetype`, which is a header the *uploading
client* writes, and the stored filename kept whatever extension the title
carried. So this worked:

```bash
curl -F 'file=@evil.html;type=application/pdf' -F 'title=notes.html' ...
```

The file landed at `public/uploads/<id>-notes.html`, and `express.static`
served it back as `text/html` **from your own origin**, with a CSP that allows
inline scripts. Confirmed: the page was returned with
`Content-Type: text/html` and its script would run with the session of whoever
opened the link — which an attacker sends through the app's own chat. That
script can read the victim's profile, the whole user directory and their
messages; if an admin opens it, it can delete accounts.

Fixed three ways: the declared type and the file extension must now agree; a
rejected upload returns a clean 400 instead of a 500 stack trace; and
everything under `/uploads` is now served with `Content-Disposition:
attachment` and an inert CSP, so even a bad file already on disk cannot script.

### 3.2 Anonymous callers could spend your AI budget (high)

`/search-files` had no session check. Since search became semantic, every
unique query costs a Gemini embedding call — so a stranger could sit in a loop
burning your quota, and read every file's title, description and uploader
while doing it. `/file/:id` and `/categories` were open too.

All three now require a session, and search is behind the AI rate limiter.

### 3.3 Anyone could fill your disk (high)

`multer` streams an upload to `public/uploads/` while parsing the request, and
the session check was inside the controller — so an unauthenticated POST wrote
a 10 MB file to disk *before* being told 401. Verified: a file was left behind
every time. The session check now runs before multer.

### 3.4 A student could open the admin dashboard (medium)

`express.static` decodes the URL before resolving a file, but the guard
compared the raw path. So `/views/admin%2Ddashboard.html` did not match the
literal `admin-dashboard.html`, fell through as an ordinary page, and was then
served. Only the page shell — every `/admin/*` data endpoint checks properly —
but it should not have been reachable. The guard now decodes first and rejects
malformed escapes.

---

## 4. Dependencies: 20 vulnerabilities → 0

`npm audit` reported 20 in production dependencies (1 critical, 12 high).
Fixed by upgrading within-range packages, then `bcrypt` 5 → 6 (the critical
`tar` advisory came in through bcrypt's install-time toolchain) and `vitest`
2 → 4. Both upgrades needed real work — bcrypt 6 verified against your existing
bcrypt-5 password hashes, and vitest 4 forwards `new` to mock implementations,
which broke 28 AI tests until the SDK mock became a real constructor.

`npm audit` is now clean across production **and** development dependencies,
with all 265 tests passing.

---

## 5. What was tested

**Automated:** 265 tests across 23 files, from a clean `npm ci` and an empty
database — auth, sessions, IDOR, uploads, file content, categories, favourites,
chat, direct messages, admin, AI error handling and quota, search (keyword,
Arabic/English, typo, semantic), the landing page, rate limits and legal pages.

**In a real browser (headless Chromium):** every page as an anonymous visitor
and as a signed-in student — splash, login, create account, privacy, terms,
For Me, My Files, Files, Favourites, Upload, Chat, AI Buddy, Profile, Search,
the file viewer, and the admin dashboard. Checked: login lands on For Me, cards
render and flip, favouriting works and shows up on the Favourites page, file
comments load and post, direct-message threads load, the upload form has every
field, the edit dialog opens with the *correct* file id, the Arabic toggle
switches to RTL, logout ends the session, and a protected page after logout
redirects to login.

**Result: no JavaScript errors, no failed requests, no broken links.** The only
console message was a recommendation fetch aborted by navigating away, which
the page already handles.

**Static:** every `.js` file parses; every relative import resolves; all 362
`href`/`src`/`action` values in the views resolve; all 41 client `fetch()` calls
match a real route, method and response shape.

---

## 6. Known issues I did not change

Judgement calls, listed so they are your decision rather than my silent one.

- **Google sign-in has no `state` parameter** (`routes/authRoutes.js:47`). A
  forged link can log a victim into the *attacker's* account, so anything they
  upload afterwards lands there. Fix by passing `state: true` and a session
  store to Passport. Google sign-in is currently disabled anyway (no
  `GOOGLE_CLIENT_ID`), so this is not live — but fix it before you enable it.
- **Account linking trusts an unverified email** (`config/googleAuth.js:61`).
  Registration never verifies the address, so someone who signs up with your
  Gmail owns the account you later land in via Google.
- **`routes/add-file.js` (351 lines) is dead** — never mounted; every URL it
  defines is served by `routes/fileRoutes.js`. Safe to delete.
- **Session store is still in-memory.** Fine for one process; restarting logs
  everyone out and memory is never reclaimed. `express-mysql-session` can reuse
  `models/db.js`. Required for any real hosting with more than one instance.
- **Registration says "Username or email already exists"**, which confirms to a
  stranger that an account exists.
- Small dead assets: `public/js/add-file.js`, `public/js/validation-handler.js`,
  five unused CSS files, and two orphan pages (`Account-info.html`,
  `Account-Change.html`) whose forms post to `action="#"` and discard input.

---

## 7. Publish checklist

```
[ ] Revoke the old Gemini key at https://aistudio.google.com/apikey
[ ] rm -rf .git && git init          (drops the student PDFs from history)
[ ] git status                       (confirm .env is NOT listed)
[ ] Generate SESSION_SECRET, put it in .env and in the host's env vars
[ ] node scripts/setAdminPassword.js
[ ] npm test                         (expect 265 passing)
[ ] Deploy to Render/Railway/Fly, not Vercel — see DEPLOYMENT.md
[ ] After deploy: NODE_ENV=production, HTTPS on, persistent volume for uploads
[ ] npm run search:index             (builds the semantic index)
```
