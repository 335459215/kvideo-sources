#!/usr/bin/env node
/**
 * KVideo 源健康巡检 - 零依赖 Node 实现
 * 每天自动: ac=list 存活测试每个源 -> 生效的写入 sources.json(订阅文件), 失效的移出到 disabled.json
 * 用法: node check_sources.js
 */
const fs = require('fs');
const path = require('path');

const CONFIG_PATH = path.join(__dirname, 'sources.json');     // 生效订阅文件
const ARCHIVE_PATH = path.join(__dirname, 'disabled.json');   // 失效归档(保留复测)
const REPORT_PATH = path.join(__dirname, 'report.md');
const TIMEOUT_MS = 10000;
const MAX_RETRY = 2;
const CONCURRENCY = 8;
const MAX_HISTORY = 30;

function loadJSON(p, fallback) {
  if (!fs.existsSync(p)) return fallback;
  try { return JSON.parse(fs.readFileSync(p, 'utf-8')); } catch { return fallback; }
}

// 生效 + 归档 合并(按 baseUrl 去重, 生效优先)
const enabled = loadJSON(CONFIG_PATH, []);
const archived = loadJSON(ARCHIVE_PATH, []);
const byUrl = new Map();
for (const s of enabled) byUrl.set(s.baseUrl, { ...s, _in: 'enabled' });
for (const s of archived) {
  if (!byUrl.has(s.baseUrl)) byUrl.set(s.baseUrl, { ...s, _in: 'archived' });
}
const all = [...byUrl.values()];
const today = new Date().toISOString().slice(0, 10);

// 历史(report.md 内嵌 JSON)
let history = loadJSON(null, []);
if (fs.existsSync(REPORT_PATH)) {
  const old = fs.readFileSync(REPORT_PATH, 'utf-8');
  const m = old.match(/```json\n([\s\S]+?)\n```/);
  if (m) { try { history = JSON.parse(m[1]); } catch {} }
}
history.push({ date: today, results: all.map(r => ({ api: r.baseUrl, success: true })) });
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
  // 仅手动禁用的跳过复测
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
  console.log(`⏳ 巡检开始: ac=list 存活测试, 共 ${all.length} 个源(生效${enabled.length}+归档${archived.length})`);
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

  // 更新历史(用真实结果覆盖占位)
  const histResults = results.map(r => ({ api: r.baseUrl, success: r.success }));
  history[history.length - 1].results = histResults;

  // 统计分级
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
    let priority = 10;
    if (statusIcon === '✅') priority = rate >= 100 ? 1 : (rate >= 90 ? 5 : 10);
    else if (statusIcon === '🚫') priority = 999;
    else priority = 100 + Math.min(streakFail, 99);
    return { ...item, statusIcon, rate: rate.toFixed(1) + '%', trend, priority };
  });

  // 生效 -> sources.json; 失效 -> disabled.json
  const good = stats.filter(s => s.statusIcon === '✅')
    .map(s => ({ id: s.id, name: s.name, baseUrl: s.baseUrl, searchPath: s.searchPath || '', detailPath: s.detailPath || '', group: s.group || 'normal', enabled: true, priority: s.priority }))
    .sort((a, b) => a.priority - b.priority || a.name.localeCompare(b.name));
  const bad = stats.filter(s => s.statusIcon !== '✅')
    .map(s => ({ id: s.id, name: s.name, baseUrl: s.baseUrl, searchPath: s.searchPath || '', detailPath: s.detailPath || '', group: s.group || 'normal', enabled: false, priority: s.priority, _comment: s.reason }))
    .sort((a, b) => a.priority - b.priority);

  fs.writeFileSync(CONFIG_PATH, JSON.stringify(good, null, 2) + '\n');
  fs.writeFileSync(ARCHIVE_PATH, JSON.stringify(bad, null, 2) + '\n');

  // report.md
  const nowCST = new Date(Date.now() + 8 * 3600 * 1000).toISOString().replace('T', ' ').slice(0, 16) + ' CST';
  let md = `# 🎬 API 健康巡检报告\n\n`;
  md += `> **更新时间：** ${nowCST} | **检测方式：** ac=list 存活测试 | **源总数：** ${all.length} | **生效：** ${good.length} | **失效归档：** ${bad.length}\n\n`;
  md += `| 状态 | 资源名称 | 优先级 | 成功率 | 最近7天趋势 | 源站地址 | 备注 |\n`;
  md += `| :--- | :--- | :---: | :---: | :--- | :--- | :--- |\n`;
  stats.sort((a, b) => a.priority - b.priority).forEach(s => {
    const host = s.baseUrl.replace('https://', '').replace('http://', '').split('/')[0];
    md += `| ${s.statusIcon} | **${s.name}** | ${s.priority} | ${s.rate} | \`${s.trend}\` | [${host}](${s.baseUrl}) | ${s.statusIcon === '✅' ? '-' : s.reason} |\n`;
  });
  md += `\n### 💡 状态说明\n- ✅ **生效(订阅中)** | ❌ **失效(已移出到 disabled.json)** | 🚨 **连断3天+** | 🚫 **手动禁用**\n`;
  md += `- 失效源保留在 disabled.json 每天复测, 恢复后自动回到订阅。\n\n`;
  md += `<details><summary>📜 历史统计数据 (JSON)</summary>\n\n\`\`\`json\n${JSON.stringify(history, null, 2)}\n\`\`\`\n</details>\n`;
  fs.writeFileSync(REPORT_PATH, md);

  console.log(`✅ 完成: 生效 ${good.length} / 失效归档 ${bad.length}`);
  console.log(`❌ 本次失联: ${stats.filter(s => s.statusIcon === '❌').length} | 🚨 连断: ${stats.filter(s => s.statusIcon === '🚨').length} | 🚫 手动: ${stats.filter(s => s.statusIcon === '🚫').length}`);
}

main().catch(e => { console.error('巡检失败:', e); process.exit(1); });
