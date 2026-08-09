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

// 索引は llms.txt の規約に従う（H1 → 引用の要約 → H2 の節 → 「- [題名](場所): 説明」）。
// 会話の開始時にはこのファイルの場所だけを知らせ、中身は必要になったときに開かせる。
// 破棄済みの文書は「Optional」の節へ置く（規約上「余裕が無ければ飛ばしてよい」節）。
const label = {
  requirements: '要件',
  usecases: 'ユースケース',
  decisions: '決定',
}
const projectName = path.basename(docsDir)

const entry = (d) => {
  const note = d.summary || d.title
  return `- [${d.id} ${d.title}](${d.file}): ${note}`
}

const lines = [
  `# ${projectName}`,
  '',
  '> このリポジトリの設計文書の索引。設計や仕様の判断を始める前にここを読み、',
  '> 関係する文書だけを開くこと。新しく決めたことは /doc-new で残すこと。',
  '',
  'speclink が自動生成する。手で編集しない。',
  '',
  '各文書の冒頭には対象範囲（どのコードに効くか）が書いてある。',
  'コードを触るときは speclink が該当する決定を自動で差し出すので、ここを読む必要はない。',
  '',
]

for (const kind of KINDS) {
  const list = byKind[kind].filter((d) => d.status === 'active')
  if (!list.length) continue
  lines.push(`## ${label[kind]}`, '')
  list.forEach((d) => lines.push(entry(d)))
  lines.push('')
}

// 破棄・却下された文書。履歴として残すが、平常時は読ませない。
const retired = docs.filter((d) => d.status !== 'active')
if (retired.length) {
  lines.push('## Optional', '')
  lines.push('過去の文書（破棄・却下済み）。経緯を追うとき以外は読まなくてよい。', '')
  retired.forEach((d) => lines.push(`${entry(d)}（${d.status}）`))
  lines.push('')
}

const indexBody = lines.join('\n')
fs.writeFileSync(path.join(docsDir, 'llms.txt'), indexBody)
fs.writeFileSync(path.join(docsDir, 'INDEX.md'), indexBody)

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
