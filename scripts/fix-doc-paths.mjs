#!/usr/bin/env node
// コミット時に、文書の「対象範囲」の指し先を実態に合わせて直す。
//
// ファイル名を変えると文書の紐付けが黙って切れる（文書は残るのに、そのファイルを
// 触っても何も出てこなくなり、誰も気づかない）。これを自動で防ぐ。
//
// 自動で直すのはリネームだけ。git が「この名前がこの名前になった」と追跡している場合に限る。
// 削除されただけの場合は、どこへ移ったか機械には分からない（推測で直さない）。生きている文書が
// 指しているファイルを消すコミットは一度止め、人に指し先を直させてから入れる。
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import {
  loadDocs,
  missingDocPaths,
  pendingCommitGit,
  readHookInput,
  resolveDocsDir,
  resolveRepoDir,
  isCommitCommand,
  commandTargetsForeignRepo,
  emit,
} from './lib/docs.mjs'
import { record, docsSnapshot, repoOf } from './lib/log.mjs'

const input = await readHookInput()

const command = input.tool_input?.command ?? ''
if (!isCommitCommand(command)) process.exit(0)
// cd / git -C で持ち場と関係しない別のリポジトリへ移ってからのコミットは対象外
if (commandTargetsForeignRepo(input)) process.exit(0)

const docsDir = resolveDocsDir(input.cwd || process.cwd())
if (!docsDir) process.exit(0)

const projectDir = resolveRepoDir(input)
// 命令文の中の `git add` まで済ませた状態で見る（済ませる前だと差分が空で素通りする。
// `git add -A && git commit` のつなぎ方では、消すファイルの検出も改名の追従も全部空振りになる）
const view = pendingCommitGit(projectDir, command, input.cwd || process.cwd())
process.on('exit', view.cleanup)
const git = (args) => view.git(args) ?? ''

// -M でリネームを検出する（R100 old new のような行になる）
const nameStatus = git(['diff', '--cached', '--name-status', '-M'])
if (!nameStatus.trim()) process.exit(0)

const renames = []
const deletions = []
for (const line of nameStatus.split('\n').filter(Boolean)) {
  const cols = line.split('\t')
  const status = cols[0][0]
  if (status === 'R' && cols.length >= 3) renames.push({ from: cols[1], to: cols[2] })
  else if (status === 'D') deletions.push(cols[1])
}
if (!renames.length && !deletions.length) process.exit(0)

const { repo: repoName, worktree } = repoOf(projectDir)
const docs = loadDocs(docsDir)
const fixed = []

// 文書側の指し先は「リポジトリ名/パス」で書かれていることがある。
// いま作業しているリポジトリのものだけを対象にする。
const docPathsFor = (from) => [from, `${repoName}/${from}`]

// 1. リネームに追従する（完全一致の指し先だけを書き換える。glob は当てずに残す）
for (const { from, to } of renames) {
  for (const doc of docs) {
    const hit = docPathsFor(from).find((p) => doc.paths.includes(p))
    if (!hit) continue
    const file = path.join(docsDir, doc.file)
    const text = fs.readFileSync(file, 'utf8')
    const end = text.indexOf('\n---', 3)
    if (end === -1) continue
    // 冒頭の情報欄の中だけを書き換える（本文の同じ文字列は触らない）
    const replacement = hit.startsWith(`${repoName}/`) ? `${repoName}/${to}` : to
    const head = text.slice(0, end).split(hit).join(replacement)
    fs.writeFileSync(file, head + text.slice(end))
    fixed.push(`${doc.id}: ${hit} → ${replacement}`)
  }
}

// 2. このコミットで消すファイルを、生きている文書が指していないか（指していたら止める）
//
// 消えただけのファイルは行き先が機械には分からないので、直せるのは人（メインセッション）だけ。
// 以前は案内（additionalContext）で知らせていたが、止めないので読み飛ばされ、miroir-fe では
// 2 ファイルの削除が 4 文書の指し先を切ったまま 18 回のコミットを素通りした。消すその瞬間なら
// 行き先を知っているので、ここで止めて直させる。直せば指し先が消えるので、同じコミットが通る。
const deletedPointed = []
for (const gone of deletions) {
  for (const doc of docs) {
    if (doc.status !== 'active') continue
    const hit = docPathsFor(gone).find((p) => doc.paths.includes(p))
    if (hit) deletedPointed.push({ id: doc.id, path: hit, file: path.join(docsDir, doc.file) })
  }
}

