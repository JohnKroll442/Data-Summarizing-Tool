/**
 * viteResolveShim — lets Node import the app's src/lib/*.js modules unmodified.
 *
 * The frontend is a Vite project, so its lib files use extensionless relative
 * imports (`import { x } from './sessionAggregate'`). Vite resolves those; plain
 * Node ESM does not. This hook appends `.js` (then `/index.js`) to relative
 * specifiers that lack an extension, so the real tool code runs in Node with no
 * edits — the whole point of generating ground truth from the tool's own libs.
 *
 * Usage:
 *   node --import ./backend/skilleval/viteResolveShim.mjs <script.mjs>
 */
import { registerHooks } from 'node:module'

const hasExt = (s) => /\.[cm]?[jt]sx?$|\.json$/i.test(s)
const isRelative = (s) => s.startsWith('./') || s.startsWith('../')

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (isRelative(specifier) && !hasExt(specifier)) {
      try {
        return nextResolve(specifier + '.js', context)
      } catch {
        return nextResolve(specifier + '/index.js', context)
      }
    }
    return nextResolve(specifier, context)
  },
})
