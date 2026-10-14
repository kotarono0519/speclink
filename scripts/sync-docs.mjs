#!/usr/bin/env node
// 文書置き場が独立したリポジトリ（送り先あり）のときだけ、取り込み・送り出しをする。
// 複数のPCで同じ文書置き場を使うと、取り込まずに読めばもう一方の決定が見えず、
// 取り込まずに書けば push が断られる。取り込むのは「会話の開始時」と「記録を書く直前」の 2 か所だけ。
//
//   node sync-docs.mjs pull [<文書置き場>]   早送りだけで取り込む（手元の未送信の変更は壊さない）
//   node sync-docs.mjs push [<文書置き場>]   送り出す。断られたら取り込み直して 1 回だけやり直す
//
// 文書置き場がコードのリポジトリの中にある・git でない・送り先が無いときは何もしない（終了コード 0）。
import fs from 'node:fs'
import { spawnSync } from 'node:child_process'
import { pathToFileURL } from 'node:url'
import { resolveDocsDir } from './lib/docs.mjs'

function git(dir, args, timeout) {
  // 認証の入力待ちで止まらないようにする（会話の開始時のフックが 5 秒固まるのを防ぐ）
  const env = { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_SSH_COMMAND: process.env.GIT_SSH_COMMAND || 'ssh -o BatchMode=yes' }
  const r = spawnSync('git', ['-C', dir, ...args], { encoding: 'utf8', timeout, env })
  return { ok: r.status === 0 && !r.error, out: `${r.stdout || ''}${r.stderr || ''}`.trim() }
}

// 文書置き場そのものがリポジトリのトップで、送り先（upstream）を持っているか
export function isStandaloneRemoteRepo(docsDir) {
  if (!docsDir || !fs.existsSync(docsDir)) return false
  const top = git(docsDir, ['rev-parse', '--show-toplevel'], 3000)
  if (!top.ok || fs.realpathSync(top.out) !== fs.realpathSync(docsDir)) return false
  return git(docsDir, ['rev-parse', '--abbrev-ref', '@{u}'], 3000).ok
}

// 失敗しても投げない。{ done, ok, message } を返す（done=false は対象外）
export function pullDocs(docsDir, timeout = 5000) {
  if (!isStandaloneRemoteRepo(docsDir)) return { done: false, ok: true, message: '' }
  const r = git(docsDir, ['pull', '--ff-only', '--quiet'], timeout)
  return { done: true, ok: r.ok, message: r.ok ? '' : r.out || '時間切れ' }
}

// 未コミットの変更（書いた会話がコミット前に終わった書き残し）のパス一覧。対象外・失敗なら空
export function pendingDocsChanges(docsDir) {
  if (!isStandaloneRemoteRepo(docsDir)) return []
  const r = git(docsDir, ['status', '--porcelain'], 3000)
  if (!r.ok || !r.out) return []
  return r.out.split('\n').map((l) => l.trim().replace(/^\S+\s+/, '')).filter(Boolean)
}

export function pushDocs(docsDir, timeout = 20000) {
  if (!isStandaloneRemoteRepo(docsDir)) return { done: false, ok: true, message: '' }
  let r = git(docsDir, ['push', '--quiet'], timeout)
  if (r.ok) return { done: true, ok: true, message: '' }
  const rebased = git(docsDir, ['pull', '--rebase', '--quiet'], timeout)
  if (!rebased.ok) return { done: true, ok: false, message: `取り込み直しに失敗: ${rebased.out}` }
  r = git(docsDir, ['push', '--quiet'], timeout)
  return { done: true, ok: r.ok, message: r.ok ? '' : r.out || '時間切れ' }
}

const invokedDirectly =
  process.argv[1] && import.meta.url === pathToFileURL(fs.realpathSync(process.argv[1])).href
if (invokedDirectly) {
  const [mode, dirArg] = process.argv.slice(2)
  const docsDir = dirArg || resolveDocsDir(process.cwd())
  const fn = mode === 'pull' ? pullDocs : mode === 'push' ? pushDocs : null
  if (!fn) {
    console.error('使い方: sync-docs.mjs pull|push [<文書置き場>]')
    process.exit(2)
  }
  const r = fn(docsDir)
  if (!r.done) console.log('対象外（文書置き場が独立したリポジトリでない、または送り先が無い）')
  else console.log(r.ok ? `${mode}: 済み` : `${mode}: 失敗 — ${r.message}`)
  process.exit(r.ok ? 0 : 1)
}
