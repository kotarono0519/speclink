#!/usr/bin/env node
// 文書の冒頭情報から索引を組み立てる。手で書かない（手で書くと必ず腐るため）。
// 出力: <docs>/INDEX.md（人が読む） と <docs>/.speclink/index.json（機械が読む）
import fs from 'node:fs'
import path from 'node:path'
import { loadDocs, resolveDocsDir, KINDS } from './lib/docs.mjs'

const docsDir = process.argv[2] || resolveDocsDir(process.cwd())
if (!docsDir) {
  console.error('文書ディレクトリが見つかりません。')
  process.exit(1)
}

const docs = loadDocs(docsDir)
const byKind = Object.fromEntries(
  KINDS.map((k) => [k, docs.filter((d) => d.kind === k.replace(/s$/, ''))]),
)

for (const list of Object.values(byKind)) {
  list.sort((a, b) => String(a.id).localeCompare(String(b.id)))
}

// 機械が読む索引
const indexDir = path.join(docsDir, '.speclink')
fs.mkdirSync(indexDir, { recursive: true })
fs.writeFileSync(
  path.join(indexDir, 'index.json'),
  JSON.stringify({ generatedFrom: 'speclink', docs }, null, 2) + '\n',
)

// 人が読む索引。1 文書 1 行を守る（3 行に増やすと入口のコストが 3 倍になる）
const label = {
  requirements: '要件',
  usecases: 'ユースケース',
  decisions: '決定',
}
const lines = ['# 索引', '', '<!-- speclink が自動生成。手で編集しない。 -->', '']
for (const kind of KINDS) {
  const list = byKind[kind]
  if (!list.length) continue
  lines.push(`## ${label[kind]}`, '')
  for (const d of list) {
    const flag = d.status === 'active' ? '' : ` [${d.status}]`
    const summary = d.summary ? ` — ${d.summary}` : ''
    lines.push(`- [${d.id}](${d.file}) ${d.title}${flag}${summary}`)
  }
  lines.push('')
}
fs.writeFileSync(path.join(docsDir, 'INDEX.md'), lines.join('\n'))

// 範囲指定の粗さを検査する。フォルダ全体を指す書き方は発火しすぎの原因になる。
const tooBroad = docs.filter((d) =>
  d.paths.some((p) => /^(src\/)?[^/]+\/\*\*\/?$/.test(p) || p === '**'),
)
if (tooBroad.length) {
  console.warn(
    '範囲指定が粗い文書があります（発火しすぎの原因）:\n' +
      tooBroad.map((d) => `  ${d.id} ${d.paths.join(', ')}`).join('\n'),
  )
}

console.log(
  `索引を更新しました: 要件 ${byKind.requirements.length} / ユースケース ${byKind.usecases.length} / 決定 ${byKind.decisions.length}`,
)
