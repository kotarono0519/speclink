#!/usr/bin/env node
// コミットしようとした瞬間を関所にする。決めたことを残し忘れるのを防ぐ。
//
// 役割分担: 機械は「安い手がかり」で一次選別だけを行い、
//           設計判断を含むかどうかの最終判断は Claude にさせる。
// 止めない。警告だけ（コミットを止めると邪魔者になり、そのうち外されるため）。
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import {
  loadDocs,
  matchDocs,
  readHookInput,
  resolveDocsDir,
  emit,
} from './lib/docs.mjs'
import { record, docsSnapshot } from './lib/log.mjs'

const input = await readHookInput()

// git commit のときだけ働く
const command = input.tool_input?.command ?? ''
if (!/\bgit\b[^|;&]*\bcommit\b/.test(command)) process.exit(0)
// 履歴を書き換えるだけの操作は対象外（本フックは再発火しない前提の操作）
if (/--amend|--no-edit/.test(command)) process.exit(0)

const docsDir = resolveDocsDir(input.cwd || process.cwd())
if (!docsDir) process.exit(0)

const projectDir = process.env.CLAUDE_PROJECT_DIR || input.cwd || process.cwd()
const git = (args) => {
  try {
    return execFileSync('git', args, { cwd: projectDir, encoding: 'utf8' })
  } catch {
    return ''
  }
}

// コミット対象のファイル。-a 付きなら未ステージの変更も含む
const staged = git(['diff', '--cached', '--name-status'])
const unstaged = /(^|\s)(-[a-zA-Z]*a[a-zA-Z]*|--all)(\s|$)/.test(command)
  ? git(['diff', '--name-status'])
  : ''
const rows = (staged + unstaged)
  .split('\n')
  .filter(Boolean)
  .map((line) => {
    const [statusRaw, ...rest] = line.split('\t')
    return { status: statusRaw[0], file: rest[rest.length - 1] }
  })
if (!rows.length) process.exit(0)

// 設計の話にならない変更は最初に除く
const NOISE =
  /(^|\/)(package-lock\.json|pnpm-lock\.yaml|yarn\.lock)$|\.(md|txt|snap|lock)$|(^|\/)\.(github|vscode)\//
const meaningful = rows.filter((r) => !NOISE.test(r.file))
if (!meaningful.length) process.exit(0)

// 同じコミットで二度出さない（失敗して再実行するたびに出ると鬱陶しい）
const stamp = path.join(projectDir, '.git', 'speclink-last-check')
const fingerprint = meaningful
  .map((r) => `${r.status}:${r.file}`)
  .sort()
  .join('\n')
try {
  if (fs.existsSync(stamp) && fs.readFileSync(stamp, 'utf8') === fingerprint) {
    process.exit(0)
  }
  fs.writeFileSync(stamp, fingerprint)
} catch {
  // 記録できなくても本題は続ける
}

const repoName = path.basename(projectDir)
const docs = loadDocs(docsDir)
const usecases = docs.filter((d) => d.kind === 'usecase' && d.status === 'active')

// 手がかり 1: ファイルが増えた（＝できることが増えた可能性が高い）
const newFiles = meaningful.filter((r) => r.status === 'A')

// 手がかり 2: 既存のユースケースが指す場所を触った（本文がまだ正しいか確認が要る）
const touched = new Map()
for (const r of meaningful) {
  for (const uc of matchDocs(usecases, { relPath: r.file, repoName })) {
    if (!touched.has(uc.id)) touched.set(uc.id, uc)
  }
}

// 手がかり 3: どのユースケースにも紐づかない変更（文書が抜けている可能性）
// ユースケースが 1 件も無いうちは全件が該当してしまい、毎回発火して読み飛ばされるので使わない。
const unlinked = usecases.length
  ? meaningful.filter((r) => matchDocs(usecases, { relPath: r.file, repoName }).length === 0)
  : []

const log = (fired) =>
  record({
    event: 'commit',
    repo: repoName,
    session: input.session_id,
    fired,
    files: meaningful.length,
    signals: {
      newFiles: newFiles.length,
      touched: [...touched.keys()],
      unlinked: unlinked.length,
    },
    docs: docsSnapshot(docsDir),
  })

// どの手がかりにも掛からなければ黙って通す
if (!newFiles.length && !touched.size && !unlinked.length) {
  log(false)
  process.exit(0)
}
log(true)

const list = (arr, n = 8) =>
  arr
    .slice(0, n)
    .map((x) => `  - ${x}`)
    .join('\n') + (arr.length > n ? `\n  - ほか ${arr.length - n} 件` : '')

const parts = [
  'コミット前の確認（speclink）。**コミットは止めない。** 下記を自分で判断し、',
  '残すものがあるときだけユーザーに 1 回聞くこと。両方「いいえ」なら何も言わずに進める。',
  '',
  '### 1. この変更で、担当者ができることが増えた／変わったか？',
  'はい → 該当するユースケースの本文を更新する（無ければ /doc-new で新規に作る）。',
  'いいえ → 2 へ。**表示項目が増えただけ・体裁を直しただけなら「いいえ」。**',
  'コードを読めば分かることを文書に書かない（二重管理になる）。',
  '',
  '### 2. 作り方に選択肢があり、何かを却下したか？',
  'はい → /doc-new で決定を残す。**却下した案と理由を必ずユーザーに聞く**（推測で書かない）。',
  'いいえ → 何も残さない。これが多数派になるのが正常。',
  '',
  '### 手がかり',
]

if (newFiles.length) {
  parts.push(
    `新しいファイルが増えた（できることが増えた可能性）:`,
    list(newFiles.map((r) => r.file)),
    '',
  )
}
if (touched.size) {
  parts.push(
    `既存のユースケースが指す場所を触った（本文がまだ正しいか確認）:`,
    list([...touched.values()].map((u) => `${u.id} ${u.title}`)),
    '',
  )
}
if (unlinked.length) {
  parts.push(
    `どのユースケースにも紐づかない変更:`,
    list(unlinked.map((r) => r.file)),
    '',
  )
}
parts.push(`文書の場所: ${docsDir}`)

emit('PreToolUse', parts.join('\n'))
