// speclink の共通処理。外部依存なしで動かす（プラグインに node_modules を持たせない）。
import fs from 'node:fs'
import path from 'node:path'

export const KINDS = ['requirements', 'usecases', 'decisions']

/**
 * 文書ディレクトリを決める。
 * 1. プラグイン設定 docs_dir（環境変数として渡ってくる）
 * 2. プロジェクト直下の .speclink.json の docsDir
 * どちらも無ければ null（＝speclink は黙って何もしない）。
 */
export function resolveDocsDir(cwd) {
  const fromConfig = process.env.CLAUDE_PLUGIN_OPTION_DOCS_DIR
  if (fromConfig && fs.existsSync(fromConfig)) return fromConfig

  const projectDir = process.env.CLAUDE_PROJECT_DIR || cwd
  const local = path.join(projectDir, '.speclink.json')
  if (fs.existsSync(local)) {
    try {
      const conf = JSON.parse(fs.readFileSync(local, 'utf8'))
      if (conf.docsDir) {
        const resolved = path.resolve(projectDir, conf.docsDir)
        if (fs.existsSync(resolved)) return resolved
      }
    } catch {
      // 壊れた設定は無視する（speclink がプロジェクトを止めてはいけない）
    }
  }
  return null
}

/**
 * 冒頭の情報欄（YAML 風）を読む。speclink が使う範囲だけを解釈する限定版。
 * 対応: 文字列 / 入れ子のマップ 1 段 / ブロック配列 / 角括弧の配列
 */
export function parseFrontmatter(text) {
  if (!text.startsWith('---')) return { data: {}, body: text }
  const end = text.indexOf('\n---', 3)
  if (end === -1) return { data: {}, body: text }
  const raw = text.slice(text.indexOf('\n') + 1, end)
  const body = text.slice(end + 4).replace(/^\n/, '')

  const lines = raw
    .split('\n')
    .filter((l) => l.trim() && !l.trim().startsWith('#'))

  const data = {}
  let rootKey = null // 値を持たないルートキー（配列かマップの入れ物になる）
  let childKey = null // その下のキー（配列の入れ物になる）

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    const indent = line.length - line.trimStart().length
    const trimmed = line.trim()

    // 配列の要素
    if (trimmed.startsWith('- ')) {
      const value = stripQuotes(trimmed.slice(2).trim())
      const target = childKey !== null ? data[rootKey][childKey] : data[rootKey]
      if (Array.isArray(target)) target.push(value)
      continue
    }

    const m = trimmed.match(/^([A-Za-z0-9_-]+):\s*(.*)$/)
    if (!m) continue
    const [, key, rest] = m

    if (indent === 0) {
      rootKey = null
      childKey = null
      if (rest === '') {
        // 次の行が「- 」なら配列、そうでなければマップ
        const next = lines[i + 1]?.trim() ?? ''
        data[key] = next.startsWith('- ') ? [] : {}
        rootKey = key
      } else {
        data[key] = parseScalar(rest)
      }
      continue
    }

    // 入れ子（1 段だけ対応）
    if (rootKey === null || Array.isArray(data[rootKey])) continue
    if (rest === '') {
      data[rootKey][key] = []
      childKey = key
    } else {
      data[rootKey][key] = parseScalar(rest)
      childKey = null
    }
  }

  return { data, body }
}

function parseScalar(v) {
  const s = v.trim()
  if (s.startsWith('[') && s.endsWith(']')) {
    return s
      .slice(1, -1)
      .split(',')
      .map((x) => stripQuotes(x.trim()))
      .filter(Boolean)
  }
  return stripQuotes(s)
}

function stripQuotes(s) {
  if (
    (s.startsWith('"') && s.endsWith('"')) ||
    (s.startsWith("'") && s.endsWith("'"))
  ) {
    return s.slice(1, -1)
  }
  return s
}

