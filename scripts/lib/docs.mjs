// speclink の共通処理。外部依存なしで動かす（プラグインに node_modules を持たせない）。
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
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
 * 命令文が本当に `git commit` を走らせるか。区切った命令ごとに先頭が git で、オプションの次が
 * commit のものだけを数える。命令文全体を正規表現で見ると、ヒアドキュメントや引用符の中の
 * 「git commit」という文字だけで反応し、コミットしない命令まで止めていた（2026-10-15）。
 */
export function isCommitCommand(command) {
  for (const seg of splitCommands(stripHeredoc(command))) {
    const tokens = tokenize(seg).map(unquote)
    let i = 0
    while (i < tokens.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[i])) i++ // 先頭の環境変数の指定
    if (i >= tokens.length || path.basename(tokens[i]) !== 'git') continue
    i++
    while (i < tokens.length && tokens[i].startsWith('-')) {
      i += ['-C', '-c', '--git-dir', '--work-tree'].includes(tokens[i]) ? 2 : 1
    }
    if (tokens[i] === 'commit') return true
  }
  return false
}

/**
 * 命令文が `cd` / `git -C` で、会話の持ち場と関係しない別のリポジトリへ移ってから走るか。
 * resolveRepoDir はその場合に持ち場のリポジトリを返すので、コミットの関所がよそのコミットを
 * 持ち場の差分で判定して止めていた（文書置き場へのコミットが作業コピーの変更を理由に止まった。
 * 2026-10-15）。よそのコミットは関所の対象外として素通しする。
 */
