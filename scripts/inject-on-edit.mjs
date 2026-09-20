#!/usr/bin/env node
// コードを編集する直前に、その場所に効く決定を差し出す。
// 方針: 狭めに出す。該当が多いときは件数だけ告げる（オオカミ少年にしない）。
//
// 編集の経路は 2 つある。
// - Edit / Write ツール: file_path がそのまま編集先
// - Bash ツール: sed -i / perl -i / リダイレクト（> >>）/ tee / cp / mv で書く
//   （自動モードでは編集を Bash で行う指示が入ることがあり、Edit / Write だけを
//   見ていると編集直前の差し込みが一度も走らない。miroir-fe で 0 回だった）
// Bash の側は書き込み先の取り違えを避けるため、精度を優先して狭く取る。
// 読むだけの命令（cat / grep / sed -n）では何も出さない。
import fs from 'node:fs'
import path from 'node:path'
import {
  loadDocs,
  matchDocs,
  readHookInput,
  resolveDocsDir,
  resolveRepoDir,
  stripHeredoc,
  tokenize,
  unquote,
  emit,
  seenFilter,
} from './lib/docs.mjs'
import { record, docsSnapshot, repoOf } from './lib/log.mjs'

const MAX_SHOWN = 3

const input = await readHookInput()
const docsDir = resolveDocsDir(input.cwd || process.cwd())
if (!docsDir) process.exit(0)

const projectDir = resolveRepoDir(input)
const cwd = input.cwd || projectDir
const { repo: repoName, worktree } = repoOf(projectDir)
const ti = input.tool_input ?? {}

// 編集先（プロジェクト内の相対パス）と、項目名での引き当てに使う本文
let relPaths
let content
if (input.tool_name === 'Bash') {
  const command = ti.command ?? ''
  if (!command) process.exit(0)
  relPaths = writeTargetsOf(command, { cwd, projectDir })
  content = command
} else {
  const filePath = ti.file_path
  if (!filePath) process.exit(0)
  relPaths = [toProjectRel(filePath, { cwd, projectDir })].filter(Boolean)
  content = [ti.new_string, ti.content, ti.old_string].filter(Boolean).join('\n')
}
if (!relPaths.length) process.exit(0)

const docs = loadDocs(docsDir)
const hitsById = new Map()
for (const relPath of relPaths) {
  for (const d of matchDocs(docs, { relPath, content, repoName })) {
    if (d.kind === 'decision' && !hitsById.has(d.id)) hitsById.set(d.id, d)
  }
}
const hits = [...hitsById.values()]

const log = (fired, shown = []) =>
  record({
    event: 'edit',
    repo: repoName,
    worktree,
    session: input.session_id,
    via: input.tool_name === 'Bash' ? 'bash' : 'tool',
    file: relPaths[0],
    files: relPaths,
    fired,
    matched: hits.map((h) => h.id),
    shown,
    docs: docsSnapshot(docsDir),
  })

if (!hits.length) {
  log(false)
  process.exit(0)
}

// 同じ会話で一度出したものは繰り返さない
const freshIds = new Set(
  seenFilter(
    input.session_id,
    hits.map((h) => h.id),
  ),
)
const fresh = hits.filter((h) => freshIds.has(h.id))
if (!fresh.length) {
  log(false)
  process.exit(0)
}

let text
if (fresh.length > MAX_SHOWN) {
  text =
    `この範囲に関係する設計判断が ${fresh.length} 件あります（多いので一覧のみ）。` +
    `必要なら開いてください: ${fresh.map((d) => d.id).join(', ')}\n` +
    `場所: ${docsDir}`
} else {
  text =
    'この範囲に効く過去の設計判断があります。反する変更をしようとしていないか確認してください。\n\n' +
    fresh
      .map(
        (d) =>
          `- ${d.id} ${d.title}\n  ${d.summary || '(要約なし)'}\n  ${path.join(docsDir, d.file)}`,
      )
      .join('\n')
}

