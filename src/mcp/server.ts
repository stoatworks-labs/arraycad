/**
 * The ArrayCAD MCP server's entry point: the tools, served over stdio.
 *
 * Started by `scripts/mcp-server.mjs`, which loads this through Vite's module runner and
 * moves console output off stdout first. Run directly it would do neither. See README.md,
 * "Drive it from Claude", for adding it to Claude Code.
 */

import { serveStdio } from './protocol.ts'
import { SERVER_INFO, arraycadTools } from './tools.ts'

await serveStdio(SERVER_INFO, arraycadTools())
