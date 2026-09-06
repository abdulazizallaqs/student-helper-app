# pdf.js (vendored)

`pdfjs-dist` 4.10.38, Apache-2.0 — see LICENSE.

## Why these files are in the repository rather than loaded from a CDN

Chrome on Android and Safari on iOS cannot render a PDF inside an `<iframe>`.
The old viewer did exactly that, so on a phone every file opened as Chrome's
"This content is blocked. Contact the site owner to fix the issue." — which
reads to a student like the app is broken. pdf.js draws the pages onto a
`<canvas>` instead, which every browser can do.

Vendored, not from a CDN, for three reasons:

  * The Content-Security-Policy in app.js sets `worker-src 'self'`. A worker
    fetched from a CDN is blocked outright, and the failure is silent.
  * A CDN outage would take the file viewer down with it.
  * The app is used on university networks that filter unknown hosts.

## What is here, and what is deliberately not

  pdf.min.mjs           the library (legacy build — widest browser support)
  pdf.worker.min.mjs    the parser, which runs off the main thread
  standard_fonts/       substitutes for the base-14 fonts when a PDF does not
                        embed them; without these such files render blank

`cmaps/` is NOT included. It is 1.7 MB and only needed for PDFs using
predefined CJK encodings. Add it — and set `cMapUrl`/`cMapPacked` in
Display.html — if Chinese, Japanese or Korean documents ever need to render.

## Upgrading

    npm pack pdfjs-dist@4
    tar xzf pdfjs-dist-*.tgz
    cp package/legacy/build/pdf.min.mjs package/legacy/build/pdf.worker.min.mjs .
    cp package/standard_fonts/* standard_fonts/

The library and the worker must come from the SAME version — pdf.js refuses to
start when they disagree, and says so in the console.
