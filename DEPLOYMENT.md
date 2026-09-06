# Deploying Student Helper

Everything in **Part 1** is a command you run. Everything in **Part 2** is
infrastructure — it can't be fixed in the code, only in how you host it.

---

## Part 1 — Before you publish (run these)

### 1. Install dependencies

```bash
npm install
```

### 2. Generate a real session secret

The app **refuses to start in production without one**, deliberately: the old
code fell back to a hardcoded key, and once this source is public that key is
public too — anyone could forge a login cookie for any account, admin included.

```bash
node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"
```

Put the output in `.env`:

```
SESSION_SECRET=<the long string you just generated>
```

### 3. Change the admin password

`admin` / `admin` is the first thing anyone tries on a public site.

```bash
npm run admin:password              # generates a strong one and prints it once
npm run admin:password "Your Own Strong Password"
```

The app prints a loud warning at startup while the default is still in place.

### 4. Apply the database migration

Adds the uniqueness constraint that stops duplicate favourites appearing:

```bash
npm run migrate
```

### 5. Set production mode

In `.env`:

```
NODE_ENV=production
```

This is what switches on: HTTPS enforcement, the `secure` session cookie,
`trust proxy`, and the refusal to boot without a session secret. **Without it
the security hardening is inactive.**

### 6. Verify

```bash
npm run diagnose      # checks env, database, schema, and boots the app
npm test              # 104 tests
```

---

## Part 1b — Deploying on a free plan

The app now keeps **uploaded files and sessions in the database**, not on disk
(`FILE_STORAGE=database`). That is what makes a free host viable at all: every
free platform gives you a filesystem that is wiped on the next deploy, and
without this every uploaded PDF would disappear.

Verified: a file was uploaded through the browser, the server was killed,
`public/uploads/` was emptied, the server was restarted — the user was still
signed in and the PDF still opened.

### The database — TiDB Cloud Starter (genuinely free)

5 GiB storage, 50 million request units a month, **no credit card**, up to five
instances. MySQL-compatible, and foreign keys with `ON DELETE CASCADE` — which
this schema relies on — are GA since TiDB v8.5.

Create a **Starter** cluster, then Connect → General, and copy the host, port
(**4000**, not 3306), user, password and database name.

**Then import the schema — this step is not optional.** Only four tables create
themselves at runtime (`FileBlobs`, `FileBlobChunks`, `FileEmbeddings`,
`Sessions`). The other nine — `Users`, `Files`, `Categories`, `chats`,
`messages`, `messages_chat`, `Favorit`, `Admin`, `Comments` — do not. Skip this
and the app boots, serves the login page, and fails on every single action.

Paste `tests/setup/schema.sql` into TiDB Cloud's **SQL Editor**, or from your
machine:

```bash
mysql -h <host> -P 4000 -u <user> -p --ssl-mode=REQUIRED <dbname> < tests/setup/schema.sql
```

Files count against the 5 GiB, so at the 10 MB per-file cap that is roughly 500
uploads. `npm run diagnose` reports how much is used.

### The app — pick one

**Northflank Sandbox — recommended if you want no cold starts.**
Two free services plus one free database, always on, no sleeping. You can run
the app *and* a MySQL database on the same free plan, so TiDB becomes optional.
Card verification may be requested.

**Render free — recommended if you want the best-known, most documented host.**
750 instance-hours a month, deploys straight from GitHub, automatic HTTPS.
The catch: it **spins down after 15 minutes of no traffic, and the next request
waits about a minute** while it wakes. Fine for a portfolio or a class demo,
irritating for daily use. Render's own free Postgres expires after 30 days —
ignore it, this app uses MySQL and TiDB does not expire.

**Vercel** now works too, since nothing touches the disk any more, but it needs
an `api/index.js` (`import app from '../app.js'; export default app;`), a guard
so `app.listen(...)` does not run there, and `DB_POOL_SIZE=2` — every warm
serverless instance holds its own pool and a free database's connections go
quickly.

Two to be careful with: platforms offering 75 runtime hours a month are only
about 2.5 hours a day, so the site is off most of the time; and very generous
unknown hosts (2 vCPU, 3 GB RAM, 15 GB free) are worth treating with suspicion
when the data is other students' coursework — the risk is not the price, it is
a sudden shutdown with your database inside it.

### Settings, wherever you deploy

Set these as environment variables on the host, never in a committed file:

```
NODE_ENV=production
SESSION_SECRET=<node -e "console.log(require('crypto').randomBytes(48).toString('hex'))">

DB_HOST=<gateway...tidbcloud.com>
DB_PORT=4000                 # TiDB does not use 3306
DB_USER=<from the provider>
DB_PASSWORD=<from the provider>
DB_NAME=<from the provider>
DB_SSL=true                  # every hosted MySQL requires TLS; without this
                             # the connection is refused with a confusing
                             # handshake error
DB_POOL_SIZE=5               # 2 on a serverless host

FILE_STORAGE=database        # THE IMPORTANT ONE. Without it every upload is
                             # lost on the next deploy.

GEMINI_API_KEY=<optional; AI features report as off without it>
GOOGLE_CLIENT_ID=<optional; the sign-in button hides itself>
GOOGLE_CLIENT_SECRET=
GOOGLE_CALLBACK_URL=https://<your-domain>/auth/google/callback
```

