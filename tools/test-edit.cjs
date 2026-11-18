const { chromium } = require('playwright')
const path = require('path')
const OUT = path.join(process.cwd(), '.tmp', 'timelog-shots')
const URL = process.argv[2] || 'http://127.0.0.1:8765/'

;(async () => {
  const b = await chromium.launch({ channel: 'msedge', headless: true })
  const c = await b.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true })
  const p = await c.newPage()
  const errs = []
  p.on('pageerror', (e) => errs.push(e.message))
  p.on('console', (m) => { if (m.type() === 'error') errs.push(m.text()) })

  await p.goto(URL, { waitUntil: 'networkidle' })
  await p.evaluate(async () => { localStorage.clear(); indexedDB.deleteDatabase('timelog') })
  await p.reload({ waitUntil: 'networkidle' })

  // 一条 focus
  await p.click('[data-start="focus"]')
  await p.waitForTimeout(1200)
  await p.click('#stopBtn')
  await p.waitForTimeout(350)
  await p.click('#stopConfirm')
  await p.waitForTimeout(600)

  // 打开编辑：改类型为游戏 + 改时间
  await p.click('.entry')
  await p.waitForSelector('#editSheet.is-open')
  await p.waitForTimeout(320)
  await p.screenshot({ path: path.join(OUT, '50-edit-type.png') })

  await p.click('#editTypes [data-type="game"]')
  await p.fill('#editStart', '09:00')
  await p.fill('#editEnd', '10:30')
  await p.click('#editSave')
  await p.waitForSelector('#editSheet', { state: 'hidden' })
  await p.waitForTimeout(600)

  const entry = await p.evaluate(() => {
    const e = document.querySelector('.entry')
    return { name: e.querySelector('.entry-name').textContent, sub: e.querySelector('.entry-sub').textContent, dur: e.querySelector('.entry-dur').textContent }
  })
  console.log('改完类型/时间:', JSON.stringify(entry))
  if (!entry.name.includes('游戏')) throw new Error('类型没改成功：' + entry.name)
  if (!entry.dur.includes('1 小时 30 分')) throw new Error('时长没跟着改：' + entry.dur)

  const stats = await p.textContent('#stats')
  console.log('统计:', stats.replace(/\s+/g, ' ').trim())

  // 数据库核对
  const db = await p.evaluate(() => new Promise((res) => {
    const r = indexedDB.open('timelog')
    r.onsuccess = () => {
      const g = r.result.transaction('events', 'readonly').objectStore('events').getAll()
      g.onsuccess = () => res(g.result[0])
    }
  }))
  console.log('落库:', db.type, db.endReason, Math.round((db.endAt - db.startAt) / 60000) + 'min')
  if (db.type !== 'game') throw new Error('类型没落库')

  await p.screenshot({ path: path.join(OUT, '51-after-edit.png') })

  // 底线新增面板
  await p.click('[data-tab="rules"]')
  await p.waitForTimeout(300)
  await p.click('#addRuleBtn')
  await p.waitForSelector('#ruleSheet.is-open')
  await p.waitForTimeout(320)
  await p.click('#ruleTypeChips [data-rule-type="game"]')
  await p.click('#ruleQuick [data-min="60"]')
  await p.fill('#ruleMinutes', '45')
  await p.waitForTimeout(150)
  const preview = await p.textContent('#rulePreview')
  console.log('预览:', preview)
  await p.screenshot({ path: path.join(OUT, '52-rule-sheet.png') })
  await p.click('#ruleSave')
  await p.waitForSelector('#ruleSheet', { state: 'hidden' })
  await p.waitForTimeout(400)
  const n = await p.$$eval('.rule', (els) => els.length)
  console.log('条款数:', n, '预览:', preview)
  if (n !== 4) throw new Error('条款没加上')

  await p.screenshot({ path: path.join(OUT, '53-rules-after.png') })

  // 360 窄屏
  const c2 = await b.newContext({ viewport: { width: 360, height: 760 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true })
  const p2 = await c2.newPage()
  await p2.goto(URL, { waitUntil: 'networkidle' })
  await p2.click('[data-tab="rules"]')
  await p2.click('#addRuleBtn')
  await p2.waitForTimeout(400)
  await p2.screenshot({ path: path.join(OUT, '54-rule-sheet-360.png') })
  await p2.click('#ruleSheet .sheet-mask, #ruleSheet')
  await p2.waitForTimeout(300)

  console.log('errors:', errs)
  if (errs.length) throw new Error('控制台报错')
  console.log('全部通过 ✅')
  await b.close()
})().catch((e) => { console.error('失败:', e.message); process.exit(1) })
