#!/usr/bin/env node
// コミットしようとしたときに /doc-sync（照合）を起動する。
//
// 人はコマンドを打たない。打たれない道具は腐るので、コミットを起点に自動で動かす。
// ここが見るのは「既に溜まっている文書と、今の変更が食い違っていないか」だけ。
// 「これから何を残すか」は check-on-commit.mjs（コミット前の確認）の担当で、重複させない。
import { execFileSync } from 'node:child_process'
import path from 'node:path'
import {
  loadDocs,
  matchDocs,
  readHookInput,
  resolveDocsDir,
  emit,
} from './lib/docs.mjs'
import { record, docsSnapshot } from './lib/log.mjs'

const input = await readHookInput()

const command = input.tool_input?.command ?? ''
if (!/\bgit\b[^|;&]*\bcommit\b/.test(command)) process.exit(0)
if (/--amend|--no-edit/.test(command)) process.exit(0)

const docsDir = resolveDocsDir(input.cwd || process.cwd())
if (!docsDir) process.exit(0)

const projectDir = process.env.CLAUDE_PROJECT_DIR || input.cwd || process.cwd()
const repoName = path.basename(projectDir)

let staged = ''
try {
  staged = execFileSync('git', ['diff', '--cached', '--name-only'], {
    cwd: projectDir,
    encoding: 'utf8',
  })
} catch {
  process.exit(0)
}
const files = staged.split('\n').filter(Boolean)
if (!files.length) process.exit(0)

// 変更に効く決定だけを対象にする。該当が無ければ照合そのものが不要。
const docs = loadDocs(docsDir).filter((d) => d.kind === 'decision')
const hits = new Map()
for (const f of files) {
  for (const d of matchDocs(docs, { relPath: f, repoName })) {
    if (!hits.has(d.id)) hits.set(d.id, d)
  }
}

const log = (fired) =>
  record({
    event: 'sync',
    repo: repoName,
    session: input.session_id,
    fired,
    files: files.length,
    candidates: [...hits.keys()],
    docs: docsSnapshot(docsDir),
  })

if (!hits.size) {
  log(false)
  process.exit(0)
}
log(true)

emit(
  'PreToolUse',
  [
    '設計文書との照合（speclink）。**コミットは止めない。**',
    '',
    `${docsDir} の doc-sync の手順に従い、下の決定と今の変更が食い違っていないかを見ること。`,
    '報告するのは 2 種類だけ。**該当が無ければ何も言わずに進める。**',
    '',
    '- 矛盾の疑い … 変更後のコードが、その決定に反している',
    '- 文書が古い疑い … 決定が指す箇所が大きく変わり、前提が成り立たなくなっている',
    '',
    '「紐づく文書が無い変更」はここでは扱わない（コミット前の確認が同じものを見ている）。',
    '',
    '### 今の変更に効く決定',
    ...[...hits.values()].map(
      (d) => `- ${d.id} ${d.title}\n  ${d.summary || ''}\n  ${path.join(docsDir, d.file)}`,
    ),
  ].join('\n'),
)
