#!/usr/bin/env node
/**
 * ArrayCAD's MCP server, for Claude Code or any other MCP client, over stdio:
 *
 *   claude mcp add arraycad -- node /path/to/arraycad/scripts/mcp-server.mjs
 *
 * The library is TypeScript with enums, which Node's own type stripping refuses, so it is
 * loaded through Vite's module runner: the same transform vitest runs the tests through,
 * with nothing built, nothing served and no dependency added. Needs `npm install` first —
 * the XML readers borrow jsdom's DOMParser, a dev dependency, as the tests do.
 */

import { fileURLToPath } from 'node:url'

// stdout is the protocol. Anything the libraries or Vite print goes to stderr instead, and
// has to be moved before any of them loads: one stray console.log is a corrupt message.
const toStderr = console.error.bind(console)
console.log = console.info = console.debug = console.warn = toStderr

const root = fileURLToPath(new URL('..', import.meta.url))
const { createServer, createServerModuleRunner } = await import('vite')

const vite = await createServer({
  root,
  configFile: false,
  logLevel: 'error',
  appType: 'custom',
  server: { middlewareMode: true, hmr: false, watch: null, ws: false },
  optimizeDeps: { noDiscovery: true, include: [] },
  // dxf-parser's ESM build imports its own files without extensions, which Node refuses;
  // vitest inlines it for the same reason.
  ssr: { noExternal: ['dxf-parser'] },
})
const runner = createServerModuleRunner(vite.environments.ssr, { hmr: false })

try {
  // Resolves when stdin closes and the server is done.
  await runner.import('/src/mcp/server.ts')
} catch (e) {
  toStderr('arraycad MCP server failed:', e)
  process.exitCode = 1
} finally {
  await runner.close()
  await vite.close()
}
