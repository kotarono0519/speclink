#!/usr/bin/env node
// 文書置き場の骨組みを作り、プロジェクトから参照できるようにする。
// 使い方: node init-docs.mjs <文書ディレクトリ> [プロジェクトディレクトリ]
import fs from 'node:fs'
import path from 'node:path'
import { KINDS } from './lib/docs.mjs'

const docsDir = path.resolve(process.argv[2] || '')
const projectDir = path.resolve(
  process.argv[3] || process.env.CLAUDE_PROJECT_DIR || process.cwd(),
)

if (!process.argv[2]) {
  console.error('文書ディレクトリを指定してください。')
  process.exit(1)
}

const created = []

for (const kind of KINDS) {
  const dir = path.join(docsDir, kind)
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(path.join(dir, '.gitkeep'), '')
    created.push(path.relative(docsDir, dir))
  }
}

const readme = path.join(docsDir, 'README.md')
if (!fs.existsSync(readme)) {
  fs.writeFileSync(
    readme,
    `# ${path.basename(docsDir)}

このリポジトリの設計文書。speclink が引き当てて使う。

| フォルダ | 何を書くか |
| --- | --- |
| \`requirements/\` | なぜこの機能が要るか（業務の事情） |
| \`usecases/\` | 誰が何を達成するか（引き当ての鍵を持つ） |
| \`decisions/\` | なぜその作りにしたか（却下案と理由） |

- 一覧は [llms.txt](llms.txt)。**自動生成なので手で編集しない。**
- 新しく決めたことは \`/doc-new\` で残す。
- 変更と文書のズレは \`/doc-sync\` で確認する。
- 書き方の規約は speclink の \`reference/format.md\`。

**コードを読めば復元できることは書かない。** 復元できないもの（なぜそうしたか・
何を捨てたか・業務の事情）だけが保管に値する。
`,
  )
  created.push('README.md')
}

const gitignore = path.join(docsDir, '.gitignore')
if (!fs.existsSync(gitignore)) {
  fs.writeFileSync(gitignore, '.DS_Store\n')
  created.push('.gitignore')
}

// プロジェクト側から文書置き場を指す設定。リポジトリに残るので他の人の環境でも同じ場所を指す。
const confPath = path.join(projectDir, '.speclink.json')
let rel = path.relative(projectDir, docsDir)
if (!rel.startsWith('.')) rel = './' + rel
if (!fs.existsSync(confPath)) {
  fs.writeFileSync(confPath, JSON.stringify({ docsDir: rel }, null, 2) + '\n')
  created.push(`(プロジェクト側) .speclink.json -> ${rel}`)
}

console.log(
  created.length
    ? '作成しました:\n' + created.map((c) => '  ' + c).join('\n')
    : 'すべて既にありました。',
)
console.log(`文書ディレクトリ: ${docsDir}`)