// 3. 以前から消えたままの指し先を洗い出す（直さない）。
//    親ディレクトリごと無いものは「まだ作っていない場所」（先行設計）なので数えるだけにし、
//    親はあるのにファイルが無いもの（消えた・改名された疑い）だけを名指しする。
//    混ぜて出すと本当に消えたものが埋もれる（miroir-fe では 14 件の中に 2 件が埋もれた）。
const pointedNow = new Set(deletedPointed.map((d) => d.path)) // 2. で止める分は除く
const missing = missingDocPaths(
  loadDocs(docsDir).filter((d) => d.status === 'active'),
  projectDir,
  repoName,
  (p) => pointedNow.has(p),
)
const brokenPaths = missing.gone.map((g) => `${g.id}: ${g.path}`)
const notYetCount = missing.notYet

record({
  event: 'paths',
  repo: repoName,
  worktree,
  session: input.session_id,
  fired: Boolean(fixed.length || brokenPaths.length || deletedPointed.length),
  renamed: fixed.length,
  broken: brokenPaths.length,
  stopped: deletedPointed.length,
  docs: docsSnapshot(docsDir),
})

// 索引を作り直す（改名に追従して指し先が変わったため。止める場合でも先に済ませる）
if (fixed.length) rebuildIndex()

if (deletedPointed.length) {
  const reason = [
    'このコミットで消すファイルを、設計文書が対象範囲として指しています（speclink）。',
    ...(fixed.length
      ? [
          '',
          '（改名には追従して、次の文書の指し先を自動で直した。文書リポジトリにこの変更が入っている:',
          ...fixed.map((f) => `  - ${f}`),
          '）',
        ]
      : []),
    '消えたファイルの行き先は機械には分からないので、コミットの前に文書の指し先を直してください:',
    ...deletedPointed.map((d) => `  - ${d.id} が ${d.path} を指している（${d.file}）`),
    '',
    '直し方（文書の冒頭の情報欄 `scope.paths` だけを書き換える。本文は触らない）:',
    '- 役割が別のファイルへ移ったなら、その移動先のパスに書き換える',
    '- 機能ごと無くなったなら、そのパスを `scope.paths` から外す（決定そのものが不要になったなら `status: superseded` にする）',
    '',
    '直したら索引を作り直してから、同じコミットコマンドをもう一度実行する（指し先が消えていれば止めない）:',
    '```shell',
    `node "${path.join(process.env.CLAUDE_PLUGIN_ROOT ?? '.', 'scripts/build-index.mjs')}" "${docsDir}"`,
    '```',
    '何をどう直したかは日本語でユーザーに報告する。',
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
}

if (!fixed.length && !brokenPaths.length) process.exit(0)

const parts = ['設計文書の指し先の点検（speclink）。']
if (fixed.length) {
  parts.push(
    '',
    '**リネームに追従して自動で直した**（文書の紐付けが切れるのを防いだ）:',
    ...fixed.map((f) => `  - ${f}`),
    '',
    `文書リポジトリ（${docsDir}）に変更が入っている。こちらも忘れずにコミットすること。`,
  )
}
if (brokenPaths.length) {
  parts.push(
    '',
    '**指し先のファイルが消えている**（親フォルダはあるのにファイルが無い。移動先が分かるなら直すこと。',
    '不要になった決定なら status を superseded にする）:',
    ...brokenPaths.map((b) => `  - ${b}`),
  )
  if (notYetCount) parts.push(`（ほかに、まだ作っていない場所を指す先行設計の指し先が ${notYetCount} 件。これは問題ない）`)
}

emit('PreToolUse', parts.join('\n'))

function rebuildIndex() {
  try {
    execFileSync(
      'node',
      [path.join(process.env.CLAUDE_PLUGIN_ROOT ?? '.', 'scripts/build-index.mjs'), docsDir],
      { encoding: 'utf8' },
    )
  } catch {
    // 索引の再生成に失敗しても、指し先の修正自体は済んでいる
  }
}
