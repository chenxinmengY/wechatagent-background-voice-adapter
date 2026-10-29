/**
 * 小鲸鱼语音桥 · 本地配置页
 *
 * 只干一件事：把 wechat_voice_bridge/config.json 里跟"什么时候发语音"有关的字段
 * 做成一个能点能改的页面。不改桥的代码、不改 WeChatAgent。
 *
 * 用法：
 *   node config-ui.mjs            起在 http://127.0.0.1:8098
 *   node config-ui.mjs 8099       换端口
 *
 * 改完点保存，桥不需要重启 —— 桥每轮扫描都重新读 config.json。
 */

import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CONFIG = path.join(HERE, 'config.json');
const LOG = path.join(HERE, 'state/voice-bridge.log');
const PID = path.join(HERE, 'state/bridge.pid');
const PORT = Number(process.argv[2] || 8098);

const readConfig = () => JSON.parse(fs.readFileSync(CONFIG, 'utf8').replace(/^\uFEFF/, ''));

const writeConfig = (next) => {
  const backup = `${CONFIG}.bak-${Date.now()}`;
  fs.copyFileSync(CONFIG, backup);
  fs.writeFileSync(CONFIG, JSON.stringify(next, null, 2), 'utf8');
  return backup;
};

const json = (res, status, value) => {
  const body = JSON.stringify(value);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(body);
};

