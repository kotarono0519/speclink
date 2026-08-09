#!/usr/bin/env node
// 決定が「形として現れた瞬間」を捕まえる。
//
// 言葉で探さない（「1 はこれで良い」のような実際の決定の言い回しは検出できず、
// 逆に相槌や説明文を拾って誤検知だらけになるため）。
// 選択肢から選ばれた・計画が承認された、という構造的な合図だけを使う。
//
// 選ばれなかった選択肢がそのまま「却下した案」になる。理由を聞き直す必要がない。
import fs from 'node:fs'
import path from 'node:path'
import { readHookInput, resolveDocsDir, emit } from './lib/docs.mjs'

const input = await readHookInput()
const docsDir = resolveDocsDir(input.cwd || process.cwd())
if (!docsDir) process.exit(0)

const tool = input.tool_name
if (tool !== 'AskUserQuestion' && tool !== 'ExitPlanMode') process.exit(0)

// 同じ会話で促しすぎない。1 回の会話で 3 回まで。
const dataDir = process.env.CLAUDE_PLUGIN_DATA
const MAX_PER_SESSION = 3
if (dataDir && input.session_id) {
  try {
    const dir = path.join(dataDir, 'nudge')
    fs.mkdirSync(dir, { recursive: true })
    const file = path.join(dir, `${input.session_id}.json`)
    const count = fs.existsSync(file)
      ? JSON.parse(fs.readFileSync(file, 'utf8')).count
      : 0
    if (count >= MAX_PER_SESSION) process.exit(0)
    fs.writeFileSync(file, JSON.stringify({ count: count + 1 }))
  } catch {
    // 記録できなくても本題は続ける
  }
}

const common = [
  '設計文書の記録（speclink）。**いま決定が 1 つ確定した。**',
  '',
  'これが設計判断（作り方の選択・仕様の方針）なら、/doc-new の手順で決定を残すこと。',
  '**ユーザーに却下理由を聞き直さない。** 選ばれなかった案とその説明が、そのまま却下理由になる。',
  '',
  '残さなくてよいのは次のとき。黙って進める。',
  '- 作業の進め方・順番だけを決めた（何をどう作るかが変わらない）',
  '- コードを読めば分かることしか決まっていない',
  '- 同じ内容の決定が既に文書にある',
  '',
  `文書の場所: ${docsDir}`,
]

if (tool === 'AskUserQuestion') {
  const questions = input.tool_input?.questions ?? []
  const answers = input.tool_input?.answers ?? {}
  // 選ばれた答えは tool_input.answers に入るが、無い場合もあるので
  // 実行結果の本文を控えとして添える（採用がどれか分からないまま印を付けない）。
  const output =
    typeof input.tool_output === 'string' ? input.tool_output.trim() : ''

  const detail = questions
    .map((q) => {
      const chosen = answers?.[q.question]
      const opts = (q.options ?? [])
        .map((o) => {
          const why = o.description ? ` — ${o.description}` : ''
          if (!chosen) return `  - ${o.label}${why}`
          return `  [${o.label === chosen ? '採用' : '却下'}] ${o.label}${why}`
        })
        .join('\n')
      return `問い: ${q.question}\n${opts}`
    })
    .join('\n\n')

  const tail = Object.keys(answers).length
    ? []
    : ['', `（どれが選ばれたかは実行結果を見ること）`, output].filter(Boolean)

  emit(
    'PostToolUse',
    [...common, '', '### 確定した内容', detail, ...tail].join('\n'),
  )
}

emit(
  'PostToolUse',
  [
    ...common,
    '',
    '### 確定した内容',
    '計画が承認された。計画に含まれる設計判断（作り方の選択）だけを残す。',
    '実装の手順そのものは残さない。',
  ].join('\n'),
)