log(true, fresh.map((d) => d.id))
emit('PreToolUse', text)

/**
 * Bash の命令文から「書き込み先」のファイルをプロジェクト内の相対パスで取り出す。
 *
 * 見るのは次の形だけ（精度優先。ここに無い書き方は拾わない）。
 * - `sed -i` / `perl -i` / `perl -pi`: その区切りの中の、実在するファイルの引数
 * - `> file` / `>> file`: リダイレクト先（`/dev/null` と `>&2` の類は除く）
 * - `tee [-a] file...`
 * - `cp` / `mv` の最後の引数（上書き先）
 * 命令文は `;` `&&` `||` `|` で区切って区切りごとに見る。
 */
function writeTargetsOf(command, { cwd, projectDir }) {
  const found = new Set()

  // ヒアドキュメントの本文は命令ではないので、区切りに使う前に落とす
  const withoutHeredoc = stripHeredoc(command)

  // `cd <場所> && sed -i …` のように途中で移動する命令文では、以降の相対パスをその場所から解く
  let here = cwd
  const add = (token, { mustExist }) => {
    const rel = toProjectRel(unquote(token), { cwd: here, projectDir })
    if (!rel) return
    if (mustExist && !isFile(path.join(projectDir, rel))) return
    found.add(rel)
  }

  for (const seg of withoutHeredoc.split(/\|\||&&|;|\|/)) {
    const tokens = tokenize(seg)
    if (!tokens.length) continue
    if (tokens[0] === 'cd') {
      const to = tokens[1] ? unquote(tokens[1]) : null
      if (to && !/[*?{}$`]/.test(to)) here = path.resolve(here, to)
      continue
    }

    // リダイレクト先（`>` `>>`）。`2>&1` `>&2` `> /dev/null` は対象外
    for (let i = 0; i < tokens.length; i++) {
      const t = tokens[i]
      const m = t.match(/^\d?(>>?)(.*)$/)
      if (!m || m[2].startsWith('&')) continue
      const target = m[2] || tokens[++i]
      if (!target || target.startsWith('&') || target === '/dev/null') continue
      add(target, { mustExist: false })
    }

    // 先頭の命令名（env・sudo・変数代入は飛ばす）
    let head = 0
    while (
      head < tokens.length &&
      /^(?:env|sudo|command|[A-Za-z_][A-Za-z0-9_]*=.*)$/.test(tokens[head])
    )
      head++
    const cmd = path.basename(tokens[head] ?? '')
    const args = tokens
      .slice(head + 1)
      .filter((t) => !/^\d?>>?/.test(t) && !t.startsWith('<'))

    if (
      (cmd === 'sed' || cmd === 'perl') &&
      args.some((a) => /^-[a-zA-Z]*i|^--in-place/.test(a))
    ) {
      // 置換の式と実在するファイルの区別は「実在するか」で行う
      for (const a of args) if (!a.startsWith('-')) add(a, { mustExist: true })
    } else if (cmd === 'tee') {
      for (const a of args) if (!a.startsWith('-')) add(a, { mustExist: false })
    } else if (cmd === 'cp' || cmd === 'mv') {
      const operands = args.filter((a) => !a.startsWith('-'))
      if (operands.length >= 2)
        add(operands[operands.length - 1], { mustExist: false })
    }
  }
  return [...found]
}

/** プロジェクト内なら相対パス、外なら null。パスらしくない語（置換式など）も null */
function toProjectRel(token, { cwd, projectDir }) {
  if (!token || /[\s*?{}$`]/.test(token)) return null
  const abs = path.isAbsolute(token) ? token : path.resolve(cwd, token)
  const rel = path.relative(projectDir, abs)
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) return null
  return rel
}

function isFile(p) {
  try {
    return fs.statSync(p).isFile()
  } catch {
    return false
  }
}
