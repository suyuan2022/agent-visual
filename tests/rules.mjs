// Checks rules.md against real requests: whether the model draws where it should and leaves finished text alone, and
// how one blind reviewer scores the answers against those of another version of the rules. It calls Claude, so it is
// not part of the regular test run. An arm is one version of the rules; answers land in tests/rules/out/<arm>.
// usage: node tests/rules.mjs gen <arm> <rules file> [ids...]      answer every question, or only ids such as s12 q3
//        node tests/rules.mjs score <arm>...                       diagrams per group, and what fell back to source
//        node tests/rules.mjs review <armA> <armB> [--prompt-only] one blind review of the q answers of two arms
//        node tests/rules.mjs report <armA> <armB>                 the scores of the last review of those two arms
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { findDiagrams, fit, plainRewrite } from '../core/core.ts'

const here = path.join(path.dirname(fileURLToPath(import.meta.url)), 'rules')
const out = path.join(here, 'out')
const json = file => JSON.parse(fs.readFileSync(path.join(here, file), 'utf8'))
const scenarios = json('scenarios.json')
const reviewQuestions = json('review-questions.json')
const COLUMNS = 96 // The width the review reads the drawings at.
const AT_ONCE = 7

const answerPath = (arm, id) => path.join(out, arm, `${id}.md`)
const answer = (arm, id) => fs.readFileSync(answerPath(arm, id), 'utf8')
const diagramCount = text => (text.match(/^```mermaid/gm) ?? []).length

/** The answer as a terminal shows it: drawings in place, and a `╭ mermaid:` frame around what did not fit. */
function view(text) {
  const diagrams = findDiagrams(text).filter(d => d.closed)
  return plainRewrite(text, diagrams, new Map(diagrams.map(d => [d, fit(d.source, COLUMNS)])))
}

/** One `claude -p` with no tools, no plugins, no hooks and no CLAUDE.md, so only what the prompt holds counts. */
function claude(prompt) {
  const settings = JSON.stringify({ enabledPlugins: { 'agent-visual@agent-visual': false }, disableAllHooks: true })
  const args = ['-p', '--settings', settings, '--tools', '', '--model', 'opus', '--effort', 'xhigh', '--no-session-persistence']
  const env = { ...process.env, CLAUDE_CODE_DISABLE_CLAUDE_MDS: '1' }
  delete env.CLAUDECODE
  return new Promise((resolve, reject) => {
    const child = spawn('claude', args, { cwd: out, env, stdio: ['pipe', 'pipe', 'pipe'] })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', d => { stdout += d })
    child.stderr.on('data', d => { stderr += d })
    child.on('error', reject)
    child.on('close', code => (code === 0 && stdout.trim() ? resolve(stdout) : reject(new Error(`claude exited ${code}: ${stderr.slice(0, 300)}`))))
    child.stdin.end(prompt)
  })
}

async function gen(arm, rulesFile, ids) {
  const rules = fs.readFileSync(rulesFile, 'utf8').trim()
  const all = new Map([...scenarios.map((s, i) => [`s${i}`, s.q]), ...reviewQuestions.map((q, i) => [`q${i}`, q])])
  const queue = ids.length ? ids : [...all.keys()]
  fs.mkdirSync(path.join(out, arm), { recursive: true })
  let failed = 0
  await Promise.all(Array.from({ length: AT_ONCE }, async () => {
    for (let id = queue.shift(); id; id = queue.shift()) {
      if (!all.has(id)) throw new Error(`no question ${id}`)
      try {
        fs.writeFileSync(answerPath(arm, id), await claude(`<system-reminder>\n${rules}\n</system-reminder>\n\n${all.get(id)}`))
      } catch (e) {
        failed++
        console.error(`${id}: ${e.message}`)
      }
    }
  }))
  if (failed) process.exitCode = 1
}

function score(arm) {
  const groups = { no: { total: 0, drew: [] }, yes: { total: 0, drew: [] }, either: { total: 0, drew: [] } }
  scenarios.forEach((s, i) => {
    groups[s.expect].total++
    if (diagramCount(answer(arm, `s${i}`))) groups[s.expect].drew.push(i)
  })
  const missed = scenarios.flatMap((s, i) => (s.expect === 'yes' && !groups.yes.drew.includes(i) ? [i] : []))
  const reviewed = reviewQuestions.map((_, i) => answer(arm, `q${i}`))
  const ids = [...scenarios.map((_, i) => `s${i}`), ...reviewQuestions.map((_, i) => `q${i}`)]
  const source = ids.filter(id => /^╭ mermaid:/m.test(view(answer(arm, id))))
  console.log(`${arm}`)
  console.log(`  drew where it should not: ${groups.no.drew.length}/${groups.no.total} ${JSON.stringify(groups.no.drew)}`)
  console.log(`  missed where it should:   ${missed.length}/${groups.yes.total} ${JSON.stringify(missed)}`)
  console.log(`  drew where either is fine: ${groups.either.drew.length}/${groups.either.total} ${JSON.stringify(groups.either.drew)}`)
  console.log(`  review questions with a diagram: ${reviewed.filter(diagramCount).length}/${reviewed.length}, ${reviewed.reduce((n, t) => n + diagramCount(t), 0)} diagrams`)
  console.log(`  shown as source at ${COLUMNS} columns: ${source.length} ${JSON.stringify(source)}`)
}

const reviewFile = (a, b, ext) => path.join(out, `review-${a}-${b}.${ext}`)

async function review(a, b, promptOnly) {
  const labels = {}
  const parts = reviewQuestions.map((q, i) => {
    const order = Math.random() < 0.5 ? [a, b] : [b, a]
    labels[i] = { A: order[0], B: order[1] }
    const shown = order.map((arm, k) => {
      const text = view(answer(arm, `q${i}`)).trim()
      const prose = text.replace(/```[\s\S]*?```/g, '').replace(/\s/g, '').length
      return `### 回答 ${'AB'[k]}（正文约 ${prose} 字，不含图）\n\n${text}`
    })
    return [`## 第 ${i} 题：${q}`, ...shown].join('\n\n')
  })
  const prompt = `${fs.readFileSync(path.join(here, 'rubric.md'), 'utf8').trim()}\n\n---\n\n${parts.join('\n\n---\n\n')}`
  fs.writeFileSync(reviewFile(a, b, 'labels.json'), JSON.stringify(labels, null, 1))
  fs.writeFileSync(reviewFile(a, b, 'prompt.md'), prompt)
  if (promptOnly) return console.log(reviewFile(a, b, 'prompt.md'))
  fs.writeFileSync(reviewFile(a, b, 'review.md'), await claude(prompt))
  report(a, b)
}

