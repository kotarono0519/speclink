// speclink の共通処理。外部依存なしで動かす（プラグインに node_modules を持たせない）。
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'

export const KINDS = ['requirements', 'usecases', 'decisions']

/**
 * 文書ディレクトリを決める。
 * 1. プラグイン設定 docs_dir（環境変数として渡ってくる）
 * 2. プロジェクト直下の .speclink.json の docsDir
 * 3. 作業コピー（git worktree）なら、本体チェックアウト直下の .speclink.json の docsDir
 * どれも無ければ null（＝speclink は黙って何もしない）。
 *
 * 3 があるのは、作業コピーはブランチごとに切っては捨てるもので、そのたびに設定を
 * 置く運用は必ず忘れられるから（忘れても何も言わずに止まるので気づけない）。
 * 本体に 1 つ置けば、そこから切った作業コピー全部に効く。
 */
export function resolveDocsDir(cwd) {
  const fromConfig = process.env.CLAUDE_PLUGIN_OPTION_DOCS_DIR
  if (fromConfig && fs.existsSync(fromConfig)) return fromConfig

  const projectDir = process.env.CLAUDE_PROJECT_DIR || cwd
  const local = readLocalConfig(projectDir)
  if (local) return local

  const mainDir = mainCheckoutOf(projectDir)
  if (mainDir) return readLocalConfig(mainDir)
  return null
}

/** <dir>/.speclink.json の docsDir を <dir> 基準で解決する。無ければ null。 */
function readLocalConfig(dir) {
  const local = path.join(dir, '.speclink.json')
  if (!fs.existsSync(local)) return null
  try {
    const conf = JSON.parse(fs.readFileSync(local, 'utf8'))
    if (conf.docsDir) {
      const resolved = path.resolve(dir, conf.docsDir)
      if (fs.existsSync(resolved)) return resolved
    }
  } catch {
    // 壊れた設定は無視する（speclink がプロジェクトを止めてはいけない）
  }
  return null
}

/**
 * dir が git worktree なら本体チェックアウトのパスを返す。それ以外は null。
 * worktree の .git はディレクトリではなくファイルで、中身が
 * "gitdir: <本体>/.git/worktrees/<名前>" になっている。git コマンドは呼ばない
 * （フックは毎回走るので、プロセス起動のコストを避ける）。
 */
export function mainCheckoutOf(dir) {
  const dotGit = path.join(dir, '.git')
  let stat
  try {
    stat = fs.statSync(dotGit)
  } catch {
    return null
  }
  if (!stat.isFile()) return null
  let gitdir
  try {
    const m = fs.readFileSync(dotGit, 'utf8').match(/^gitdir:\s*(.+)$/m)
    if (!m) return null
    gitdir = path.resolve(dir, m[1].trim())
  } catch {
    return null
  }
  // .../<本体>/.git/worktrees/<名前> の形だけを作業コピーとみなす（submodule の .git/modules は対象外）
  const parts = gitdir.split(path.sep)
  const i = parts.lastIndexOf('worktrees')
  if (i < 2 || parts[i - 1] !== '.git') return null
  const mainDir = parts.slice(0, i - 1).join(path.sep) || path.sep
  return fs.existsSync(mainDir) ? mainDir : null
}

/**
 * dir から上へ辿って、リポジトリの根（.git があるところ）を返す。無ければ null。
 * 作業コピー（git worktree）の .git はファイルだが、あることに変わりはないので同じ扱い。
 */
export function gitRootOf(dir) {
  let cur = dir ? path.resolve(dir) : ''
  while (cur) {
    if (fs.existsSync(path.join(cur, '.git'))) return cur
    const up = path.dirname(cur)
    if (up === cur) return null
    cur = up
  }
  return null
}

/**
 * いま触っているリポジトリの根を決める。
 *
 * 会話の起点（CLAUDE_PROJECT_DIR）を当てにしない。複数のリポジトリを収めた親フォルダから
 * 起動されると、そこには .git が無いので変更一覧が空で返り、フックが何も言わずに素通りする
 * （実測: 親フォルダ起動の 30 コミットで、コミット前の関所が 1 回も動かなかった）。
 * 文書側の指し先も「リポジトリ名/パス」で書かれているので、名前を取り違えると照合も全部外れる。
 *
 * 手がかりの優先順: 命令文の行き先（git -C / cd）→ 編集先のファイル → いまいる場所 → 起点。
 * どれも .git に辿り着かなければ、従来どおり起点を返す。
 */
export function resolveRepoDir(input = {}) {
  const cwd = input.cwd || process.cwd()
  const base = process.env.CLAUDE_PROJECT_DIR || cwd
  const ti = input.tool_input ?? {}
  const candidates = []
  if (ti.command) {
    const target = commandTargetDir(ti.command, cwd)
    if (target) candidates.push(target)
  }
  if (ti.file_path) candidates.push(path.dirname(path.resolve(cwd, ti.file_path)))
  candidates.push(cwd, base)
  for (const c of candidates) {
    const root = c ? gitRootOf(c) : null
    // 会話の持ち場（起点）と関係しないリポジトリは対象にしない。
    // 命令文の行き先をそのまま信じると、よそのリポジトリのコミットを掴んで止め、
    // 相手の .git に記録まで書いてしまう（別のプロジェクトを巻き込む）。
    if (root && (within(root, base) || within(base, root))) return root
  }
  return gitRootOf(base) ?? base
}

/** a が b の中（または b そのもの）か */
function within(a, b) {
  if (!a || !b) return false
  const rel = path.relative(b, a)
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel))
}

