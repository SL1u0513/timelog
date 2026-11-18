/* 通过 GitHub API 推送仓库内容（git push 被墙/被 reset 时的兜底）
 *
 * 用法：node tools/push-via-api.cjs <owner/repo> [branch] [message]
 * 依赖：已登录的 gh CLI（用 gh auth token 取 token），Node 18+
 *
 * 做法：blob → tree → commit → 更新 ref，一条 commit 搞定，不走 git 协议。
 */
const { execFileSync } = require('child_process')
const fs = require('fs')
const path = require('path')

const REPO = process.argv[2] || 'SL1u0513/timelog'
const BRANCH = process.argv[3] || 'main'
const MESSAGE = process.argv[4] || 'deploy: 更新站点内容'
const ROOT = path.resolve(__dirname, '..')

const GH = 'C:/Program Files/GitHub CLI/gh.exe'
const TOKEN = execFileSync(GH, ['auth', 'token'], { encoding: 'utf8' }).trim()

const API = 'https://api.github.com'

async function api(method, url, body) {
  const res = await fetch(API + url, {
    method,
    headers: {
      Authorization: 'token ' + TOKEN,
      Accept: 'application/vnd.github+json',
      'User-Agent': 'timelog-deploy',
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  })
  const text = await res.text()
  let json = null
  try { json = text ? JSON.parse(text) : null } catch { /* 非 JSON */ }
  if (!res.ok) {
    const msg = json && json.message ? json.message : text.slice(0, 300)
    const err = new Error(`${method} ${url} -> ${res.status} ${msg}`)
    err.status = res.status
    throw err
  }
  return json
}

function walk(dir, base = '') {
  const out = []
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const rel = base ? base + '/' + entry.name : entry.name
    if (entry.name === '.git' || entry.name === '.tmp' || entry.name === 'node_modules') continue
    if (entry.isDirectory()) out.push(...walk(path.join(dir, entry.name), rel))
    else out.push({ rel, abs: path.join(dir, entry.name) })
  }
  return out
}

;(async () => {
  console.log('repo:', REPO, 'branch:', BRANCH)
  const me = await api('GET', '/user')
  console.log('login:', me.login)

  const files = walk(ROOT)
  console.log('files:', files.length)

  const tree = []
  for (const f of files) {
    const buf = fs.readFileSync(f.abs)
    const blob = await api('POST', `/repos/${REPO}/git/blobs`, {
      content: buf.toString('base64'),
      encoding: 'base64',
    })
    tree.push({ path: f.rel, mode: '100644', type: 'blob', sha: blob.sha })
    process.stdout.write('.')
  }
  console.log('')

  const treeRes = await api('POST', `/repos/${REPO}/git/trees`, { tree })

  let parents = []
  try {
    const head = await api('GET', `/repos/${REPO}/git/ref/heads/${BRANCH}`)
    parents = [head.object.sha]
  } catch (e) {
    if (e.status !== 404 && e.status !== 409) throw e
  }

  const commit = await api('POST', `/repos/${REPO}/git/commits`, {
    message: MESSAGE,
    tree: treeRes.sha,
    parents,
  })
  console.log('commit:', commit.sha)

  if (parents.length) {
    await api('PATCH', `/repos/${REPO}/git/refs/heads/${BRANCH}`, { sha: commit.sha, force: true })
  } else {
    await api('POST', `/repos/${REPO}/git/refs`, { ref: `refs/heads/${BRANCH}`, sha: commit.sha })
  }
  console.log('ref updated: refs/heads/' + BRANCH)
})().catch((e) => {
  console.error('FAILED:', e.message)
  process.exit(1)
})