function report(a, b) {
  const text = fs.readFileSync(reviewFile(a, b, 'review.md'), 'utf8')
  const labels = JSON.parse(fs.readFileSync(reviewFile(a, b, 'labels.json'), 'utf8'))
  const { questions, patterns } = JSON.parse(text.match(/```json\s*([\s\S]*?)```/)?.[1] ?? text)
  const rows = { [a]: [], [b]: [] }
  const best = { [a]: 0, [b]: 0 }
  for (const q of questions) {
    for (const [label, s] of Object.entries(q.answers)) rows[labels[q.q][label]].push(s)
    best[labels[q.q][q.best]]++
    const by = arm => q.answers[Object.keys(q.answers).find(l => labels[q.q][l] === arm)]
    console.log(`q${q.q}  ${a} ${by(a).value}  ${b} ${by(b).value}  ${by(b).diagram}`)
  }
  const mean = (arm, key) => (rows[arm].reduce((n, s) => n + s[key], 0) / rows[arm].length).toFixed(2)
  for (const arm of [a, b]) {
    const restated = rows[arm].reduce((n, s) => n + s.restated, 0)
    console.log(`${arm}: value ${mean(arm, 'value')}, read cost ${mean(arm, 'read_cost')}, depth ${mean(arm, 'depth')}, restated ${restated}, best in ${best[arm]}`)
  }
  console.log(`patterns: ${patterns}`)
}

const [command, ...rest] = process.argv.slice(2)
fs.mkdirSync(out, { recursive: true })
if (command === 'gen' && rest.length >= 2) await gen(rest[0], rest[1], rest.slice(2))
else if (command === 'score' && rest.length) rest.forEach(score)
else if (command === 'review' && rest.length >= 2) await review(rest[0], rest[1], rest.includes('--prompt-only'))
else if (command === 'report' && rest.length === 2) report(rest[0], rest[1])
else {
  console.error('usage: node tests/rules.mjs gen|score|review|report (see the top of this file)')
  process.exitCode = 2
}