/**
 * 命令文が「どこで」走るかを読む。`git -C <場所>` が最優先で、無ければ `cd` で
 * 移動した先（最後に落ち着いた場所）。移動が無ければ null（＝いまいる場所のまま）。
 */
export function commandTargetDir(command, cwd) {
  const segments = stripHeredoc(command).split(/\|\||&&|;|\|/)
  let here = cwd
  let moved = false
  let lastC = null // 最後に見た `git -C`
  let commitC = null // コミットする区切りの `git -C`（これが最優先）
  for (const seg of segments) {
    const tokens = tokenize(seg)
    if (!tokens.length) continue
    if (tokens[0] === 'cd') {
      const to = tokens[1] ? unquote(tokens[1]) : null
      if (to && !/[*?{}$`]/.test(to)) {
        here = path.resolve(here, to)
        moved = true
      }
      continue
    }
    const i = tokens.indexOf('-C')
    if (path.basename(unquote(tokens[0])) === 'git' && i > 0 && tokens[i + 1]) {
      const to = unquote(tokens[i + 1])
      if (!/[*?{}$`]/.test(to)) {
        const abs = path.resolve(here, to)
        lastC = abs
        // `git -C 別の場所 log | …; cd こっち && git commit` のように、下調べで別の場所を
        // 指しているだけのことがある。コミットする区切りのものだけを別格に扱う。
        if (commitC === null && tokens.includes('commit')) commitC = abs
      }
    }
  }
  if (commitC) return commitC
  if (moved) return here
  if (lastC) return lastC

  // 移動も -C も無いなら、命令文に出てくる実在のパスから場所を推す。
  // 自動モードでは `sed -i <絶対パス>` や `cat > <絶対パス>` のように、その場から
  // 動かずに他のリポジトリのファイルを書くことが多い（ここを見ないと親フォルダのままになる）。
  for (const seg of segments) {
    for (const token of tokenize(seg)) {
      const u = unquote(token)
      if (!u.includes('/') || /[*?{}$`<>]/.test(u) || u.startsWith('-')) continue
      const abs = path.resolve(here, u)
      let stat
      try {
        stat = fs.statSync(abs)
      } catch {
        continue
      }
      return stat.isDirectory() ? abs : path.dirname(abs)
    }
  }
  return null
}

/**
 * git の管理領域の中のファイルの置き場所。作業コピー（git worktree）では .git が
 * ファイルなので、自前で組み立てず git に聞く。取れなければ null。
 */
export function gitPathOf(dir, name) {
  try {
    const out = execFileSync('git', ['rev-parse', '--git-path', name], {
      cwd: dir,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim()
    return out ? path.resolve(dir, out) : null
  } catch {
    return null
  }
}

/** ヒアドキュメントの本文は命令ではないので落とす（コミットメッセージを読み違えない） */
export function stripHeredoc(command) {
  return command.replace(/<<-?\s*['"]?(\w+)['"]?[\s\S]*?\n\1\s*$/gm, '')
}

/** 空白で割る。引用符の中は 1 つの語として扱う（引用符は残す） */
export function tokenize(seg) {
  const out = []
  const re = /'(?:[^'\\]|\\.)*'|"(?:[^"\\]|\\.)*"|\S+/g
  let m
  while ((m = re.exec(seg))) out.push(m[0])
  return out
}

export function unquote(t) {
  return t.replace(/^(['"])(.*)\1$/s, '$2')
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
 * 1 つの文書置き場を複数のリポジトリで共有できるようにする。
 *
 * 文書の指し先は「myapp-web/src/...」のようにリポジトリ名から書いてよい
 * （決定は画面・API・インフラにまたがるので、リポジトリ名が無いと区別できない）。
 * 照合するときは、いま作業しているリポジトリの名前を先頭から外す。
 * 別のリポジトリを指している文書は、ここで対象外になる。
 *
 * @returns 照合に使う相対パス。別リポジトリを指していれば null
 */
export function pathForRepo(docPath, repoName) {
  if (!repoName) return docPath
  const prefix = repoName + '/'
  if (docPath.startsWith(prefix)) return docPath.slice(prefix.length)
  // リポジトリ名で始まらないものは、どのリポジトリでも共通の書き方とみなす。
  // ただし別のリポジトリ名で始まっていれば対象外。
  const head = docPath.split('/')[0]
  if (KNOWN_REPO_PREFIX.test(head) && head !== repoName) return null
  return docPath
}

// 「リポジトリ名らしい先頭要素」の判定。拡張子を持たず、ソースの入り口として
// よく使う名前でもないもの（src / app / lib など）をリポジトリ名とみなす。
const KNOWN_REPO_PREFIX =
  /^(?!src$|app$|lib$|components$|features$|packages$|apps$|tests?$|docs$)[a-z0-9][a-z0-9._-]*$/i

/**
 * 触っているファイル（と、あれば編集内容）に効く文書を引き当てる。
 * 引き当ての鍵は「コードの場所」と「項目名」だけ。本文は検索しない。
 *
 * repoName を渡すと、指し先の先頭に付いたリポジトリ名を外して照合する。
 */
export function matchDocs(docs, { relPath, content, repoName }) {
  const hits = []
  for (const doc of docs) {
    if (doc.status !== 'active') continue
    let reason = null
    const paths = doc.paths
      .map((p) => pathForRepo(p, repoName))
      .filter((p) => p !== null)
    if (relPath && paths.some((p) => globMatch(p, relPath))) {
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
