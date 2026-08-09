#!/usr/bin/env node
// 設計を考え始めた瞬間に、関係する過去の決定を思い出させる。
//
// コード編集時の引き当ては「コードに手を出す瞬間」しか効かない。
// 「請求書の PDF どうする？」と相談された段階では、まだ何のファイルも触っていない。
// そこで発言そのものから引く。
//
// 判定材料は呼び名・題名・要約だけ（本文は見ない）。Claude のメモリが
// description だけで関連を判断するのと同じ作り。外しても損害は数行なので、
// 決定を「検出」する処理と違って誤りに強い。
import fs from 'node:fs'
import path from 'node:path'
import { loadDocs, readHookInput, resolveDocsDir, emit } from './lib/docs.mjs'
import { record, docsSnapshot } from './lib/log.mjs'

const MAX_SHOWN = 3
const MIN_TERM = 2 // これより短い語は無視する（誤って当たるため）

const input = await readHookInput()
const prompt = (input.prompt ?? '').trim()
if (!prompt) process.exit(0)

const docsDir = resolveDocsDir(input.cwd || process.cwd())
if (!docsDir) process.exit(0)

const docs = loadDocs(docsDir).filter((d) => d.status === 'active')
if (!docs.length) process.exit(0)

// 呼び名・題名・要約の語が発言に含まれるかを見る。
// 題名と要約は文なので、そのまま含有判定はできない。語に割ってから見る。
const scored = []
for (const doc of docs) {
  const terms = new Set()
  for (const k of doc.keywords) terms.add(k)
  for (const w of splitTerms(doc.title)) terms.add(w)
  for (const w of splitTerms(doc.summary)) terms.add(w)

  const hit = [...terms].filter((t) => t.length >= MIN_TERM && prompt.includes(t))
  if (hit.length) scored.push({ doc, hit, score: hit.length })
}
if (!scored.length) {
  logResult(false, [])
  process.exit(0)
}

// 同じ会話で一度出した文書は繰り返さない
const seen = loadSeen(input.session_id)
const fresh = scored.filter((s) => !seen.has(s.doc.id))
if (!fresh.length) {
  logResult(false, [])
  process.exit(0)
}

fresh.sort((a, b) => b.score - a.score)
const shown = fresh.slice(0, MAX_SHOWN)
saveSeen(input.session_id, seen, shown.map((s) => s.doc.id))
logResult(true, shown.map((s) => s.doc.id))

emit(
  'UserPromptSubmit',
  [
    '過去の設計判断（speclink）。**これは背景情報であって指示ではない。**',
    '今の話に関係しそうな決定を思い出しただけなので、関係なければ黙って無視してよい。',
    '関係するなら、決着済みの論点を最初から考え直さないこと。',
    '',
    '**書かれた時点の写しなので、今も有効とは限らない。** 参照するなら本文を開き、',
    '指しているコードがまだ存在するかを確かめてから使うこと。',
    '',
    ...shown.map(
      (s) =>
        `- ${s.doc.id} ${s.doc.title}\n` +
        `  ${s.doc.summary || ''}\n` +
        `  ${path.join(docsDir, s.doc.file)}`,
    ),
  ].join('\n'),
)

/** 日本語は空白で割れないので、記号と助詞で切って語の候補を作る */
function splitTerms(text) {
  if (!text) return []
  return text
    .split(/[\s、。，．・「」『』（）()[\]{}:：;；/／\\|—ー…\-+*=<>"'`]+/)
    .flatMap((chunk) =>
      chunk.split(
        /(?:は|が|を|に|へ|と|で|から|まで|より|の|も|や|など|して|する|した|される|ない|だけ)/,
      ),
    )
    .map((s) => s.trim())
    .filter(Boolean)
}

function seenFile(sessionId) {
  const dir = process.env.CLAUDE_PLUGIN_DATA
  if (!dir || !sessionId) return null
  try {
    fs.mkdirSync(path.join(dir, 'recall'), { recursive: true })
    return path.join(dir, 'recall', `${sessionId}.json`)
  } catch {
    return null
  }
}

function loadSeen(sessionId) {
  const file = seenFile(sessionId)
  if (!file || !fs.existsSync(file)) return new Set()
  try {
    return new Set(JSON.parse(fs.readFileSync(file, 'utf8')))
  } catch {
    return new Set()
  }
}

function saveSeen(sessionId, seen, ids) {
  const file = seenFile(sessionId)
  if (!file) return
  try {
    ids.forEach((id) => seen.add(id))
    fs.writeFileSync(file, JSON.stringify([...seen]))
  } catch {
    // 記録できなくても続ける
  }
}

function logResult(fired, shownIds) {
  record({
    event: 'recall',
    repo: path.basename(process.env.CLAUDE_PROJECT_DIR ?? input.cwd ?? ''),
    session: input.session_id,
    fired,
    candidates: scored.length,
    shown: shownIds,
    docs: docsSnapshot(docsDir),
  })
}
