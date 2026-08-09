#!/usr/bin/env node
// 会話の開始時に、文書の置き場所と件数だけを知らせる。
// 一覧は差し込まない（件数で挙動を変えると切り分けができなくなるため、常にこの形）。
// 引き当ての本体はコード編集の直前に行うので、ここは案内だけでよい。
import { loadDocs, readHookInput, resolveDocsDir, emit } from './lib/docs.mjs'

const input = await readHookInput()
const docsDir = resolveDocsDir(input.cwd || process.cwd())
if (!docsDir) process.exit(0)

const docs = loadDocs(docsDir).filter((d) => d.status === 'active')
if (!docs.length) process.exit(0)

emit(
  'SessionStart',
  `## 設計文書の索引（speclink）\n` +
    `${docsDir}/llms.txt に設計文書の索引がある（${docs.length} 件）。\n` +
    `設計・仕様の判断を始める前にこの索引を読み、関係する文書だけを開くこと。\n` +
    `新しく決めたことは /doc-new で残すこと。\n`,
)
