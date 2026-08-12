#!/usr/bin/env node
/**
 * DecoTV 源健康巡检 - 零依赖 Node 实现
 *
 * 与 kvideo 的 check_sources.js 完全分开(文件命名 decotv-*, 格式 api_site)
 *
 * 架构:
 *   decotv-master.json        正常源总文件(只读, 巡检永不修改; api_site 格式)
 *   decotv-adult-master.json  成人源总文件(只读, is_adult=true)
 *   decotv-sources.json       订阅输出(明文配置: 只放验证有效的源, 成人标记 is_adult)
 *   decotv-sources.txt        订阅输出(Base58 编码, 供 DecoTV 后台订阅 URL 使用)
 *   decotv-disabled.json      失效归档(无效源+原因, 仅供参考)
 *   report.md                 巡检报告(与 kvideo 共享报告文件, 增加 DecoTV 区块)
 *
 * 用法: node decotv-check.js
 */
const fs = require('fs');
const path = require('path');

const MASTER_PATH = path.join(__dirname, 'decotv-master.json');
const ADULT_MASTER_PATH = path.join(__dirname, 'decotv-adult-master.json');
const CONFIG_PATH = path.join(__dirname, 'decotv-sources.json');   // 明文订阅
const CONFIG_TXT_PATH = path.join(__dirname, 'decotv-sources.txt'); // Base58 订阅
const ARCHIVE_PATH = path.join(__dirname, 'decotv-disabled.json');
const REPORT_PATH = path.join(__dirname, 'report.md');
const TIMEOUT_MS = 10000;
const MAX_RETRY = 2;
const CONCURRENCY = 8;
const MAX_HISTORY = 30;

if (!fs.existsSync(MASTER_PATH)) { console.error('❌ decotv-master.json 不存在'); process.exit(1); }
if (!fs.existsSync(ADULT_MASTER_PATH)) { console.error('❌ decotv-adult-master.json 不存在'); process.exit(1); }

const masterCfg = JSON.parse(fs.readFileSync(MASTER_PATH, 'utf-8'));
const adultCfg = JSON.parse(fs.readFileSync(ADULT_MASTER_PATH, 'utf-8'));

// 合并池: 记录来源
const normalSites = Object.entries(masterCfg.api_site || {}).map(([key, v]) => ({ key, ...v, _src: 'normal' }));
const adultSites = Object.entries(adultCfg.api_site || {}).map(([key, v]) => ({ key, ...v, _src: 'adult' }));

// key 冲突检查
const seen = new Map();
for (const s of [...normalSites, ...adultSites]) {
  if (seen.has(s.key)) {
    console.error(`❌ key 冲突: "${s.key}" 同时出现在两个总文件, 巡检终止`);
    process.exit(1);
  }
  seen.set(s.key, s._src);
}

const all = [...normalSites, ...adultSites];
const today = new Date().toISOString().slice(0, 10);

// 历史(report.md 内嵌 JSON): 与 kvideo 共享 history 数组, 用 api 区分
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
  } finally { clearTimeout(t); }
}