/** 文書ディレクトリを走査して全文書を読む */
export function loadDocs(docsDir) {
  const docs = []
  for (const kind of KINDS) {
    const dir = path.join(docsDir, kind)
    if (!fs.existsSync(dir)) continue
    for (const name of fs.readdirSync(dir)) {
      if (!name.endsWith('.md')) continue
      const file = path.join(dir, name)
      const text = fs.readFileSync(file, 'utf8')
      const { data, body } = parseFrontmatter(text)
      docs.push({
        kind: kind.replace(/s$/, ''), // requirement / usecase / decision
        file: path.relative(docsDir, file),
        id: data.id || name.replace(/\.md$/, ''),
        title: data.title || firstHeading(body) || name,
        status: data.status || 'active',
        parent: data.parent || null,
        summary: data.summary || '',
        keywords: toArray(data.keywords),
        paths: toArray(data.scope?.paths),
        fields: toArray(data.scope?.fields),
      })
    }
  }
  return docs
}

function firstHeading(body) {
  const m = body.match(/^#\s+(.+)$/m)
  return m ? m[1].trim() : null
}

function toArray(v) {
  if (!v) return []
  return Array.isArray(v) ? v : [v]
}

/** ごく単純な glob 判定（**, *, ? のみ対応） */
export function globMatch(pattern, target) {
  let re = ''
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i]
    if (c === '*' && pattern[i + 1] === '*') {
      if (pattern[i + 2] === '/') {
        re += '(?:[^/]+/)*' // 途中の ** … 0 段以上のディレクトリ
        i += 2
      } else {
        re += '.*' // 末尾の ** … 配下すべて
        i += 1
      }
    } else if (c === '*') {
      re += '[^/]*'
    } else if (c === '?') {
      re += '[^/]'
    } else {
      re += escapeRe(c)
    }
  }
  return new RegExp('^' + re + '$').test(target)
}

/**
 * 触っているファイル（と、あれば編集内容）に効く文書を引き当てる。
 * 引き当ての鍵は「コードの場所」と「項目名」だけ。本文は検索しない。
 */
export function matchDocs(docs, { relPath, content }) {
  const hits = []
  for (const doc of docs) {
    if (doc.status !== 'active') continue
    let reason = null
    if (relPath && doc.paths.some((p) => globMatch(p, relPath))) {
      reason = 'path'
    } else if (content && doc.fields.length) {
      const hit = doc.fields.find((f) =>
        new RegExp(`\\b${escapeRe(f)}\\b`).test(content),
      )
      if (hit) reason = `field:${hit}`
    }
    if (reason) hits.push({ ...doc, reason })
  }
  return hits
}

function escapeRe(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/** フックの標準入力を読む */
export async function readHookInput() {
  const chunks = []
  for await (const chunk of process.stdin) chunks.push(chunk)
  const raw = Buffer.concat(chunks).toString('utf8').trim()
  if (!raw) return {}
  try {
    return JSON.parse(raw)
  } catch {
    return {}
  }
}

/** 会話に文言を差し込む */
export function emit(hookEventName, additionalContext) {
  if (!additionalContext) process.exit(0)
  process.stdout.write(
    JSON.stringify({
      suppressOutput: true,
      hookSpecificOutput: { hookEventName, additionalContext },
    }),
  )
  process.exit(0)
}

/**
 * 同じ会話の中で一度出した文書は二度出さない（うるさくしないため）。
 * 記録はプラグインの永続ディレクトリに置く。
 */
export function seenFilter(sessionId, ids) {
  const dataDir = process.env.CLAUDE_PLUGIN_DATA
  if (!dataDir || !sessionId) return ids
  try {
    fs.mkdirSync(path.join(dataDir, 'seen'), { recursive: true })
    const file = path.join(dataDir, 'seen', `${sessionId}.json`)
    const seen = fs.existsSync(file)
      ? new Set(JSON.parse(fs.readFileSync(file, 'utf8')))
      : new Set()
    const fresh = ids.filter((id) => !seen.has(id))
    fresh.forEach((id) => seen.add(id))
    fs.writeFileSync(file, JSON.stringify([...seen]))
    return fresh
  } catch {
    return ids
  }
}
