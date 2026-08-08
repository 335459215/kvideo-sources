#!/usr/bin/env node
/**
 * KVideo 源健康巡检 - 零依赖 Node 实现
 *
 * 架构(2026-08-08 v2, 正常/成人分池):
 *   master.json         正常源总文件(只读, 巡检永不修改; 手动加源/手动禁用都改这里)
 *   adult-master.json   成人源总文件(只读, 巡检永不修改)
 *   sources.json        订阅输出(巡检自动重写: 只放验证有效的源, 按来源打组 normal/premium)
 *   disabled.json       失效归档(巡检自动重写: 无效源+原因, 仅供参考)
 *   report.md           巡检报告(历史趋势)
 *
 * 分组规则: 来自 master.json 的源 -> group=normal(保留原 group 值),
 *           来自 adult-master.json 的源 -> group=premium(KVideo 官方 premium 分流)
 *
 * 用法: node check_sources.js
 */
const fs = require('fs');
const path = require('path');

const MASTER_PATH = path.join(__dirname, 'master.json');          // 正常源总文件(只读)
const ADULT_MASTER_PATH = path.join(__dirname, 'adult-master.json'); // 成人源总文件(只读)
const CONFIG_PATH = path.join(__dirname, 'sources.json');         // 订阅输出(有效)
const ARCHIVE_PATH = path.join(__dirname, 'disabled.json');       // 归档输出(无效)
const REPORT_PATH = path.join(__dirname, 'report.md');
const TIMEOUT_MS = 10000;
const MAX_RETRY = 2;
const CONCURRENCY = 8;
const MAX_HISTORY = 30;

if (!fs.existsSync(MASTER_PATH)) {
  console.error('❌ master.json 不存在');
  process.exit(1);
}
if (!fs.existsSync(ADULT_MASTER_PATH)) {
  console.error('❌ adult-master.json 不存在');
  process.exit(1);
}
const normalAll = JSON.parse(fs.readFileSync(MASTER_PATH, 'utf-8'));
const adultAll = JSON.parse(fs.readFileSync(ADULT_MASTER_PATH, 'utf-8'));

// 合并池, 记录来源, 按来源打组
// 来自正常总文件: 保留原 group(normal/cartoon/documentary...)
// 来自成人总文件: 强制 group=premium(KVideo 只认 premium 才进 premiumSources)
const all = [
  ...normalAll.map(s => ({ ...s, group: s.group || 'normal', _src: 'normal' })),
  ...adultAll.map(s => ({ ...s, group: 'premium', _src: 'adult' })),
];

// id 冲突检查(两个文件不该有相同 id)
const seen = new Map();
for (const s of all) {
  if (seen.has(s.id)) {
    console.error(`❌ id 冲突: "${s.id}" 同时出现在两个总文件(${seen.get(s.id)} vs ${s._src}), 巡检终止`);
    process.exit(1);
  }
  seen.set(s.id, s._src);
}

const today = new Date().toISOString().slice(0, 10);

// 历史(report.md 内嵌 JSON): 按天去重, 同一天多次巡检只保留一条记录
let history = [];
if (fs.existsSync(REPORT_PATH)) {
  const old = fs.readFileSync(REPORT_PATH, 'utf-8');
  const m = old.match(/```json\n([\s\S]+?)\n```/);
  if (m) { try { history = JSON.parse(m[1]); } catch {} }
}
history = history.filter(h => h.date !== today);
history.push({ date: today, results: [] });
if (history.length > MAX_HISTORY) history = history.slice(-MAX_HISTORY);

const delay = ms => new Promise(r => setTimeout(r, ms));

async function fetchWithTimeout(url) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      signal: ctrl.signal,
      headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' },
      redirect: 'follow',
    });
    const text = await res.text();
    return { ok: res.ok, text };
  } finally {
    clearTimeout(t);
  }
}

async function testSource(item) {
  // 总文件中手动禁用的跳过复测
  if (item._comment === '手动禁用') {
    return { success: false, reason: '手动禁用', isManualDisabled: true };
  }
  const sep = item.baseUrl.includes('?') ? '&' : '?';
  const url = `${item.baseUrl}${sep}ac=list&pg=1`;
  for (let attempt = 1; attempt <= MAX_RETRY; attempt++) {
    try {
      const { ok, text } = await fetchWithTimeout(url);
      if (!ok) {
        if (attempt === MAX_RETRY) return { success: false, reason: 'HTTP 非200/宕机' };
        await delay(1000); continue;
      }
      let data = null;
      try { data = JSON.parse(text); } catch {}
      if (data && (data.code === 1 || data.code === 0) &&
          Array.isArray(data.list) && data.list.length > 0) {
        return { success: true, reason: '正常' };
      }
      return { success: false, reason: data && data.list ? '列表为空' : '接口解析错误/非JSON' };
    } catch (e) {
      if (attempt === MAX_RETRY) return { success: false, reason: '超时/宕机' };
      await delay(1000);
    }
  }
  return { success: false, reason: '超时/宕机' };
}