async function testSource(item) {
  if (item._comment === '手动禁用') return { success: false, reason: '手动禁用', isManualDisabled: true };
  const sep = item.api.includes('?') ? '&' : '?';
  const url = `${item.api}${sep}ac=list&pg=1`;
  for (let attempt = 1; attempt <= MAX_RETRY; attempt++) {
    try {
      const { ok, text } = await fetchWithTimeout(url);
      if (!ok) { if (attempt === MAX_RETRY) return { success: false, reason: 'HTTP 非200/宕机' }; await delay(1000); continue; }
      let data = null;
      try { data = JSON.parse(text); } catch {}
      if (data && (data.code === 1 || data.code === 0) && Array.isArray(data.list) && data.list.length > 0) {
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

// 简易 Base58 编码(零依赖)
const B58_ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
function base58Encode(bytes) {
  if (bytes.length === 0) return '';
  const digits = [0];
  for (let i = 0; i < bytes.length; i++) {
    let carry = bytes[i];
    for (let j = 0; j < digits.length; j++) {
      carry += digits[j] << 8;
      digits[j] = carry % 58;
      carry = (carry / 58) | 0;
    }
    while (carry > 0) { digits.push(carry % 58); carry = (carry / 58) | 0; }
  }
  let out = '';
  for (let i = 0; i < bytes.length && bytes[i] === 0; i++) out += '1';
  for (let i = digits.length - 1; i >= 0; i--) out += B58_ALPHABET[digits[i]];
  return out;
}

async function main() {
  console.log(`⏳ DecoTV 巡检开始: ${normalSites.length} 正常 + ${adultSites.length} 成人 = ${all.length} 个源`);
  const results = [];
  const queue = all.map(item => () => testSource(item).then(res => ({ ...item, ...res })));
  const workers = Array(Math.min(CONCURRENCY, queue.length)).fill(0).map(async () => {
    while (queue.length) { const job = queue.shift(); if (!job) break; results.push(await job()); }
  });
  await Promise.all(workers);

  history[history.length - 1].results = results.map(r => ({ api: r.api, success: r.success }));

  const good = results.filter(r => r.success);
  const bad = results.filter(r => !r.success);

  // 明文订阅配置(api_site 格式, 保留 custom_category)
  const apiSite = {};
  good.forEach(s => {
    const entry = { api: s.api, name: s.name };
    if (s.detail) entry.detail = s.detail;
    if (s._src === 'adult') entry.is_adult = true;
    apiSite[s.key] = entry;
  });
  const config = {
    cache_time: masterCfg.cache_time ?? 7200,
    api_site: apiSite,
    custom_category: masterCfg.custom_category || [],
  };
  // 成人总文件的 custom_category 与正常共享(成人模式用同一配置)
  const configStr = JSON.stringify(config, null, 2) + '\n';
  fs.writeFileSync(CONFIG_PATH, configStr);

  // Base58 编码订阅
  const b58 = base58Encode(Buffer.from(configStr, 'utf-8'));
  fs.writeFileSync(CONFIG_TXT_PATH, b58 + '\n');

  // 失效归档
  const badArchive = bad.map(s => ({
    key: s.key, name: s.name, api: s.api, is_adult: s._src === 'adult' || undefined,
    _comment: s.reason,
  }));
  fs.writeFileSync(ARCHIVE_PATH, JSON.stringify(badArchive, null, 2) + '\n');

  // report.md 更新(追加 DecoTV 区块, 保留 kvideo 的)
  const nowCST = new Date(Date.now() + 8 * 3600 * 1000).toISOString().replace('T', ' ').slice(0, 16) + ' CST';
  const goodNormal = good.filter(s => s._src === 'normal').length;
  const goodAdult = good.filter(s => s._src === 'adult').length;
  let md = '';
  if (fs.existsSync(REPORT_PATH)) {
    md = fs.readFileSync(REPORT_PATH, 'utf-8');
    // 替换旧的 DecoTV 区块(如果有)
    md = md.replace(/## 🎬 DecoTV 巡检区块[\s\S]*?(?=## |$)/, '');
  } else {
    md = '# 🎬 API 健康巡检报告\n\n';
  }
  let decoBlock = `## 🎬 DecoTV 巡检区块\n\n`;
  decoBlock += `> **更新时间：** ${nowCST} | **检测方式：** ac=list 存活测试 | **源池：** 正常 ${normalSites.length} + 成人 ${adultSites.length} = ${all.length} | **订阅生效：** ${good.length}(正常 ${goodNormal} + 成人 ${goodAdult}) | **失效归档：** ${bad.length}\n\n`;
  decoBlock += `| 状态 | 分组 | 资源名称 | 源站地址 | 备注 |\n| :--- | :--- | :--- | :--- | :--- |\n`;
  results.sort((a, b) => a._src.localeCompare(b._src) || a.name.localeCompare(b.name)).forEach(s => {
    const host = s.api.replace('https://', '').replace('http://', '').split('/')[0];
    const grp = s._src === 'adult' ? '🔞 成人' : '正常';
    decoBlock += `| ${s.success ? '✅' : '❌'} | ${grp} | **${s.name}** | [${host}](${s.api}) | ${s.success ? '-' : s.reason} |\n`;
  });
  decoBlock += `\n<details><summary>📜 DecoTV 历史统计 (JSON)</summary>\n\n\`\`\`json\n${JSON.stringify(history, null, 2)}\n\`\`\`\n</details>\n`;
  // 在文件末尾追加 DecoTV 区块
  md = md.replace(/\n*$/, '') + '\n\n' + decoBlock;
  fs.writeFileSync(REPORT_PATH, md);

  console.log(`✅ DecoTV 完成: 订阅生效 ${good.length}(正常 ${goodNormal} + 成人 ${goodAdult}) / 失效归档 ${bad.length} (总池 ${all.length} 未动)`);
}

main().catch(e => { console.error('DecoTV 巡检失败:', e); process.exit(1); });
