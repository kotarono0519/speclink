#!/usr/bin/env node
// speclink のフックを ~/.claude/settings.json へ登録する。
// プラグインとして入れたときは Claude Code が hooks/hooks.json をそのまま読むので何もしない。
// ~/.claude/skills/ に置いて使うとき（開発しながら使うとき）だけ、絶対パスに直して登録する。
// 何度走らせても同じ結果になる（自分が入れた分を入れ替えるだけで、他のフックは触らない）。
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const pluginRoot = path.resolve(here, '..')

/** そのコマンドが speclink のスクリプトを呼んでいるか。 */
function isOurs(command) {
  return (
    typeof command === 'string' &&
    /speclink[\\/](scripts|hooks)[\\/]/.test(command)
  )
}

/**
 * フックを登録する。
 * @returns {{status: 'installed'|'unchanged'|'skipped', settingsPath: string, backup?: string, reason?: string}}
 */
export function installHooks() {
  const configDir =
    process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude')
  const settingsPath = path.join(configDir, 'settings.json')

  // プラグイン置き場に入っているなら、フックは Claude Code が読む。二重登録すると 2 回走る。
  if (pluginRoot.split(path.sep).includes('plugins')) {
    return {
      status: 'skipped',
      settingsPath,
      reason: 'プラグインとして入っているので Claude Code がフックを読む',
    }
  }

  const source = path.join(pluginRoot, 'hooks', 'hooks.json')
  if (!fs.existsSync(source)) {
    return { status: 'skipped', settingsPath, reason: 'hooks.json が無い' }
  }
  const ours = JSON.parse(
    fs.readFileSync(source, 'utf8').replaceAll('${CLAUDE_PLUGIN_ROOT}', pluginRoot),
  ).hooks

  let settings = {}
  if (fs.existsSync(settingsPath)) {
    // 壊れた設定を上書きしない（読めないときは何もせず知らせる）
    settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'))
  }
  const before = JSON.stringify(settings)

  const hooks = { ...(settings.hooks || {}) }

  // 前に自分が入れた分を外す（置き場所が変わっていても、古い指し先が残らない）
  for (const [event, groups] of Object.entries(hooks)) {
    const kept = groups
      .map((group) => ({
        ...group,
        hooks: (group.hooks || []).filter((h) => !isOurs(h.command)),
      }))
      .filter((group) => group.hooks.length)
    if (kept.length) hooks[event] = kept
    else delete hooks[event]
  }

  // 入れ直す
  for (const [event, groups] of Object.entries(ours)) {
    hooks[event] = [...(hooks[event] || []), ...groups]
  }

  settings.hooks = hooks
  const after = JSON.stringify(settings)
  if (after === before) {
    return { status: 'unchanged', settingsPath }
  }

  let backup
  if (fs.existsSync(settingsPath)) {
    const stamp = new Date()
      .toISOString()
      .replace(/[-:T]/g, '')
      .slice(0, 14)
    backup = `${settingsPath}.bak-${stamp}`
    fs.copyFileSync(settingsPath, backup)
  } else {
    fs.mkdirSync(configDir, { recursive: true })
  }
  fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + '\n')

  return { status: 'installed', settingsPath, backup }
}

/** 結果を人が読む形で出す。 */
export function reportHooks(result) {
  if (result.status === 'skipped') {
    console.log(`フックの登録は不要: ${result.reason}`)
    return
  }
  if (result.status === 'unchanged') {
    console.log(`フックは登録済み: ${result.settingsPath}`)
    return
  }
  console.log(`フックを登録しました: ${result.settingsPath}`)
  if (result.backup) console.log(`  書き換え前の控え: ${result.backup}`)
  console.log(
    '  会話の開始時・相談された瞬間・コードを編集する直前・コミットする直前に speclink が働きます。',
  )
  console.log('  次に始める会話から有効になります。')
}

const runDirectly =
  process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
if (runDirectly) {
  try {
    reportHooks(installHooks())
  } catch (error) {
    console.error(`フックの登録に失敗しました: ${error.message}`)
    process.exit(1)
  }
}