Build command `npm install`, start command `npm start`. The app reads `PORT`
from the environment, which is what every one of these platforms sets.

### After the first deploy

Run these **from your own machine, with the environment variables pointed at
the production database** — not from the platform's shell. A platform shell
attaches to a running container, so it is unavailable exactly when you need it
most: when the app is failing to start. Your machine can always reach the
database.

```bash
node scripts/setAdminPassword.js "a strong password"
npm run diagnose        # database, schema, and stored files
npm run search:index    # builds the semantic search index
npm run google:check    # only if enabling Google sign-in
```

`setAdminPassword` creates the admin row if it is missing and updates it if it
exists, storing a bcrypt hash either way — so production never passes through
an `admin/admin` state at all.

**Do not run `npm run seed:admin` against production.** It exists to give you a
way into a fresh local install and it creates the password `admin`; on a
production database it creates precisely the weak account the server then
refuses to start with.

### Your own domain

A registrar and a host are separate. Whichever platform you choose, add your
domain in its dashboard and point Hostinger's DNS at it — an A record to the
platform's IP, or a CNAME to the hostname it gives you. Then update
`GOOGLE_CALLBACK_URL` and the Authorized redirect URI in Google Cloud to match
the real domain.

### Two things that will feel like bugs and are not

- **The first request after a quiet period is slow.** On Render the container
  is waking; TiDB also pauses idle clusters. Both are working as designed.
- **Serving a 10 MB file pulls ten rows out of the database.** Fine at class
  scale. If the library grows into thousands of large files, move the bytes to
  object storage (Cloudflare R2's free tier is 10 GB) — that change is confined
  to `services/fileStorage.js`, which is why that file exists.

### If you would rather pay a little

Hostinger's managed Node plan (~$4/month) or a VPS (~$9/month) runs this with
`FILE_STORAGE=disk`, no cold starts and no database-storage overhead. The free
options above genuinely work; a small VPS is simply less to think about.

> **Note (September 2026):** an earlier version of this guide recommended
> Koyeb's free tier. Koyeb was acquired by Mistral AI and no longer offers one —
> its plans now start at $29/month. Free tiers move; check before you commit.

---

## Part 2 — Infrastructure (what the code cannot do for you)

### HTTPS is mandatory

Session cookies are marked `secure` in production, so **the app will not work
over plain HTTP** — that is intentional, not a bug. Put it behind a reverse
proxy that terminates TLS (Caddy and nginx both do this; Caddy obtains
certificates automatically). The app already sets `trust proxy`, so it will
read the real visitor IP and protocol through the proxy.

Without this, every session cookie crosses the network in clear text and
anyone on the same Wi-Fi can copy it and become that user.

### Keep the process running

`node app.js` in a terminal dies when you close it or when the app throws.
Use a process manager that restarts it and starts it at boot — PM2 works on
Windows:

```bash
npm install -g pm2
pm2 start app.js --name student-helper
pm2 save
pm2 startup
```

### Back up the database

Right now there is one copy of everything on one machine. A disk failure loses
every student's work permanently. A scheduled dump is the minimum:

```bash
mysqldump -u root -p Student_Helper2_DB > backup-YYYY-MM-DD.sql
```

Automate it (Task Scheduler), keep copies **off that machine**, and restore one
once to prove the backup actually works — an untested backup isn't a backup.

### Uploaded files

`public/uploads/` holds student files and is now excluded from git. Back it up
alongside the database — the rows and the files are useless without each other.

If this repo was ever pushed publicly *before* today, those files are in the
git history. Purging history requires a rewrite (`git filter-repo`), and
anything already cloned is out of your control.

### Encryption at rest

MySQL data files and uploads sit unencrypted on disk. If the machine or its
drive is lost, so is that data. Turn on BitLocker (Windows) or full-disk
encryption on whatever hosts this.

---

## Known limitations — decide before launch

These are deliberate positions, not oversights. Each is a judgement call:

**Search is public.** `/search-files` returns file titles, descriptions and
uploader usernames with no login. That makes discovery easy and makes those
three fields public. If this is a closed cohort, gate it.

**Content Security Policy allows inline scripts.** Several pages still use
`onclick=""` handlers and inline `<script>` blocks. `unsafe-inline` is required
while they exist. Output is escaped everywhere (there are tests for that), so
this is defence-in-depth you're giving up, not an open hole. Removing it means
moving those handlers into external files.

**No email verification or password reset.** Anyone can register with any
address, and a forgotten password can only be fixed by an admin.

**Files are visible to every logged-in user.** There is no per-file privacy —
by design, it's a sharing app. Make sure students know that before they upload.

**AI features send file content to Google.** Quiz, flashcard and summary
generation transmit the text of the file to the Gemini API. Your privacy policy
should say so plainly.
