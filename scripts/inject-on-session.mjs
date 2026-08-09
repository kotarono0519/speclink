#!/usr/bin/env node
// 会話の開始時に、文書の一覧（題名 + 1 行）を差し込む。スキルの一覧と同じ仕組み。
// 本文は入れない。必要になったときだけ開かせる。
import { loadDocs, readHookInput, resolveDocsDir, emit } from './lib/docs.mjs'

const MAX_LINES = 250 // これを超えたら一覧をやめて件数だけ告げる

const input = await readHookInput()
const docsDir = resolveDocsDir(input.cwd || process.cwd())
if (!docsDir) process.exit(0)

const docs = loadDocs(docsDir).filter((d) => d.status === 'active')
if (!docs.length) process.exit(0)

const header =
  `## 設計文書（speclink）\n` +
  `場所: ${docsDir}\n` +
  `設計を始める前・仕様を判断する前に、関係する文書を開いて読むこと。` +
  `新しく何かを決めたら /doc-new で残すこと。\n`

if (docs.length > MAX_LINES) {
  emit(
    'SessionStart',
    header +
      `\n文書が ${docs.length} 件あります。一覧は ${docsDir}/INDEX.md を読んでください。\n`,
  )
}

const label = { requirement: '要件', usecase: 'ユースケース', decision: '決定' }
const sections = ['requirement', 'usecase', 'decision']
  .map((kind) => {
    const list = docs
      .filter((d) => d.kind === kind)
      .sort((a, b) => String(a.id).localeCompare(String(b.id)))
    if (!list.length) return ''
    const lines = list.map((d) => {
      const scope = d.paths.length ? ` … ${d.paths.join(' ')}` : ''
      return `- ${d.id} ${d.title}${scope}`
    })
    return `\n### ${label[kind]}\n${lines.join('\n')}`
  })
  .join('\n')

emit('SessionStart', header + sections + '\n')
