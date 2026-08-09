// speclink 自身の働きを記録する。
//
// 「出しすぎ／出なさすぎ」「聞いたのに何も残らない」は、記録が無いと判断できない。
// 1 行 1 件で追記するだけ（体感できる遅さは出ない）。
// 記録するのはファイル名・文書 ID・件数だけ。コードの中身は書かない。
import fs from 'node:fs'
import path from 'node:path'
import { loadDocs } from './docs.mjs'

const LOG_NAME = 'events.jsonl'

function logFile() {
  const dir = process.env.CLAUDE_PLUGIN_DATA
  if (!dir) return null
  try {
    fs.mkdirSync(dir, { recursive: true })
    return path.join(dir, LOG_NAME)
  } catch {
    return null
  }
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
