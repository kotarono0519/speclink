#!/usr/bin/env node
// コードを編集する直前に、その場所に効く決定を差し出す。
// 方針: 狭めに出す。該当が多いときは件数だけ告げる（オオカミ少年にしない）。
import path from 'node:path'
import {
  loadDocs,
  matchDocs,
  readHookInput,
  resolveDocsDir,
  emit,
  seenFilter,
} from './lib/docs.mjs'

const MAX_SHOWN = 3

const input = await readHookInput()
const docsDir = resolveDocsDir(input.cwd || process.cwd())
if (!docsDir) process.exit(0)

const filePath = input.tool_input?.file_path
if (!filePath) process.exit(0)

const projectDir = process.env.CLAUDE_PROJECT_DIR || input.cwd || process.cwd()
const relPath = path.relative(projectDir, filePath)
const repoName = path.basename(projectDir)
if (relPath.startsWith('..')) process.exit(0)

// 編集内容（項目名での引き当てに使う）
const ti = input.tool_input ?? {}
const content = [ti.new_string, ti.content, ti.old_string]
  .filter(Boolean)
  .join('\n')

const docs = loadDocs(docsDir)
const hits = matchDocs(docs, { relPath, content, repoName }).filter(
  (d) => d.kind === 'decision',
)
if (!hits.length) process.exit(0)

// 同じ会話で一度出したものは繰り返さない
const freshIds = new Set(
  seenFilter(
    input.session_id,
    hits.map((h) => h.id),
  ),
)
const fresh = hits.filter((h) => freshIds.has(h.id))
if (!fresh.length) process.exit(0)

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

emit('PreToolUse', text)
