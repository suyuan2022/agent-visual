// The drawing and image rules for the model: rules.md at the repo root, the same file pi injects. Sent the way pi
// sends them: with the context the conversation's first message carries (so beside the 1st message), again after
// each compaction or /clear, and beside every fifth message the person types after either (the 6th, 11th, ...).
import type { Register } from 'claude-code'

/** The context block's name; the model reads it under `# agentVisualRules`. */
export const BLOCK = 'agentVisualRules'

/** Messages from one reminder to the next, as in pi. */
export const EVERY = 5

/** Hooks the rules in; register.tsx calls it, as a plugin has one hooks module. */
export function registerRules(on: Parameters<Register>[0]): void {
  // Messages typed since the one the rules last rode with; -1 while the next one typed will carry the context block.
  let since = -1
  let typed = false
  let submitting = false

  on('prompt.context', async ($, e, next) => {
    // Raised for the first message, or once nothing has been typed yet, that message carries the block;
    // raised after a compaction, the block follows the summary and the count starts over.
    since = submitting || typed ? 0 : -1
    let rules: string
    try {
      rules = ((await $.fs.read(`${$.plugin.root}/rules.md`)) as string).trim()
    } catch {
      return next(e)
    }
    return next({ ...e, blocks: [...e.blocks.filter(b => b.name !== BLOCK), { name: BLOCK, text: rules }] })
  })

  on('prompt.submit', async ($, e, next) => {
    // Only what the person typed counts: not slash commands, the engine's own prompts, notifications or plugins.
    const own = e.origin.kind === 'composer' || e.origin.kind === 'bridge'
    if (!own || e.command !== undefined || e.isMeta === true) return next(e)
    typed = true
    since += 1
    const due = since >= EVERY
    if (due) since = 0
    let rules: string | undefined
    if (due) {
      try {
        rules = ((await $.fs.read(`${$.plugin.root}/rules.md`)) as string).trim()
      } catch {
        rules = undefined
      }
    }
    submitting = true
    try {
      return await next(rules === undefined ? e : { ...e, context: [...(e.context ?? []), rules] })
    } finally {
      submitting = false
    }
  }).catch(($, e, next) => next(e)) // a reminder that fails never holds the message back
}