async function main() {
  const normalCount = normalAll.length;
  const adultCount = adultAll.length;
  console.log(`⏳ 巡检开始: ac=list 存活测试, 正常源池 ${normalCount} + 成人源池 ${adultCount} = ${all.length} 个`);
  const results = [];
  const queue = all.map(item => () => testSource(item).then(res => ({ ...item, ...res })));
  const workers = Array(Math.min(CONCURRENCY, queue.length)).fill(0).map(async () => {
    while (queue.length) {
      const job = queue.shift();
      if (!job) break;
      results.push(await job());
    }
  });
  await Promise.all(workers);

  history[history.length - 1].results = results.map(r => ({ api: r.baseUrl, success: r.success }));

  // 统计分级(基于历史)
  const stats = results.map(item => {
    const entries = history.map(h => h.results.find(x => x.api === item.baseUrl)).filter(Boolean);
    const okCount = entries.filter(h => h.success).length;
    const rate = entries.length ? (okCount / entries.length) * 100 : (item.success ? 100 : 0);
    const trend = history.slice(-7).map(h => {
      const r = h.results.find(x => x.api === item.baseUrl);
      return r ? (r.success ? '✅' : '❌') : '-';
    }).join('');
    let streakFail = 0;
    for (let i = history.length - 1; i >= 0; i--) {
      const r = history[i].results.find(x => x.api === item.baseUrl);
      if (r && !r.success) streakFail++;
      else break;
    }
    let statusIcon = '✅';
    if (item.isManualDisabled) statusIcon = '🚫';
    else if (streakFail >= 3) statusIcon = '🚨';
    else if (!item.success) statusIcon = '❌';
    // 优先级: 老源按成功率晋级; 新源(历史不足3天)观察期固定10, 不冲榜
    let priority = 10;
    const histDays = entries.length;
    if (statusIcon === '✅') {
      if (histDays >= 3) priority = rate >= 100 ? 1 : (rate >= 90 ? 5 : 10);
      else priority = 10;
    } else if (statusIcon === '🚫') priority = 999;
    else priority = 100 + Math.min(streakFail, 99);
    return { ...item, statusIcon, rate: rate.toFixed(1) + '%', trend, priority };
  });

  // 输出: 有效 -> sources.json(订阅, 按来源打组); 无效 -> disabled.json(归档)
  const good = stats.filter(s => s.statusIcon === '✅')
    .map(s => ({ id: s.id, name: s.name, baseUrl: s.baseUrl, searchPath: s.searchPath || '', detailPath: s.detailPath || '', group: s._src === 'adult' ? 'premium' : (s.group || 'normal'), enabled: true, priority: s.priority }))
    .sort((a, b) => a.priority - b.priority || a.name.localeCompare(b.name));
  const bad = stats.filter(s => s.statusIcon !== '✅')
    .map(s => ({ id: s.id, name: s.name, baseUrl: s.baseUrl, searchPath: s.searchPath || '', detailPath: s.detailPath || '', group: s._src === 'adult' ? 'premium' : (s.group || 'normal'), enabled: false, priority: s.priority, _comment: s.reason }))
    .sort((a, b) => a.priority - b.priority);

  fs.writeFileSync(CONFIG_PATH, JSON.stringify(good, null, 2) + '\n');
  fs.writeFileSync(ARCHIVE_PATH, JSON.stringify(bad, null, 2) + '\n');

  // report.md
  const nowCST = new Date(Date.now() + 8 * 3600 * 1000).toISOString().replace('T', ' ').slice(0, 16) + ' CST';
  const goodNormal = good.filter(s => s.group !== 'premium').length;
  const goodAdult = good.filter(s => s.group === 'premium').length;
  let md = `# 🎬 API 健康巡检报告\n\n`;
  md += `> **更新时间：** ${nowCST} | **检测方式：** ac=list 存活测试 | **源池：** 正常 ${normalCount} + 成人 ${adultCount} = ${all.length} | **订阅生效：** ${good.length}(正常 ${goodNormal} + 成人 ${goodAdult}) | **失效归档：** ${bad.length}\n\n`;
  md += `| 状态 | 分组 | 资源名称 | 优先级 | 成功率 | 最近7天趋势 | 源站地址 | 备注 |\n`;
  md += `| :--- | :--- | :--- | :---: | :---: | :--- | :--- | :--- |\n`;
  stats.sort((a, b) => a.priority - b.priority).forEach(s => {
    const host = s.baseUrl.replace('https://', '').replace('http://', '').split('/')[0];
    const grp = s._src === 'adult' ? '🔞 成人' : '正常';
    md += `| ${s.statusIcon} | ${grp} | **${s.name}** | ${s.priority} | ${s.rate} | \`${s.trend}\` | [${host}](${s.baseUrl}) | ${s.statusIcon === '✅' ? '-' : s.reason} |\n`;
  });
  md += `\n### 💡 状态说明\n- ✅ **生效(在订阅中)** | ❌ **失效(不在订阅中)** | 🚨 **连断3天+** | 🚫 **手动禁用**\n`;
  md += `- 巡检只读 master.json(正常总池) + adult-master.json(成人总池), 自动把有效源写入 sources.json 订阅, 失效源留在池中不进入订阅, 恢复后自动回到订阅。\n`;
  md += `- 分组规则: 正常总文件 → group=normal, 成人总文件 → group=premium(KVideo /premium 分流)。\n\n`;
  md += `<details><summary>📜 历史统计数据 (JSON)</summary>\n\n\`\`\`json\n${JSON.stringify(history, null, 2)}\n\`\`\`\n</details>\n`;
  fs.writeFileSync(REPORT_PATH, md);

  console.log(`✅ 完成: 订阅生效 ${good.length}(正常 ${goodNormal} + 成人 ${goodAdult}) / 失效归档 ${bad.length} (总池 ${all.length} 未动)`);
  console.log(`❌ 失联: ${stats.filter(s => s.statusIcon === '❌').length} | 🚨 连断: ${stats.filter(s => s.statusIcon === '🚨').length} | 🚫 手动: ${stats.filter(s => s.statusIcon === '🚫').length}`);
}

main().catch(e => { console.error('巡检失败:', e); process.exit(1); });
