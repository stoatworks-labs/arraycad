import { readdirSync, readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { extname, join } from 'node:path'
import type { Plugin } from 'vite'

/**
 * pdf.js keeps its JPEG 2000 (OpenJPEG), JBIG2 and ICC (qcms) decoders as WebAssembly
 * **fetched at runtime** from the `wasmUrl` API option. They are not bundled into
 * pdf.worker. Leave `wasmUrl` unset and pdf.js resolves the literal path
 * `nullopenjpeg.wasm` — the `null` is the unset option stringified — the decode fails,
 * and the image is dropped from the page.
 *
 * It fails as a console warning, never as a rejected render promise, so the tracer has no
 * way to tell. The JS fallback beside each decoder does not save it: pdf.js builds that
 * path from the same unset option, so `nullopenjpeg_nowasm_fallback.js` fails too.
 *
 * For the tracer that is not cosmetic. A page with no vector line work already has a
 * supported path — `source.ts:contoursOf` recovers outlines from the rendered pixels, for
 * exactly the scanned drawing this affects. So a JPEG 2000 or JBIG2 scan renders as a
 * blank white page, traces nothing, and reports "Almost nothing was detected as a drawn
 * line. Try inverting, or set the threshold by hand." — sending the user to the threshold
 * controls for a page that has no pixels in it at all. JBIG2 is the ordinary bilevel
 * codec for scan-to-PDF, so this is the common scan, not an exotic one.
 *
 * The whole directory is copied rather than an allowlist of the decoders this app is
 * thought to need. pdf.js fetches them lazily — only once a page actually contains an
 * image in that format — so an unused decoder costs build output size and nothing else,
 * while a hand-maintained list is one pdfjs-dist upgrade away from silently missing a new
 * one and reintroducing exactly this bug, invisibly.
 */

const require = createRequire(import.meta.url)

/** Where the decoders are served and emitted, relative to index.html. */
export const PDFJS_WASM_PATH = 'pdfjs-wasm'

const CONTENT_TYPES: Record<string, string> = {
  '.wasm': 'application/wasm',
  '.js': 'text/javascript',
}

/**
 * Resolved through the package rather than a hardcoded node_modules path, so it still
 * works wherever npm hoists or dedupes pdfjs-dist to.
 */
export function pdfjsWasmDir(): string {
  return join(require.resolve('pdfjs-dist/package.json'), '..', 'wasm')
}

export function pdfjsWasm(): Plugin {
  return {
    name: 'arraycad-pdfjs-wasm',

    // The dev server has no build output to serve these from, and pdf.js fetches them at
    // runtime, so they need their own route.
    configureServer(server) {
      const dir = pdfjsWasmDir()
      const prefix = `/${PDFJS_WASM_PATH}/`

      server.middlewares.use((req, res, next) => {
        const path = req.url?.split('?')[0]
        if (!path?.startsWith(prefix)) return next()

        // pdf.js only ever asks for a flat filename from this directory, so anything
        // carrying a separator is a traversal attempt. Decoded first: an encoded
        // "%2e%2e%2f" would otherwise slip past this check and only fail later because no
        // such literal filename exists on disk.
        let name: string
        try {
          name = decodeURIComponent(path.slice(prefix.length))
        } catch {
          return next()
        }
        if (!name || name.includes('/') || name.includes('\\') || name.includes('..')) {
          return next()
        }

        let body: Buffer
        try {
          body = readFileSync(join(dir, name))
        } catch {
          return next()
        }
        res.setHeader('Content-Type', CONTENT_TYPES[extname(name)] ?? 'application/octet-stream')
        res.end(body)
      })
    },

    // Emitted with an explicit `fileName` so the paths stay **unhashed**: pdf.js builds
    // them by concatenating a bare filename onto `wasmUrl`, so a content-hashed asset name
    // would never be requested. They land outside /assets/ for that reason too — the
    // immutable year-long cache in public/_headers is only correct for hashed names.
    generateBundle() {
      const dir = pdfjsWasmDir()
      for (const name of readdirSync(dir)) {
        this.emitFile({
          type: 'asset',
          fileName: `${PDFJS_WASM_PATH}/${name}`,
          source: readFileSync(join(dir, name)),
        })
      }
    },
  }
}
