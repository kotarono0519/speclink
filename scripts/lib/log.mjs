// speclink 自身の働きを記録する。
//
// 「出しすぎ／出なさすぎ」「聞いたのに何も残らない」は、記録が無いと判断できない。
// 1 行 1 件で追記するだけ（体感できる遅さは出ない）。
// 記録するのはファイル名・文書 ID・件数だけ。コードの中身は書かない。
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { loadDocs, mainCheckoutOf } from './docs.mjs'

const LOG_NAME = 'events.jsonl'

// フック経由なら CLAUDE_PLUGIN_DATA が入る。
// スキルの手動実行（/doc-stats 等）では入らないので、
// フックが書き込んできた既定の置き場所（~/.claude/plugins/data/speclink*）を探す。
function dataDir() {
  if (process.env.CLAUDE_PLUGIN_DATA) return process.env.CLAUDE_PLUGIN_DATA
  const base = path.join(os.homedir(), '.claude', 'plugins', 'data')
  try {
    const candidates = fs
      .readdirSync(base)
      .filter((d) => d.startsWith('speclink'))
      .map((d) => path.join(base, d))
    // 既に記録があるものを優先する
    return (
      candidates.find((d) => fs.existsSync(path.join(d, LOG_NAME))) ??
      candidates[0] ??
      null
    )
  } catch {
    return null
  }
}

function logFile() {
  const dir = dataDir()
  if (!dir) return null
  try {
    fs.mkdirSync(dir, { recursive: true })
    return path.join(dir, LOG_NAME)
  } catch {
    return null
  }
}

/**
 * 記録と照合に使うリポジトリ名。作業コピー（git worktree）なら本体チェックアウトの名前を返す。
 * 作業コピーは切っては捨てるものなので、その名前で数えると 1 つのプロジェクトの記録が
 * レーンの数だけ散らばり、/doc-stats の --repo で拾えなくなる（miroir-fe で関所 1 回が落ちた）。
 * 文書の指し先（scope.paths の「リポジトリ名/」）を作業コピーで照合するときも、この名前が要る。
 * 作業コピーの名前は worktree として別に返す。
 */
export function repoOf(projectDir) {
  const dir = projectDir || ''
  const name = path.basename(dir)
  const main = dir ? mainCheckoutOf(dir) : null
  if (!main) return { repo: name, worktree: null }
  return { repo: path.basename(main), worktree: name }
}

/**
 * 文書側の状態を写し取る。あとで「聞いた後に文書が増えたか」を突き合わせるために使う。
 * 件数と最終更新の時刻だけを持つ（中身は持たない）。
 */
export function docsSnapshot(docsDir) {
  try {
    const docs = loadDocs(docsDir)
    let latest = 0
    for (const d of docs) {
      const st = fs.statSync(path.join(docsDir, d.file))
      if (st.mtimeMs > latest) latest = st.mtimeMs
    }
    return { count: docs.length, latest: Math.round(latest) }
  } catch {
    return null
  }
}

/**
 * 1 件記録する。失敗しても本題を止めない（記録のために作業が止まるのは本末転倒）。
 *
 * @param {object} e
 * @param {string} e.event  what happened: edit / commit / decision / read
 * @param {boolean} e.fired 差し込んだか（黙って通したときも記録する＝出なさすぎの判定に要る）
 */
export function record(e) {
  const file = logFile()
  if (!file) return
  try {
    const line = JSON.stringify({ at: new Date().toISOString(), ...e })
    fs.appendFileSync(file, line + '\n')
  } catch {
    // 記録できなくても続ける
  }
}

export function readLog() {
  const file = logFile()
  if (!file || !fs.existsSync(file)) return []
  try {
    return fs
      .readFileSync(file, 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((l) => {
        try {
          return JSON.parse(l)
        } catch {
          return null
        }
      })
      .filter(Boolean)
  } catch {
    return []
  }
}
