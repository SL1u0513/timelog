/* 冒烟测试：用真实浏览器跑一遍主流程
 * 需要 playwright（npm i -g playwright）+ 本机 Edge
 * 用法：node tools/smoke-test.cjs [url] [outDir]
 */
const path = require('path')
const fs = require('fs')
const { chromium } = require('playwright')

const URL = process.argv[2] || 'http://127.0.0.1:8765/'
const OUT = process.argv[3] || path.join(process.cwd(), '.tmp', 'timelog-shots')
fs.mkdirSync(OUT, { recursive: true })

const log = (...a) => console.log(...a)
const shot = (page, name) => page.screenshot({ path: path.join(OUT, name + '.png') })

;(async () => {
  const browser = await chromium.launch({ channel: 'msedge', headless: true })
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true })
  const page = await ctx.newPage()
  const errors = []
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()) })
  page.on('pageerror', (e) => errors.push('PAGEERROR ' + e.message))

  await page.goto(URL, { waitUntil: 'networkidle' })

  // 清掉可能残留的旧数据，保证从零开始
  await page.evaluate(async () => {
    localStorage.clear()
    indexedDB.deleteDatabase('timelog')
  })
  await page.reload({ waitUntil: 'networkidle' })
  await page.waitForSelector('#hero .start-tile')

  log('1. 空态渲染 OK')
  await shot(page, '01-idle')

  // ---- 开始「自己的时间」
  await page.click('[data-start="focus"]')
  await page.waitForSelector('#timerText')
  await page.waitForTimeout(2200)
  const t1 = await page.textContent('#timerText')
  log('2. 计时开始，读数 =', t1)
  if (!/^00:00:0[1-9]$/.test(t1)) throw new Error('计时读数不对：' + t1)
  await shot(page, '02-running-focus')

  // ---- 结束并选原因
  await page.click('#stopBtn')
  await page.waitForSelector('#stopSheet.is-open')
  await page.waitForTimeout(320)
  await shot(page, '03-stop-sheet')
  await page.click('#reasonChips [data-reason="interrupted"]')
  await page.fill('#stopNote', '被消息打断了一次')
  await page.click('#stopConfirm')
  await page.waitForSelector('#stopSheet', { state: 'hidden' })
  await page.waitForTimeout(400)

  const entries = await page.$$eval('.entry', (els) => els.length)
  log('3. 时间线条目数 =', entries)
  if (entries !== 1) throw new Error('时间线应有 1 条，实际 ' + entries)
  const statText = await page.textContent('#stats')
  log('   今日统计 =', statText.replace(/\s+/g, ' ').trim())

  // ---- 数据是否落库
  const stored = await page.evaluate(() => new Promise((res) => {
    const req = indexedDB.open('timelog')
    req.onsuccess = () => {
      const tx = req.result.transaction('events', 'readonly')
      const g = tx.objectStore('events').getAll()
      g.onsuccess = () => res(g.result)
    }
  }))
  log('4. IndexedDB 事件数 =', stored.length, '状态 =', stored[0].state, '原因 =', stored[0].endReason)
  if (stored.length !== 1 || stored[0].state !== 'closed' || stored[0].endReason !== 'interrupted') {
    throw new Error('落库内容不对：' + JSON.stringify(stored[0]))
  }

  // ---- 游戏时间盒
  await page.click('[data-start="game"]')
  await page.waitForSelector('#boxBar')
  await page.waitForTimeout(1200)
  const boxText = await page.textContent('.box-row')
  log('5. 游戏时间盒 =', boxText.replace(/\s+/g, ' ').trim())
  await shot(page, '04-running-game')

  // ---- 刷新后仍在计时（未闭合事件恢复）
  await page.reload({ waitUntil: 'networkidle' })
  await page.waitForSelector('#timerText')
  const toastText = await page.evaluate(() => document.querySelector('#toast').textContent)
  log('6. 刷新后恢复提示 =', toastText)
  if (!toastText.includes('进行中')) throw new Error('没有恢复进行中的记录')
  await shot(page, '05-restored')

  // ---- 切走：模拟 visibilitychange
  await page.evaluate(() => {
    Object.defineProperty(document, 'visibilityState', { value: 'hidden', configurable: true })
    document.dispatchEvent(new Event('visibilitychange'))
  })
  await page.waitForTimeout(300)
  await page.evaluate(() => {
    Object.defineProperty(document, 'visibilityState', { value: 'visible', configurable: true })
    document.dispatchEvent(new Event('visibilitychange'))
  })
  await page.waitForTimeout(600)
  const leftCount = await page.evaluate(() => window.__timelog.openEvent.leftCount)
  log('7. 切走计数 =', leftCount)
  if (leftCount < 1) throw new Error('切走没有计数')

  // 收尾，进入底线 / 复盘 / 数据
  await page.click('#stopBtn')
  await page.waitForSelector('#stopSheet.is-open')
  await page.click('#stopConfirm')
  await page.waitForTimeout(500)

  await page.click('[data-tab="rules"]')
  await page.waitForTimeout(300)
  const rules = await page.$$eval('.rule', (els) => els.map((e) => e.textContent.replace(/\s+/g, ' ').trim()))
  log('8. 底线条款 =', rules)
  if (rules.length !== 3) throw new Error('默认应有 3 条底线')
  await shot(page, '06-rules')

  // 加一条自定义条款
  await page.click('#addRuleBtn')
  await page.selectOption('#ruleType', 'game')
  await page.fill('#ruleMinutes', '45')
  await page.fill('#ruleLabel', '游戏 45 分钟')
  await page.click('#ruleForm button[type="submit"]')
  await page.waitForTimeout(300)
  const rules2 = await page.$$eval('.rule', (els) => els.length)
  log('9. 新条款后条数 =', rules2)
  if (rules2 !== 4) throw new Error('添加条款失败')
  await shot(page, '07-rules-added')

  await page.click('[data-tab="review"]')
  await page.waitForTimeout(400)
  await page.fill('#reviewA', '写完了记账页的第一版')
  await page.fill('#reviewB', '下午被群消息打断两次')
  await page.fill('#reviewC', '明天把时间记录跑一整天')
  await shot(page, '08-review')
  await page.click('#reviewSave')
  await page.waitForTimeout(500)
  const items = await page.$$eval('.review-item', (els) => els.length)
  log('10. 复盘保存后条目 =', items)
  if (items !== 1) throw new Error('复盘没存上')

  await page.click('[data-tab="data"]')
  await page.waitForTimeout(400)
  await shot(page, '09-data')

  // ---- Service Worker
  const sw = await page.evaluate(async () => {
    const reg = await navigator.serviceWorker.getRegistration()
    return reg ? { scope: reg.scope, active: !!reg.active, state: reg.active && reg.active.state } : null
  })
  log('11. Service Worker =', JSON.stringify(sw))
  if (!sw || !sw.active) throw new Error('Service Worker 没有激活')

  // ---- 离线可用
  await ctx.setOffline(true)
  await page.reload({ waitUntil: 'domcontentloaded' })
  await page.waitForSelector('.tabbar', { timeout: 8000 })
  await page.waitForTimeout(400)
  const offline = await page.evaluate(() => ({
    title: document.title,
    hero: document.querySelector('#hero').textContent.replace(/\s+/g, ' ').trim(),
    stats: document.querySelectorAll('.stat').length,
  }))
  log('12. 离线重载 OK：', JSON.stringify(offline))
  if (offline.stats !== 3) throw new Error('离线时界面没有渲染出来')
  await page.click('[data-tab="record"]')
  await page.waitForTimeout(300)
  await shot(page, '10-offline')
  await ctx.setOffline(false)

  // ---- 游戏时间盒预警 / 超时
  const warnPage = await ctx.newPage()
  await warnPage.goto(URL, { waitUntil: 'networkidle' })
  await warnPage.evaluate(() => {
    window.__timelog.settings.gameTimebox = 0.1   // 6 秒
    window.__timelog.settings.warnBefore = 0.05   // 3 秒
    localStorage.setItem('timelog.tab', 'record')
  })
  await warnPage.reload({ waitUntil: 'networkidle' })
  await warnPage.evaluate(() => {
    window.__timelog.settings.gameTimebox = 0.1
    window.__timelog.settings.warnBefore = 0.05
  })
  await warnPage.click('[data-start="game"]')
  await warnPage.waitForTimeout(4200)
  const warnNear = await warnPage.evaluate(() => {
    const w = document.querySelector('#warnBox')
    return w ? { text: w.textContent.trim(), over: w.classList.contains('is-over') } : null
  })
  log('13. 预警（3 秒后） =', JSON.stringify(warnNear))
  if (!warnNear || warnNear.over) throw new Error('预警没有按时出现')
  await shot(warnPage, '12-game-warn')
  await warnPage.waitForTimeout(3000)
  const warnOver = await warnPage.evaluate(() => {
    const w = document.querySelector('#warnBox')
    const l = document.querySelector('#boxLeft')
    return { over: w && w.classList.contains('is-over'), left: l && l.textContent }
  })
  log('14. 超时后 =', JSON.stringify(warnOver))
  if (!warnOver.over) throw new Error('超时状态没有出现')
  await shot(warnPage, '13-game-over')

  // ---- 桌面宽屏
  const wide = await ctx.newPage()
  await wide.setViewportSize({ width: 900, height: 900 })
  await wide.goto(URL, { waitUntil: 'networkidle' })
  await wide.waitForTimeout(500)
  await shot(wide, '11-desktop')

  if (errors.length) {
    log('控制台错误：', errors)
    throw new Error('页面有 ' + errors.length + ' 个错误')
  }
  log('\n全部通过 ✅  截图目录：', OUT)
  await browser.close()
})().catch(async (e) => {
  console.error('\n失败：', e.message)
  process.exit(1)
})
