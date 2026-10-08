#!/usr/bin/env node
// コミットする直前に、これから入る差分をレビューさせる。
//
// 役割分担（コミット時に動く 3 つのフックで重複させない）:
//   check-on-commit … これから何を文書に残すか（できることが変わったか／却下案があるか）
//   invoke-sync     … 既にある決定と食い違っていないか
//   review-on-commit（これ） … コードそのものの欠陥・波及漏れ・コミットの完結性
//
// ここだけは止める。レビューしてから入れるのが目的なので、通してしまうと
// 「後から直して amend」になり、履歴に一度壊れたコミットが残るため。
// ただし止め続けはしない。同じ内容で 2 回止めたらそのまま通す（作業が詰むのを避ける）。
//
// 流れ: 1 回目は deny（レビュー手順を渡す）→ Claude がレビューと修正 →
//       `node review-on-commit.mjs --reviewed` で記録 → 同じコミットが通る。
import { execFileSync } from 'node:child_process'
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import {
  gitPathOf,
  gitRootOf,
  pendingCommitGit,
  readHookInput,
  resolveDocsDir,
  resolveRepoDir,
} from './lib/docs.mjs'
import { record, docsSnapshot, repoOf } from './lib/log.mjs'

const SELF = path.resolve(process.argv[1])

// --- 記録モード（Claude がレビュー後に自分で実行する） ---------------------
// フックではないので標準入力は読まない（読むと環境によっては待ち続ける）。
if (process.argv.includes('--reviewed')) {
  // 対象のリポジトリは引数で受け取る。会話の起点（CLAUDE_PROJECT_DIR）は当てにしない
  // （複数のリポジトリを収めた親フォルダから起動されていると差分が取れず、
  //  記録できないまま同じコミットがまた止まる）。
  const arg = process.argv[process.argv.indexOf('--reviewed') + 1]
  const dir =
    gitRootOf(arg && !arg.startsWith('-') ? arg : process.cwd()) ??
    gitRootOf(process.env.CLAUDE_PROJECT_DIR ?? '') ??
    process.cwd()
  const fp = fingerprints((args) => git(dir, args))
  if (!fp) {
    console.log('レビュー済みとして記録できませんでした（git の差分が取れません）。')
    process.exit(0)
  }
  writeState(dir, { ...fp, reviewed: true, denials: 0, at: Date.now() })
  console.log('コミット前レビューを済みとして記録しました。そのままコミットできます。')
  process.exit(0)
}

// --- フックモード -----------------------------------------------------------
const input = await readHookInput()

const command = input.tool_input?.command ?? ''
if (!/\bgit\b[^|;&]*\bcommit\b/.test(command)) process.exit(0)
// 履歴を書き換えるだけの操作は対象外（レビュー後の取り込みで再発火させない）
if (/--amend|--no-edit/.test(command)) process.exit(0)

// speclink を使っていないプロジェクトでは何もしない
const docsDir = resolveDocsDir(input.cwd || process.cwd())
if (!docsDir) process.exit(0)

const projectDir = resolveRepoDir(input)
const all = /(^|\s)(-[a-zA-Z]*a[a-zA-Z]*|--all)(\s|$)/.test(command)

// 命令文の中の `git add` まで済ませた状態で見る（済ませる前だと差分が空で素通りする）
const view = pendingCommitGit(projectDir, command, input.cwd || process.cwd())
process.on('exit', view.cleanup)

// レビューする値打ちのある変更があるか。文書・lock だけのコミットは通す。
const files = changedFiles(view.git, all)
const NOISE =
  /(^|\/)(package-lock\.json|pnpm-lock\.yaml|yarn\.lock)$|\.(md|txt|snap|lock)$|(^|\/)\.(github|vscode)\//
const meaningful = files.filter((f) => !NOISE.test(f))
if (!meaningful.length) process.exit(0)

const fp = fingerprints(view.git)
if (!fp) process.exit(0)
const mine = all ? fp.working : fp.staged
const state = readState(projectDir)
// 記録（--reviewed）は本物の索引で指紋を取る。登録をつないだ命令文（git add … && git commit）では
// こちらは登録後の写しで取るので、登録前に記録されていると staged どうしは一致しない。その場合、
// 写しの登録後の差分は作業コピー全体の差分と同じになるので、記録側の working とも突き合わせる
const same =
  Boolean(state) &&
  ((all ? state.working : state.staged) === mine || (view.adds > 0 && state.working === mine))
// 指紋が合わなくても、直前の記録が 10 分以内なら「同じコミットをやり直している」とみなして回数を
// 引き継ぐ（登録の手順を飛ばされると指紋が毎回ずれ、2 回で諦める安全弁に一生届かないため）
const recent = Boolean(state) && Date.now() - (state.at ?? 0) < 10 * 60 * 1000
const priorDenials = same || recent ? (state.denials ?? 0) : 0

const { repo: repoName, worktree } = repoOf(projectDir)
const log = (fired, note) =>
  record({
    event: 'review',
    repo: repoName,
    worktree,
    session: input.session_id,
    fired,
    files: meaningful.length,
    note,
    docs: docsSnapshot(docsDir),
  })

