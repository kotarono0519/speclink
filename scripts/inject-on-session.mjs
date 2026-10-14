#!/usr/bin/env node
// 会話の開始時に、文書の置き場所と件数だけを知らせる。
// 一覧は差し込まない（件数で挙動を変えると切り分けができなくなるため、常にこの形）。
// 例外は「指し先のファイルが消えている文書」の 1 行だけ（あるときだけ末尾に足す）。
// 引き当ての本体はコード編集の直前に行うので、ここは案内だけでよい。
import {
  loadDocs,
  missingDocPaths,
  readHookInput,
  resolveDocsDir,
  resolveRepoDir,
  emit,
} from './lib/docs.mjs'
import { repoOf } from './lib/log.mjs'
import { pendingDocsChanges, pullDocs } from './sync-docs.mjs'

const input = await readHookInput()
const docsDir = resolveDocsDir(input.cwd || process.cwd())
if (!docsDir) process.exit(0)

// 文書置き場が独立したリポジトリなら、索引を読む前に 1 回だけ取り込む（もう一方のPCの決定を見るため）。
// 早送りだけ・5 秒で打ち切り。失敗しても会話は止めず、手元の索引のまま読む。
const pulled = pullDocs(docsDir, 5000)
const pullLine = pulled.done && !pulled.ok
  ? `文書置き場の取り込みに失敗した（手元の記録のまま読む）: ${pulled.message.split('\n')[0]}\n`
  : ''

// 書いた会話がコミット前に終わると、記録は誰にも拾われずに残り、もう一方のPCから見えない。
// フック自身はコミットしない（コミット前のレビューの関所を素通りするため）。Claude に入れさせる。
const pending = pendingDocsChanges(docsDir)
const shown = pending.slice(0, 5).join(' / ') + (pending.length > 5 ? ` ほか ${pending.length - 5} 件` : '')
const pendingLine = pending.length
  ? `文書置き場に未コミットの記録が ${pending.length} 件ある（別の会話の書き残し）: ${shown}。` +
    `中身を一読して壊れていなければ、確認を取らずにコミットして push すること` +
    `（決めたことを残す手順の 6 と同じ。登録するのは記録と自動生成の索引だけ）。\n`
  : ''

const docs = loadDocs(docsDir).filter((d) => d.status === 'active')
if (!docs.length) process.exit(0)

// 指し先のファイルが消えている文書（親フォルダはあるのにファイルが無い）だけを 1 行で知らせる。
// コミット時の点検（fix-doc-paths）が止め損ねた分の受け皿。まだ作っていない場所を指す
// 先行設計の文書（親フォルダごと無い）は正常なので数えない。
const projectDir = resolveRepoDir(input)
const { repo: repoName } = repoOf(projectDir)
const gone = missingDocPaths(docs, projectDir, repoName).gone.map((g) => `${g.id}（${g.path}）`)
const goneLine = gone.length
  ? `指し先のファイルが消えている文書が ${gone.length} 件: ${gone.join(' / ')}。移動先へ直すか、不要なら status を superseded にすること。\n`
  : ''

emit(
  'SessionStart',
  `## 設計文書の索引（speclink）\n` +
    `${docsDir}/llms.txt に設計文書の索引がある（${docs.length} 件）。\n` +
    `設計・仕様の判断を始める前にこの索引を読み、関係する文書だけを開くこと。\n` +
    `新しく決めたことは、決めたことを残す手順（speclink の doc-new スキル）で残すこと。人に聞かずに書く。\n` +
    goneLine +
    pullLine +
    pendingLine,
)
