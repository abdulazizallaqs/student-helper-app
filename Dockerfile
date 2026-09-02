# Container image for Student Helper.
#
# Used by Northflank, Fly, Railway, a VPS, or anywhere else that takes a
# Dockerfile. Render does not need this - it detects Node on its own and
# render.yaml configures it - but having it means the app is not tied to any
# one platform's build magic.
#
# Two stages: the first installs everything so nothing is missing, the second
# copies in only what production runs. The result is a smaller image and,
# more importantly, one with no build tooling left inside it.

# ---- build ----------------------------------------------------------------
FROM node:22-slim AS build
WORKDIR /app

# package files first, on their own. Docker caches each step, and this one
# only changes when a dependency changes - so editing a route does not
# reinstall 400 packages.
COPY package.json package-lock.json ./

# `npm ci` not `npm install`: it installs exactly what the lockfile says, and
# fails loudly if package.json and the lockfile disagree, instead of quietly
# resolving to different versions than the ones the tests ran against.
RUN npm ci --omit=dev

COPY . .

# ---- run ------------------------------------------------------------------
FROM node:22-slim AS run
WORKDIR /app

ENV NODE_ENV=production
# Overridden by the platform, which sets PORT itself. app.js reads it.
ENV PORT=3002

# The node image ships a non-root `node` user. Running as root inside a
# container is a habit worth not having: it means a bug that can write files
# can write anywhere in the image.
COPY --from=build --chown=node:node /app /app

# Uploads only land here when FILE_STORAGE=disk. On a platform with a
# throwaway filesystem you want FILE_STORAGE=database instead - but the
# directory has to exist and be writable either way, or multer errors on the
# first upload rather than on the first read.
RUN mkdir -p /app/public/uploads && chown -R node:node /app/public/uploads

USER node
EXPOSE 3002

# A container that cannot answer /healthz is not serving, whatever the process
# table says. The endpoint deliberately touches neither the database nor the
# session store, so a slow query cannot make the platform kill a healthy app.
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3002)+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "app.js"]
