# 时光账本 · 阶段一（PWA）

一个只给自己用的时间记录器：**自己的时间 / 游戏 / 睡眠**，手动启停，数据留在本地。

原生 HTML + CSS + JS，**零依赖、零构建**，把文件夹丢到任意静态托管就能跑；手机浏览器打开 → 添加到主屏幕 → 全屏、断网可用。

**已上线：<https://sl1u0513.github.io/timelog/>** —— 手机用 Edge 打开，菜单 →「添加到手机」，桌面就有独立图标。

---

## 现在能做什么（P0 + P1）

| 能力 | 说明 |
| --- | --- |
| 一键开始 / 结束 | 三个入口：自己的时间、游戏、睡眠；结束时选原因（自然结束 / 被打断 / 切走了 / 手动收尾）并补一句备注 |
| 今日概览 | 三类各自累计时长 + 段数，越线即时变色 |
| 近 7 天柱状图 | 三类堆叠，点按（长按）看当天明细 |
| 时间线 | 今天每一段记录的起止、时长、结束原因、备注；点开可改**类型**、**起止时间**、结束原因、备注，或删除（改完立刻重算当天汇总） |
| 底线清单 | 自定义条款：某类不超过 / 不少于 N 分钟（底部面板选类型、比较、快捷时长），实时判定达标 / 越线 / 没做到，可停用、删除 |
| 游戏时间盒 | 默认 60 分钟，提前 10 分钟页面内预警 + 手机震动，超时标红；刷新页面不会重复提醒 |
| 睡眠计时线 | 独立一条线，显示距目标（默认 8 小时）还差多少 / 已睡够 |
| 晚间三行复盘 | 今天做成了什么 / 被什么打断 / 明天最重要的一件事；按日期存取，可回看最近 8 天 |
| 本地数据 | IndexedDB 事件流；导出 / 导入 JSON；清空前二次确认 |
| 离线 | Service Worker 缓存界面骨架，断网照常打开 |

**还没做（阶段二，套 Capacitor 之后）**：后台保活、识别你切到了哪个 App、锁屏推送。阶段一里 `visibilitychange` 只记「离开了几次」，不暂停计时——时间戳差值，切走多久都不会算错。

---

## 跑起来

### 本地看效果

Service Worker 在 `file://` 下不生效，必须走 http：

```bash
cd timelog
python -m http.server 8765
# 手机同 WiFi 访问 http://<电脑IP>:8765
```

> 局域网只能调试：手机浏览器不会把它当成可安装的 PWA（需要 HTTPS）。

### 部署（已部署）

线上地址 <https://sl1u0513.github.io/timelog/>，仓库 <https://github.com/SL1u0513/timelog>（公开，只有程序文件，记录都留在手机本地）。

```bash
# 常规方式
git init && git add . && git commit -m "init"
git remote add origin https://github.com/<你>/<仓库>.git && git push -u origin main
# 仓库 Settings → Pages → Source: Deploy from a branch → main / (root)
```

> 如果所在网络 `git push` 到 github.com 被重置（本机就是这种情况），改用 API 直传，一条 commit 覆盖线上：
>
> ```bash
> node tools/push-via-api.cjs SL1u0513/timelog main "deploy: 改了什么"
> ```
>
> 依赖已登录的 `gh`（`gh auth login`），走 `api.github.com`，不经过 git 协议。

**Vercel / Netlify**：把 `timelog` 文件夹拖进去，不需要构建命令，发布目录填 `.`。

部署完手机打开链接 → 浏览器菜单 → **添加到主屏幕 / 安装应用**。

> 改完代码记得把 `sw.js` 里的 `CACHE = 'timelog-v1'` 版本号 +1，否则手机上可能还是旧界面。

---

## 目录

```
timelog/
├── index.html              页面骨架（四个视图 + 两个底部面板）
├── css/app.css             全部样式（深色、移动优先）
├── js/db.js                IndexedDB 封装：events / reviews
├── js/app.js               状态机、渲染、底线、复盘、导入导出
├── manifest.webmanifest    PWA 清单
├── sw.js                   Service Worker（骨架缓存 + 导航网络优先）
├── icons/                  192 / 512 / maskable / apple-touch
└── tools/
    ├── make-icons.py       生成图标（Pillow）
    └── smoke-test.cjs      真实浏览器冒烟测试（Playwright + Edge）
```

---

## 数据模型

一条事件（`events` 表，keyPath `id`）：

```js
{
  id: "uuid",
  type: "focus" | "game" | "sleep",
  startAt: 1732000000000,     // 毫秒时间戳
  endAt: null | 1732003600000,// null = 进行中
  endReason: "natural" | "interrupted" | "switched" | "manual",
  note: "被消息打断了一次",
  state: "open" | "closed",   // 便于按「未闭合」建索引
  leftCount: 2,               // 这段期间页面被切走的次数
  leftAt: 1732000900000,
  warnedAt: 1732003300000     // 预警只触发一次
}
```

复盘（`reviews` 表，keyPath `date`，形如 `2026-11-18`）：`{ date, a, b, c, updatedAt }`。

设置项在 `localStorage`（`timelog.settings.v1`）：游戏时间盒、预警提前量、睡眠目标、底线条款。

**每日汇总不存快照**，每次由事件实时聚合；跨零点的事件按重叠时长拆到两天。删一条、改一条，数字立刻重算。

### 计时状态机

1. 点开始 → 写入一条 `state: "open"`、`endAt: null` 的事件；
2. 已有进行中的记录时再点别的 → 先把上一条收尾为 `switched`（切走了），再开始新的；
3. 页面切到后台（`visibilitychange`）→ 只给 `leftCount + 1`，**不暂停、不结算**；
4. 点结束 → 写入 `endAt` 和 `endReason`，`state` 改成 `closed`；
5. 重进页面 → 扫描未闭合事件，按当前时间校正后提示「有一段进行中的记录」；
6. 时长永远等于 `endAt - startAt`（进行中则 `now - startAt`），**不用定时器累加**，所以后台冻结、锁屏、切走都不影响结果。

默认同一时刻只允许一条未闭合记录；万一因为崩溃留下多条，启动时会把多余的那些按「手动收尾」补上。

---

## 测试

```bash
# 需要 Playwright（npm i -g playwright）与本机 Edge
NODE_PATH="$(npm root -g)" node tools/smoke-test.cjs http://127.0.0.1:8765/ ./.tmp/shots
```

会真的跑一遍：空态 → 开始计时 → 结束并选原因 → 校验 IndexedDB 落库 → 游戏时间盒预警与超时 → 刷新后恢复 → 切走计数 → 底线增删 → 复盘保存 → Service Worker 注册 → 断网重载 → 桌面宽屏，并输出截图。

---

## 已知边界

- 数据只在这台设备这个浏览器里，换设备/清缓存会丢（先导出 JSON）；
- 没有后台通知：锁屏后的预警不响，倒计时只在页面里；
- 睡眠跨零点按重叠时长拆到两天，详情页显示的仍是整段总时长；
- 不做账号、不做同步、不做上课按钮和瞎想按钮。