// レビュー済みの記録があれば通す（記録は使い切る）
if (same && state.reviewed) {
  clearState(projectDir)
  log(false, 'reviewed')
  process.exit(0)
}

// 同じ内容で 2 回止めたら、それ以上は止めない（作業が詰むのを避ける）
if (priorDenials >= 2) {
  clearState(projectDir)
  log(false, 'gave-up')
  process.stdout.write(
    JSON.stringify({
      suppressOutput: true,
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        additionalContext:
          'コミット前レビュー（speclink）: レビュー済みの記録が無いまま 2 回目なので、今回はこのまま通します。レビューを飛ばしたのなら、コミット後にその旨をユーザーへ伝えてください。',
      },
    }),
  )
  process.exit(0)
}

writeState(projectDir, {
  ...fp,
  reviewed: false,
  denials: priorDenials + 1,
  at: Date.now(),
})
log(true)

const target = all ? 'git diff HEAD' : 'git diff --cached'
const reason = [
  'コミット前レビュー（speclink）。**このコミットはいったん止めました。** 下の手順でレビューしてから入れてください。',
  '',
  ...(view.adds
    ? [
        '### 0. 先に登録だけ済ませる',
        'この命令文は登録（`git add`）とコミットをつないでいる。止めたので登録もまだ走っていない。',
        '**`git add` の部分だけを単独で先に実行する**（レビューする差分と、記録の指紋がそれで揃う）。',
        '',
      ]
    : []),
  '### 1. レビューする',
  `Agent ツールでサブエージェント（general-purpose）を 1 つ起動し、\`${target}\`（これから入る差分）とコミットメッセージ案を次の観点でレビューさせる:`,
  '',
  '- **波及漏れ** … 変更した箇所を使っている呼び出し側・似た作りの兄弟・説明文（CLAUDE.md の現状欄など）が取り残されていないか',
  '- **一貫性** … 同じことの二重実装、既存の命名・規約からのズレ',
  '- **コミットの完結性** … メッセージと差分の食い違い、無関係な変更の混入、デバッグ用コードの消し忘れ',
  '- **明らかなバグ** … ロジックの誤り・null 安全・境界条件（深掘りはしない）',
  '',
  'サブエージェントには「直すべき指摘」と「問題なし」を分けて報告させる。',
  '**設計文書との整合は別のフックが見ているので、ここでは扱わない。**',
  '',
  '### 2. 指摘があれば直す',
  'あなた（メインセッション）が修正を適用し、このリポジトリの決まった確認（lint / 整形 / 型検査、あれば `/commit` スキルの手順）を通してから `git add` し直す。',
  '',
  '### 3. 記録してコミットし直す',
  '```shell',
  `node "${SELF}" --reviewed "${projectDir}"`,
  '```',
  'を実行してから、同じコミットコマンドをもう一度実行する（この記録がある間は止めない）。',
  '',
  'レビュー結果（指摘の有無・直した内容）は日本語でユーザーに報告する。指摘ゼロなら「コミット前レビュー: 問題なし」の一言でよい。',
].join('\n')

process.stdout.write(
  JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'deny',
      permissionDecisionReason: reason,
    },
  }),
)
process.exit(0)

// --- ここから道具 -----------------------------------------------------------

function git(dir, args) {
  try {
    return execFileSync('git', args, {
      cwd: dir,
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
      stdio: ['ignore', 'pipe', 'ignore'],
    })
  } catch {
    return null
  }
}

/** コミット対象のファイル名。-a 付きなら未ステージの変更も含む */
function changedFiles(run, all) {
  const out = [run(['diff', '--cached', '--name-only'])]
  if (all) out.push(run(['diff', '--name-only']))
  return out
    .filter(Boolean)
    .join('\n')
    .split('\n')
    .filter(Boolean)
}

/**
 * 差分の中身から指紋を作る。ファイル名だけだと、レビュー後に中身を直しても
 * 同じ指紋になり「レビュー済み」のまま通ってしまうため、中身で取る。
 */
function fingerprints(run) {
  const staged = run(['diff', '--cached'])
  if (staged === null) return null
  const unstaged = run(['diff']) ?? ''
  const h = (s) => crypto.createHash('sha256').update(s).digest('hex').slice(0, 16)
  return { staged: h(staged), working: h(staged + unstaged) }
}

/** 記録の置き場所（作業コピーでも正しい場所に置く） */
function statePath(dir) {
  return gitPathOf(dir, 'speclink-review')
}

function readState(dir) {
  try {
    const file = statePath(dir)
    if (!file || !fs.existsSync(file)) return null
    return JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch {
    return null
  }
}

function writeState(dir, state) {
  try {
    const file = statePath(dir)
    if (!file) return
    fs.writeFileSync(file, JSON.stringify(state))
  } catch {
    // 記録できなくても本題は続ける（次回また止まるだけ）
  }
}

function clearState(dir) {
  try {
    const file = statePath(dir)
    if (file && fs.existsSync(file)) fs.unlinkSync(file)
  } catch {
    // 消せなくても構わない
  }
}
