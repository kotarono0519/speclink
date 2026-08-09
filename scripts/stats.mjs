#!/usr/bin/env node
// speclink 自身の働きを要約する。「出しすぎ／出なさすぎ」「聞いたのに残らない」を数字で見る。
// 使い方: node stats.mjs [日数] [--repo <名前>]
import { loadDocs, resolveDocsDir } from './lib/docs.mjs'
import { readLog } from './lib/log.mjs'

const args = process.argv.slice(2)
const days = Number(args.find((a) => /^\d+$/.test(a)) ?? 30)
const repoArg = args.includes('--repo') ? args[args.indexOf('--repo') + 1] : null

const since = Date.now() - days * 24 * 60 * 60 * 1000
let events = readLog().filter((e) => new Date(e.at).getTime() >= since)
if (repoArg) events = events.filter((e) => e.repo === repoArg)

if (!events.length) {
  console.log(`直近 ${days} 日の記録はありません。`)
  process.exit(0)
}

const pct = (a, b) => (b ? Math.round((a / b) * 100) : 0)
const by = (name) => events.filter((e) => e.event === name)
const line = (s = '') => console.log(s)

line(`speclink の働き（直近 ${days} 日${repoArg ? ` / ${repoArg}` : ''}）`)
line()

// --- コード編集の直前 ---
const edits = by('edit')
if (edits.length) {
  const fired = edits.filter((e) => e.fired)
  line(`## コード編集の直前`)
  line(`${edits.length} 回中 ${fired.length} 回で差し込み（${pct(fired.length, edits.length)}%）`)

  const counts = new Map()
  for (const e of fired) for (const id of e.shown ?? []) counts.set(id, (counts.get(id) ?? 0) + 1)
  const top = [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5)
  if (top.length) {
    line(`よく出る文書: ${top.map(([id, n]) => `${id}（${n} 回）`).join(' ')}`)
  }
  // 1 回の差し込みで何件出たか。3 件以上が続くなら範囲指定が粗い。
  const shownCounts = fired.map((e) => (e.shown ?? []).length)
  if (shownCounts.length) {
    const avg = (shownCounts.reduce((a, b) => a + b, 0) / shownCounts.length).toFixed(1)
    const many = shownCounts.filter((n) => n >= 3).length
    line(`1 回あたり平均 ${avg} 件（3 件以上が ${many} 回）`)
    if (Number(avg) >= 3) line(`→ 多い。範囲指定が粗い可能性がある`)
    if (pct(fired.length, edits.length) < 5) line(`→ 少ない。範囲指定が狭すぎる可能性がある`)
  }
  line()
}

// --- コミットの関所 ---
const commits = by('commit')
if (commits.length) {
  const fired = commits.filter((e) => e.fired)
  line(`## コミットの関所`)
  line(`${commits.length} 回中 ${fired.length} 回で確認を促した（${pct(fired.length, commits.length)}%）`)

  // 促した後に文書が増えた／更新されたか（＝空振り率）
  let hit = 0
  for (const e of fired) {
    const after = events.find(
      (x) =>
        new Date(x.at).getTime() > new Date(e.at).getTime() &&
        x.docs &&
        e.docs &&
        (x.docs.count !== e.docs.count || x.docs.latest !== e.docs.latest),
    )
    if (after) hit++
  }
  line(`そのうち文書が増えた／更新された: ${hit} 回（空振り ${pct(fired.length - hit, fired.length)}%）`)
  if (fired.length >= 5 && pct(fired.length - hit, fired.length) >= 80) {
    line(`→ 聞きすぎ。手がかりを絞るか、確認の条件を厳しくする`)
  }
  line()
}

// --- 決定が確定した合図 ---
const decisions = by('decision')
if (decisions.length) {
  line(`## 決定が確定した合図`)
  line(`${decisions.length} 回`)
  line()
}

// --- 指し先の点検 ---
const paths = by('paths')
if (paths.length) {
  const renamed = paths.reduce((a, e) => a + (e.renamed ?? 0), 0)
  const broken = paths.at(-1)?.broken ?? 0
  line(`## 指し先の点検`)
  line(`リネームに追従して直した: ${renamed} 件`)
  if (broken) line(`指し先が見つからない: ${broken} 件 ← 直すか status を変える`)
  line()
}

// --- 一度も出ていない文書 ---
const docsDir = resolveDocsDir(process.cwd())
if (docsDir) {
  const all = loadDocs(docsDir).filter((d) => d.kind === 'decision' && d.status === 'active')
  const seen = new Set(edits.flatMap((e) => e.shown ?? []))
  const never = all.filter((d) => !seen.has(d.id))
  line(`## 一度も出ていない決定`)
  line(`${never.length} / ${all.length} 件`)
  if (never.length) {
    line(`${never.slice(0, 10).map((d) => d.id).join(' ')}${never.length > 10 ? ' ほか' : ''}`)
    line(`→ 単にその範囲を触っていないだけかもしれない。触ったのに出ないなら範囲指定が狭い`)
  }
}