export function commandTargetsForeignRepo(input = {}) {
  const command = input.tool_input?.command ?? ''
  const stripped = stripHeredoc(command)
  if (!/(^|[\s;&|(])cd\s|\s-C\s/.test(stripped)) return false
  const cwd = input.cwd || process.cwd()
  const base = process.env.CLAUDE_PROJECT_DIR || cwd
  const target = commandTargetDir(command, cwd)
  const root = target ? gitRootOf(target) : null
  if (!root) return false
  return !(within(root, base) || within(base, root))
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
  const segments = splitCommands(stripHeredoc(command))
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
 * コミットの命令文が走り終えたときに入る中身を、コミット前の時点で見るための git 呼び出しを返す。
 *
 * `git add a b && git commit -m ...` のように登録とコミットを 1 つの命令文でつなぐと、
 * フックが走る時点ではまだ何も登録されていない。登録済みの差分だけを見ると「中身が空」になり、
 * コミット時の関所が全部そろって何も言わずに素通りする（実測: 作業コピーでの 1 コミットで
 * レビュー・文書の確認・決定との照合の 3 つが 1 回も動かなかった）。
 *
 * そこで命令文のうちコミットより前にある `git add` / `git rm` / `git mv` を、登録状態の写し
 * （一時ファイル）の上で先に実行し、その写しを見る。本物の登録状態には触らない。
 * 使い終えたら cleanup() を呼ぶ。登録が無ければ写しは作らず、普段どおりの git を返す。
 *
 * @returns {{ git: (args: string[]) => string | null, adds: number, cleanup: () => void }}
 */
export function pendingCommitGit(dir, command, cwd = dir) {
  let env = process.env
  let tmp = null
  const adds = addsBeforeCommit(command, cwd)
  if (adds.length) {
    const real = gitPathOf(dir, 'index')
    tmp = path.join(os.tmpdir(), `speclink-index-${process.pid}-${Date.now()}`)
    try {
      if (real && fs.existsSync(real)) fs.copyFileSync(real, tmp)
      env = { ...process.env, GIT_INDEX_FILE: tmp }
      for (const { at, sub, args } of adds) {
        // 別のリポジトリ（dir の外）への操作は、この索引の写しとは無関係なので流し込まない
        if (path.relative(dir, at).startsWith('..')) continue
        const run = (gitArgs) =>
          execFileSync('git', gitArgs, {
            cwd: at,
            env,
            encoding: 'utf8',
            stdio: ['ignore', 'pipe', 'ignore'],
            timeout: 10000,
          })
        try {
          // 写しの中だけで再現する。本物の作業コピーのファイルには触らない
          // （素の `git rm` / `git mv` は作業コピーのファイルも消す・動かすので、そのまま流すと
          //   止めたはずのコミットの前にファイルが消える）
          if (sub === 'rm') {
            run(['rm', '--cached', '-q', ...args.filter((t) => t !== '--cached')])
          } else if (sub === 'mv') {
            const operands = args.filter((t) => !t.startsWith('-'))
            if (operands.length !== 2) continue // 複数ファイルをフォルダへ動かす形は再現しない
            const [from, to] = operands
            const entry = run(['ls-files', '-s', '--', from]).trim().split(/\s+/)
            if (entry.length < 4) continue
            const [mode, blob] = entry
            run(['rm', '--cached', '-q', '--', from])
            run(['update-index', '--add', '--cacheinfo', `${mode},${blob},${to}`])
          } else {
            run(['add', ...args])
          }
        } catch {
          // 登録に失敗する指定（存在しないパスなど）は本番でも失敗するので、写しにも入れない
        }
      }
    } catch {
      env = process.env
    }
  }
  const git = (args) => {
    try {
      return execFileSync('git', args, {
        cwd: dir,
        env,
        encoding: 'utf8',
        maxBuffer: 64 * 1024 * 1024,
        stdio: ['ignore', 'pipe', 'ignore'],
      })
    } catch {
      return null
    }
  }
  const cleanup = () => {
    if (tmp) fs.rmSync(tmp, { force: true })
  }
  return { git, adds: adds.length, cleanup }
}

/**
 * 命令文の中で、コミットより前にある登録の操作（`git add` / `git rm` / `git mv`）を拾う。
 * `git rm old.ts && git commit` は 1 行で消すいちばん自然な形なので、add だけでは消す操作が見えない。
 * 対話で選ぶ登録（-p / -i / -e）と、展開しないと中身が分からない指定（$ や `）は飛ばす。
 * @returns {{ at: string, sub: string, args: string[] }[]} at はその操作が走る場所、sub は add / rm / mv
 */
const REPLAY_SUBCOMMANDS = new Set(['add', 'rm', 'mv'])
export function addsBeforeCommit(command, cwd) {
  const out = []
  let here = cwd
  for (const seg of splitCommands(stripHeredoc(command))) {
    const tokens = tokenize(seg).map(unquote)
    if (!tokens.length) continue
    if (tokens[0] === 'cd') {
      if (tokens[1] && !/[*?{}$`]/.test(tokens[1])) here = path.resolve(here, tokens[1])
      continue
    }
    if (path.basename(tokens[0]) !== 'git') continue
    let i = 1
    let at = here
    while (tokens[i] === '-C' && tokens[i + 1]) {
      at = path.resolve(at, tokens[i + 1])
      i += 2
    }
    if (tokens[i] === 'commit') break
    const sub = tokens[i]
    if (!REPLAY_SUBCOMMANDS.has(sub)) continue
    // リダイレクト（`> /dev/null` `2>&1`）は引数ではない。記号だけのトークンは次の 1 つ（宛先）も飛ばす
    const args = []
    const rest = tokens.slice(i + 1)
    for (let j = 0; j < rest.length; j++) {
      const t = rest[j]
      if (/^\d*[<>]+$/.test(t)) {
        j++
        continue
      }
      if (/^\d*[<>]/.test(t)) continue
      args.push(t)
    }
    if (args.some((t) => /[$`]/.test(t) || /^(-p|-i|-e|--patch|--interactive|--edit)$/.test(t))) continue
    out.push({ at, sub, args })
  }
  return out
}

/**
 * 指し先のファイルが無い文書を拾う。
 * - gone … 親フォルダはあるのにファイルが無い（消えた・改名された疑い。名指しして直させる）
 * - notYet … 親フォルダごと無い（まだ作っていない場所を指す先行設計。正常なので数えるだけ）
 * glob（* ?）を含む指し先と、別のリポジトリを指す文書は判定しない。
 * コミット時の点検（fix-doc-paths）と会話開始の案内（inject-on-session）が同じ判定を使う。
 * @param {object[]} docs loadDocs の結果（status は呼び出し側で絞る）
 * @param {string} projectDir 判定するリポジトリの場所
 * @param {string|null} repoName そのリポジトリ名（pathForRepo に渡す）
 * @param {(p: string) => boolean} [skip] 判定から外す指し先（このコミットで止める分など）
 * @returns {{ gone: { id: string, path: string, file: string }[], notYet: number }}
 */
export function missingDocPaths(docs, projectDir, repoName, skip = () => false) {
  const gone = []
  let notYet = 0
  for (const doc of docs) {
    for (const p of doc.paths) {
      if (/[*?]/.test(p) || skip(p)) continue
      const rel = pathForRepo(p, repoName)
      if (rel === null) continue
      const abs = path.join(projectDir, rel)
      if (fs.existsSync(abs)) continue
      if (fs.existsSync(path.dirname(abs))) gone.push({ id: doc.id, path: p, file: doc.file })
      else notYet++
    }
  }
  return { gone, notYet }
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

/**
 * 命令文を 1 つずつの命令に割る（`&&` `||` `;` `|` と改行）。引用符の中と、行末の `\` で
 * 続けた改行では割らない。改行で割らないと `git add …` の次の行の `git commit` まで
 * add の引数に読まれ、登録が失敗してレビューが素通りしていた（2026-10-15）。
 */
export function splitCommands(command) {
  const out = []
  let cur = ''
  let quote = null
  for (let i = 0; i < command.length; i++) {
    const c = command[i]
    if (quote) {
      cur += c
      if (c === '\\' && quote === '"' && i + 1 < command.length) cur += command[++i]
      else if (c === quote) quote = null
      continue
    }
    if (c === "'" || c === '"') {
      quote = c
      cur += c
      continue
    }
    if (c === '\\' && command[i + 1] === '\n') {
      cur += ' '
      i++
      continue
    }
    const two = command.slice(i, i + 2)
    if (two === '&&' || two === '||') {
      out.push(cur)
      cur = ''
      i++
      continue
    }
    if (c === ';' || c === '|' || c === '\n') {
      out.push(cur)
      cur = ''
      continue
    }
    cur += c
  }
  out.push(cur)
  return out
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