const HTML = `<!doctype html><html lang="zh-CN"><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>小鲸鱼 · 语音配置</title>
<style>
:root{--bg:#12141a;--card:#1b1e27;--line:#2b3040;--fg:#e6e8ef;--dim:#8b93a7;--ok:#4ade80;--bad:#f87171;--acc:#7dd3fc}
*{box-sizing:border-box}
body{margin:0;padding:24px;background:var(--bg);color:var(--fg);font:14px/1.6 "Microsoft YaHei",system-ui,sans-serif}
h1{font-size:18px;margin:0 0 4px}
.sub{color:var(--dim);font-size:12px;margin-bottom:20px}
.card{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:16px;margin-bottom:16px}
.card h2{font-size:13px;margin:0 0 12px;color:var(--acc);font-weight:600;letter-spacing:.5px}
.row{display:flex;align-items:center;gap:10px;padding:6px 0}
.row label{flex:0 0 130px;color:var(--dim)}
input[type=text],input[type=number],textarea{background:#0e1016;border:1px solid var(--line);color:var(--fg);border-radius:6px;padding:7px 9px;font:inherit;width:100%}
textarea{min-height:64px;resize:vertical}
input[type=checkbox]{width:16px;height:16px;accent-color:var(--acc)}
.chat{display:flex;align-items:center;gap:10px;padding:8px 10px;border:1px solid var(--line);border-radius:8px;margin-bottom:8px}
.chat code{flex:1;font-size:13px;color:var(--fg)}
.chat .tag{font-size:11px;padding:2px 6px;border-radius:4px;background:#252a37;color:var(--dim)}
.hint{color:var(--dim);font-size:12px;margin-top:8px}
button{background:var(--acc);color:#0b0d12;border:0;border-radius:8px;padding:10px 18px;font:inherit;font-weight:600;cursor:pointer}
button.ghost{background:#252a37;color:var(--fg)}
.bar{position:sticky;bottom:0;background:linear-gradient(180deg,transparent,var(--bg) 30%);padding:16px 0 4px;display:flex;gap:10px;align-items:center}
#msg{font-size:13px}
.ok{color:var(--ok)}.bad{color:var(--bad)}
.warn{background:#2a2318;border:1px solid #4a3a1f;color:#fcd34d;border-radius:8px;padding:10px 12px;font-size:12px;margin-bottom:16px}
</style>
<h1>小鲸鱼 · 语音配置</h1>
<div class="sub">改完点保存，桥下一轮扫描就生效，不用重启。</div>
<div class="warn">「只发语音、不发文字」这个开关这里做不了：桥只会在机器人发出文字之后补一条语音，文字是 WeChatAgent 发的，桥拦不住。要真的二选一，得改 AstrBot 插件的输出策略。</div>

<div class="card" id="statusCard"><h2>运行状态 · 最近判定</h2>
  <div id="statusLine" class="hint">读取中…</div>
  <div id="recent" style="font:12px/1.7 ui-monospace,Consolas,monospace;color:#c8cede;max-height:230px;overflow:auto;margin-top:8px"></div>
  <div class="hint">黄色＝语音条已提交，送达尚未确认；灰色＝跳过，后面写着原因（未抽中 / 没被要求 / 冷却中 / 过期消息 / 未确认送达）。</div>
</div>

<div class="card"><h2>哪些会话可以发语音</h2><div id="chats"></div>
  <div class="row"><label>新会话 ID</label><input type="text" id="newChat" placeholder="wechat:private:123456789"><button class="ghost" id="addChat">添加</button></div>
</div>

<div class="card"><h2>什么时候发</h2>
  <div class="row"><label>模式</label>
    <select id="mode" style="background:#0e1016;border:1px solid var(--line);color:var(--fg);border-radius:6px;padding:7px 9px">
      <option value="trigger">trigger（被要求才发）</option>
      <option value="probabilistic">probabilistic（按概率发）</option>
    </select></div>
  <div class="row"><label>触发词</label><textarea id="triggerWords" placeholder="语音, 发个声, 说句话"></textarea></div>
  <div class="row"><label>概率</label><input type="number" id="probability" step="0.05" min="0" max="1"></div>
  <div class="row"><label>冷却（秒）</label><input type="number" id="minIntervalSeconds" min="0"></div>
  <div class="row"><label>最短字数</label><input type="number" id="minChars" min="0"></div>
  <div class="row"><label>最长字数</label><input type="number" id="maxChars" min="0"></div>
  <div class="row"><label>消息新鲜度（秒）</label><input type="number" id="freshSeconds" min="0"></div>
  <div class="row"><label>含这些就不发</label><textarea id="skipIfContains" placeholder="http://, https://, .zip"></textarea></div>
</div>

<div class="bar"><button id="save">保存</button><button class="ghost" id="reload">重新读取</button><span id="msg"></span></div>

<script>
let cfg = null;
const $ = (id) => document.getElementById(id);
const splitList = (text) => text.split(/[,，\\n]/).map((s) => s.trim()).filter(Boolean);
const joinList = (list) => (list || []).join(', ');

function renderChats() {
  const box = $('chats');
  box.innerHTML = '';
  const entries = Object.entries(cfg.chats || {});
  if (!entries.length) { box.innerHTML = '<div class="hint">还没有会话。加一个 wechat:private:<id> 或 wechat:group:<id>。</div>'; return; }
  for (const [key, enabled] of entries) {
    const row = document.createElement('div');
    row.className = 'chat';
    const isGroup = key.includes(':group:');
    row.innerHTML = '<input type="checkbox" ' + (enabled ? 'checked' : '') + ' data-key="' + key + '">'
      + '<code>' + key + '</code><span class="tag">' + (isGroup ? '群聊' : '私聊') + '</span>'
      + '<button class="ghost" data-del="' + key + '">删</button>';
    box.appendChild(row);
  }
  box.querySelectorAll('input[data-key]').forEach((el) => {
    el.onchange = () => { cfg.chats[el.dataset.key] = el.checked; };
  });
  box.querySelectorAll('button[data-del]').forEach((el) => {
    el.onclick = () => { delete cfg.chats[el.dataset.del]; renderChats(); };
  });
}

function render() {
  $('mode').value = cfg.policy?.mode || 'trigger';
  $('triggerWords').value = joinList(cfg.policy?.triggerWords);
  $('probability').value = cfg.policy?.probability ?? 0.3;
  $('minIntervalSeconds').value = cfg.policy?.minIntervalSeconds ?? 8;
  $('minChars').value = cfg.policy?.minChars ?? 2;
  $('maxChars').value = cfg.policy?.maxChars ?? 60;
  $('freshSeconds').value = cfg.policy?.freshSeconds ?? 180;
  $('skipIfContains').value = joinList(cfg.policy?.skipIfContains);
  renderChats();
}

async function load() {
  const res = await fetch('/api/config');
  cfg = await res.json();
  render();
  $('msg').textContent = '';
}

$('save').onclick = async () => {
  cfg.policy = {
    ...(cfg.policy || {}),
    mode: $('mode').value,
    triggerWords: splitList($('triggerWords').value),
    probability: Number($('probability').value),
    minIntervalSeconds: Number($('minIntervalSeconds').value),
    minChars: Number($('minChars').value),
    maxChars: Number($('maxChars').value),
    freshSeconds: Number($('freshSeconds').value),
    skipIfContains: splitList($('skipIfContains').value)
  };
  const res = await fetch('/api/config', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(cfg) });
  const out = await res.json();
  const m = $('msg');
  if (out.ok) { m.className = 'ok'; m.textContent = '已保存 · 备份 ' + out.backup.split('\\\\').pop(); }
  else { m.className = 'bad'; m.textContent = '保存失败：' + (out.error || ''); }
};

$('reload').onclick = load;

$('addChat').onclick = () => {
  const key = $('newChat').value.trim();
  if (!key) return;
  if (!/^wechat:(private|group):\\S+$/.test(key)) { $('msg').className = 'bad'; $('msg').textContent = '格式要是 wechat:private:<id> 或 wechat:group:<id>'; return; }
  cfg.chats = cfg.chats || {};
  cfg.chats[key] = true;
  $('newChat').value = '';
  renderChats();
};

load();

async function loadRecent() {
  try {
    const res = await fetch('/api/recent');
    const d = await res.json();
    const line = $('statusLine');
    if (d.alive) {
      line.innerHTML = '<span class="ok">● 桥在跑</span> pid ' + d.pid + ' · 日志 ' + d.logAge + ' 秒前更新';
    } else {
      line.innerHTML = '<span class="bad">● 桥没在跑</span>'
        + (d.pid ? '（pid ' + d.pid + ' 已失效）' : '（没有 pid 文件）')
        + (d.logAge >= 0 ? ' · 日志最后更新 ' + d.logAge + ' 秒前' : '');
    }
    const box = $('recent');
    box.innerHTML = '';
    for (const raw of d.lines || []) {
      const div = document.createElement('div');
      div.textContent = raw.replace(/^\\[([^\\]]+)\\]/, (m, t) => '[' + t.slice(11, 19) + ']');
      if (raw.includes('语音条已提交')) div.style.color = '#fcd34d';
      else if (raw.includes('已发送语音')) div.style.color = '#4ade80';
      else if (raw.includes('失败')) div.style.color = '#f87171';
      box.appendChild(div);
    }
  } catch {}
}
loadRecent();
setInterval(loadRecent, 5000);
</script></html>`;

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://127.0.0.1');

  if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html')) {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(HTML);
    return;
  }

  if (req.method === 'GET' && url.pathname === '/api/config') {
    try { json(res, 200, readConfig()); }
    catch (error) { json(res, 500, { error: String(error.message || error) }); }
    return;
  }

  if (req.method === 'POST' && url.pathname === '/api/config') {
    let body = '';
    req.on('data', (chunk) => { body += chunk; if (body.length > 512 * 1024) req.destroy(); });
    req.on('end', () => {
      try {
        const next = JSON.parse(body);
        if (typeof next !== 'object' || next === null) throw new Error('body must be an object');
        if (next.chats && typeof next.chats !== 'object') throw new Error('chats must be an object');
        if (next.policy && typeof next.policy !== 'object') throw new Error('policy must be an object');
        const backup = writeConfig(next);
        json(res, 200, { ok: true, backup });
      } catch (error) {
        json(res, 400, { ok: false, error: String(error.message || error) });
      }
    });
    return;
  }

  if (req.method === 'GET' && url.pathname === '/api/recent') {
    try {
      const text = fs.readFileSync(LOG, 'utf8');
      const lines = text.trim().split('\n').filter(Boolean).slice(-40).reverse();
      const mtime = fs.statSync(LOG).mtimeMs;
      let pid = 0, alive = false;
      try {
        pid = Number(fs.readFileSync(PID, 'utf8').trim()) || 0;
        if (pid) { process.kill(pid, 0); alive = true; }
      } catch { alive = false; }
      json(res, 200, {
        alive,
        pid,
        logAge: Math.round((Date.now() - mtime) / 1000),
        lines
      });
    } catch (error) {
      json(res, 200, { alive: false, pid: 0, logAge: -1, lines: [], error: String(error.message || error) });
    }
    return;
  }

  json(res, 404, { error: 'not found' });
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`语音配置页: http://127.0.0.1:${PORT}/`);
});
