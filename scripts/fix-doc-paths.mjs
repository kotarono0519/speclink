#!/usr/bin/env node
// コミット時に、文書の「対象範囲」の指し先を実態に合わせて直す。
//
// ファイル名を変えると文書の紐付けが黙って切れる（文書は残るのに、そのファイルを
// 触っても何も出てこなくなり、誰も気づかない）。これを自動で防ぐ。
//
// 直すのはリネームだけ。git が「この名前がこの名前になった」と追跡している場合に限る。
// 削除されただけの場合は、どこへ移ったか機械には分からないので報告に留める（推測で直さない）。
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import {
  loadDocs,
  pathForRepo,
  readHookInput,
  resolveDocsDir,
  emit,
} from './lib/docs.mjs'
import { record, docsSnapshot } from './lib/log.mjs'

const input = await readHookInput()

const command = input.tool_input?.command ?? ''
if (!/\bgit\b[^|;&]*\bcommit\b/.test(command)) process.exit(0)

const docsDir = resolveDocsDir(input.cwd || process.cwd())
if (!docsDir) process.exit(0)

const projectDir = process.env.CLAUDE_PROJECT_DIR || input.cwd || process.cwd()
const git = (args) => {
  try {
    return execFileSync('git', args, { cwd: projectDir, encoding: 'utf8' })
  } catch {
    return ''
  }
}

// -M でリネームを検出する（R100 old new のような行になる）
const nameStatus = git(['diff', '--cached', '--name-status', '-M'])
if (!nameStatus.trim()) process.exit(0)

const renames = []
const deletions = []
for (const line of nameStatus.split('\n').filter(Boolean)) {
  const cols = line.split('\t')
  const status = cols[0][0]
  if (status === 'R' && cols.length >= 3) renames.push({ from: cols[1], to: cols[2] })
  else if (status === 'D') deletions.push(cols[1])
}
if (!renames.length && !deletions.length) process.exit(0)

const repoName = path.basename(projectDir)
const docs = loadDocs(docsDir)
const fixed = []

// 文書側の指し先は「リポジトリ名/パス」で書かれていることがある。
// いま作業しているリポジトリのものだけを対象にする。
const docPathsFor = (from) => [from, `${repoName}/${from}`]

// 1. リネームに追従する（完全一致の指し先だけを書き換える。glob は当てずに残す）
for (const { from, to } of renames) {
  for (const doc of docs) {
    const hit = docPathsFor(from).find((p) => doc.paths.includes(p))
    if (!hit) continue
    const file = path.join(docsDir, doc.file)
    const text = fs.readFileSync(file, 'utf8')
    const end = text.indexOf('\n---', 3)
    if (end === -1) continue
    // 冒頭の情報欄の中だけを書き換える（本文の同じ文字列は触らない）
    const replacement = hit.startsWith(`${repoName}/`) ? `${repoName}/${to}` : to
    const head = text.slice(0, end).split(hit).join(replacement)
    fs.writeFileSync(file, head + text.slice(end))
    fixed.push(`${doc.id}: ${hit} → ${replacement}`)
  }
}

// 2. 消えたまま行き先が分からない指し先を洗い出す（直さない）
const brokenPaths = []
for (const doc of loadDocs(docsDir)) {
  for (const p of doc.paths) {
    if (/[*?]/.test(p)) continue // 場所の指定に記号が入るものは実在判定をしない
    const rel = pathForRepo(p, repoName)
    if (rel === null) continue // 別のリポジトリを指している文書は、ここでは判定しない
    if (!fs.existsSync(path.join(projectDir, rel))) {
      brokenPaths.push(`${doc.id}: ${p}`)
    }
  }
}

record({
  event: 'paths',
  repo: repoName,
  session: input.session_id,
  fired: Boolean(fixed.length || brokenPaths.length),
  renamed: fixed.length,
  broken: brokenPaths.length,
  docs: docsSnapshot(docsDir),
})

if (!fixed.length && !brokenPaths.length) process.exit(0)

// 索引を作り直す（指し先が変わったため）
if (fixed.length) {
  try {
    execFileSync(
      'node',
      [path.join(process.env.CLAUDE_PLUGIN_ROOT ?? '.', 'scripts/build-index.mjs'), docsDir],
      { encoding: 'utf8' },
    )
  } catch {
    // 索引の再生成に失敗しても、指し先の修正自体は済んでいる
  }
}

const parts = ['設計文書の指し先の点検（speclink）。']
if (fixed.length) {
  parts.push(
    '',
    '**リネームに追従して自動で直した**（文書の紐付けが切れるのを防いだ）:',
    ...fixed.map((f) => `  - ${f}`),
    '',
    `文書リポジトリ（${docsDir}）に変更が入っている。こちらも忘れずにコミットすること。`,
  )
}
if (brokenPaths.length) {
  parts.push(
    '',
    '**指し先が見つからない**（自動では直さない。移動先が分かるなら直すこと。',
    '不要になった決定なら status を superseded にする）:',
    ...brokenPaths.map((b) => `  - ${b}`),
  )
}

emit('PreToolUse', parts.join('\n'))
