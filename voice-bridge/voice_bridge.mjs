/** 微信语音桥：合成语音，转换为 SILK，并通过原生语音条接口发送。 */

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { setTimeout as sleep } from 'node:timers/promises';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ARG = new Set(process.argv.slice(2));
if (ARG.has('--voice-prepare')) throw new Error('此版本不支持只构造语音对象；未发送消息');
const flagValue = (name) => {
  const i = process.argv.indexOf(name);
  return i > 0 ? process.argv[i + 1] : undefined;
};

const readJson = (file, fallback = null) => {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
  } catch {
    return fallback;
  }
};
const writeJson = (file, value) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2));
  fs.renameSync(tmp, file);
};

let config = readJson(path.join(HERE, 'config.json'));
// 配置页改完写回 config.json，桥每轮重读一次，不用重启进程。
const reloadConfig = () => {
  try {
    const next = readJson(path.join(HERE, 'config.json'));
    if (next) config = next;
  } catch {}
};
if (!config) {
  console.error('缺少 config.json');
  process.exit(1);
}

// 命令行临时覆盖，用来试服务/试音色，不用改文件：
//   --provider http --base-url http://127.0.0.1:9880 --api-key xxx --voice feiyu --style cute
const overrides = {
  provider: flagValue('--provider'),
  baseUrl: flagValue('--base-url'),
  apiKey: flagValue('--api-key'),
  voice: flagValue('--voice'),
  style: flagValue('--style')
};
if (overrides.provider) config.tts = { ...config.tts, provider: overrides.provider };
if (overrides.baseUrl || overrides.apiKey || overrides.voice || overrides.style) {
  config.http = {
    ...config.http,
    ...(overrides.baseUrl ? { baseUrl: overrides.baseUrl } : {}),
    ...(overrides.apiKey ? { apiKey: overrides.apiKey } : {}),
    ...(overrides.voice ? { voice: overrides.voice } : {}),
    ...(overrides.style ? { style: overrides.style } : {})
  };
}
const ROOT = config.wechatagentRoot;
const STATE_DIR = path.join(HERE, 'state');
const TMP_DIR = path.join(HERE, '.tmp');
const SEEN_FILE = path.join(STATE_DIR, 'seen.json');
const LOG_FILE = path.join(STATE_DIR, 'voice-bridge.log');
fs.mkdirSync(STATE_DIR, { recursive: true });
fs.mkdirSync(TMP_DIR, { recursive: true });

/**
 * 单实例锁：开机自启 + 手动再点一次 start.cmd 时，第二个进程直接退出，
 * 否则两条桥同时盯着同一个缓冲，一条回复会发两张卡片。
 */
const LOCK_FILE = path.join(STATE_DIR, 'bridge.pid');
const alive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};
if (!ARG.has('--probe') && !ARG.has('--dry') && !ARG.has('--test') && !ARG.has('--send-file') && !ARG.has('--once')) {
  const previous = Number.parseInt(fs.existsSync(LOCK_FILE) ? fs.readFileSync(LOCK_FILE, 'utf8').trim() : '', 10);
  if (Number.isInteger(previous) && previous !== process.pid && alive(previous)) {
    console.log(`已有语音桥在跑（pid ${previous}），本进程退出`);
    process.exit(0);
  }
  fs.writeFileSync(LOCK_FILE, String(process.pid));
  process.on('exit', () => {
    try {
      if (fs.readFileSync(LOCK_FILE, 'utf8').trim() === String(process.pid)) fs.unlinkSync(LOCK_FILE);
    } catch {}
  });
}

const log = (...parts) => {
  const line = `[${new Date().toISOString()}] ${parts.join(' ')}`;
  console.log(line);
  try {
    fs.appendFileSync(LOG_FILE, line + '\n');
  } catch {}
};

/* ───────────────────────── WeChatAgent 侧：认证 / 账号 / 发送 ───────────────────────── */

const tokenCandidates = [
  path.join(ROOT, 'state/hook/wechat-4.1.10.27/wechatagent-hook.token'),
  path.join(ROOT, 'state/hook/native-token.txt')
];
const hookToken = () => {
  for (const file of tokenCandidates) {
    try {
      const value = fs.readFileSync(file, 'utf8').trim();
      if (value.length === 64) return value;
    } catch {}
  }
  return '';
};

const hookBase = () => (readJson(path.join(ROOT, 'config/wechatagent.json'))?.hook?.baseUrl) || 'http://127.0.0.1:30001';

let cachedAccount = '';

async function hookHealth() {
  const response = await fetch(`${hookBase()}/WeChatAgent/health`, {
    headers: { Authorization: 'Bearer ' + hookToken() },
    signal: AbortSignal.timeout(8000)
  });
  if (!response.ok) throw new Error('hook health HTTP ' + response.status);
  const body = await response.json();
  if (!body.nativeVoiceSend) throw new Error('原生语音条发送不可用（版本或 hook 未就绪）');
  const accounts = Array.isArray(body.databaseAccounts) ? body.databaseAccounts : [];
  if (accounts.length !== 1) throw new Error('微信账号数不为 1，拒绝发送');
  cachedAccount = accounts[0];
  return body;
}

/**
 * hook 里文字/图片/文件/表情共用一把 sendMutex（try_lock_for 1s），抢不到就 429。
 * 撞上机器人正在发文字时属于正常现象：退避重试，最多 3 次，不硬挤。
 */
/**
 * hook 只接受 <root>/state/files/outgoing/<64位hex>/<文件名> 下的文件，
 * 并校验 md5、size、普通文件、无符号链接。
 */
function stage(file, displayName) {
  const bytes = fs.readFileSync(file);
  const sha256 = crypto.createHash('sha256').update(bytes).digest('hex');
  const md5 = crypto.createHash('md5').update(bytes).digest('hex');
  const dir = path.join(ROOT, 'state/files/outgoing', sha256);
  fs.mkdirSync(dir, { recursive: true });
  const destination = path.join(dir, displayName);
  fs.writeFileSync(destination, bytes);
  return { path: destination, md5, size: bytes.length, sha256 };
}

/* ─────────────────── 34 型语音条：silk + XML + /SendVoiceMsg ─────────────────── */


/** wav 直接读头，其余交给 ffprobe。返回秒。 */
async function durationSeconds(file) {
  if (path.extname(file).toLowerCase() === '.wav') {
    const buffer = fs.readFileSync(file);
    if (buffer.toString('ascii', 0, 4) === 'RIFF' && buffer.toString('ascii', 8, 12) === 'WAVE') {
      let offset = 12;
      let fmt = null;
      let dataSize = 0;
      while (offset + 8 <= buffer.length) {
        const id = buffer.toString('ascii', offset, offset + 4);
        const size = buffer.readUInt32LE(offset + 4);
        if (id === 'fmt ' && offset + 24 <= buffer.length) {
          fmt = {
            channels: buffer.readUInt16LE(offset + 10),
            rate: buffer.readUInt32LE(offset + 12),
            bits: buffer.readUInt16LE(offset + 22)
          };
        } else if (id === 'data') {
          dataSize = Math.min(size, buffer.length - offset - 8);
          break;
        }
        offset += 8 + size + (size % 2);
      }
      if (fmt && dataSize && fmt.rate && fmt.channels && fmt.bits) {
        return dataSize / (fmt.rate * fmt.channels * (fmt.bits / 8));
      }
    }
  }
  return new Promise((resolve) => {
    const child = spawn(config.tts?.ffprobe || 'ffprobe',
      ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', file], { windowsHide: true });
    let text = '';
    child.stdout.on('data', (chunk) => (text += chunk));
    child.on('error', () => resolve(0));
    child.on('close', () => resolve(Number.parseFloat(text.trim()) || 0));
  });
}

/** TTS 产物 → 微信 SILK v3（24kHz 单声道，头带 0x02 前缀）。 */
async function toSilk(input, output) {
  const script = path.join(HERE, 'tools', 'silk_encode.py');
  if (!fs.existsSync(script)) throw new Error('缺少 tools/silk_encode.py');
  await run(config.tts?.python || 'python', [script, input, output]);
  const bytes = fs.readFileSync(output);
  if (bytes.length < 128) throw new Error(`silk 结果异常（${bytes.length}B）`);
  const header = bytes.subarray(1, 10).toString('ascii');
  if (header !== '#!SILK_V3') throw new Error('silk 头不对：' + bytes.subarray(0, 12).toString('hex'));
  return { path: output, size: bytes.length };
}

/* ───────────────────────── TTS：两条后端 ───────────────────────── */

const run = (command, args) =>
  new Promise((resolve, reject) => {
    const child = spawn(command, args, { windowsHide: true });
    let stderr = '';
    child.stderr.on('data', (chunk) => (stderr += chunk));
    child.on('error', reject);
    child.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`${command} 退出码 ${code}：${stderr.slice(0, 300)}`))));
  });

const cleanForSpeech = (text) =>
  String(text)
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/https?:\/\/\S+/g, ' ')
    .replace(/[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{FE0F}\u{2B00}-\u{2BFF}]/gu, '')
    .replace(/[`*_#>~|]/g, '')
    .replace(/\s*\n+\s*/g, '，')
    .replace(/[，,]{2,}/g, '，')
    .trim();

async function ttsEdge(text, output) {
  const { python = 'python', voice = 'zh-CN-XiaoxiaoNeural', rate = '+0%', pitch = '+0Hz', volume = '+0%' } = config.tts ?? {};
  await run(python, ['-m', 'edge_tts', '--voice', voice, '--rate', rate, '--pitch', pitch, '--volume', volume, '--text', text, '--write-media', output]);
}

const httpService = () => {
  const http = config.http ?? {};
  const base = String(http.baseUrl || 'http://127.0.0.1:9880').replace(/\/+$/, '');
  const headers = { Authorization: 'Bearer ' + (http.apiKey || ''), 'Content-Type': 'application/json' };
  return { http, base, headers };
};

/** 飞鱼服务是 202 + 队列：轮询到 success 再取音频 */
async function awaitJob(base, headers, jobId, output) {
  const { http } = httpService();
  const deadline = Date.now() + (http.timeoutSeconds || 180) * 1000;
  while (Date.now() < deadline) {
    await sleep(2000);
    const status = await fetch(`${base}/v1/jobs/${jobId}`, { headers });
    if (!status.ok) throw new Error(`声音服务任务 HTTP ${status.status}`);
    const row = await status.json();
    if (row.status === 'success') {
      const audio = await fetch(`${base}/v1/jobs/${jobId}/audio`, { headers: { Authorization: headers.Authorization } });
      if (!audio.ok) throw new Error(`取音频 HTTP ${audio.status}`);
      fs.writeFileSync(output, Buffer.from(await audio.arrayBuffer()));
      return;
    }
    if (row.status === 'failed' || row.status === 'interrupted') throw new Error('声音任务失败：' + (row.error || row.status));
  }
  throw new Error('声音任务超时');
}

/**
 * provider = audiocpp：audio.cpp 的 audiocpp_server（OpenAI 兼容 /v1/audio/speech）。
 * 参考音频与台词写在服务端 server.json 的 default_voice_preset 里，这边只发文字。
 * 返回的是 WAV 二进制。
 */
async function ttsAudiocpp(text, output) {
  const { audiocpp = {} } = config;
  const base = String(audiocpp.baseUrl || 'http://127.0.0.1:8099').replace(/\/+$/, '');
  const response = await fetch(base + '/v1/audio/speech', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json; charset=utf-8' },
    body: JSON.stringify({ model: audiocpp.model || 'cosyvoice3-feiyu', input: text }),
    signal: AbortSignal.timeout((audiocpp.timeoutSeconds || 120) * 1000)
  });
  if (!response.ok) {
    const detail = await response.text().catch(() => '');
    throw new Error(`audiocpp HTTP ${response.status} ${detail.slice(0, 160)}`);
  }
  const bytes = Buffer.from(await response.arrayBuffer());
  if (bytes.length < 1024) throw new Error('audiocpp 返回音频过小');
  fs.writeFileSync(output, bytes);
}

/** provider = http：直接把文字交给飞鱼 TTS（CosyVoice3），拿到就是肥鱼声线 */
async function ttsHttp(text, output) {
  const { http, base, headers } = httpService();
  const submit = await fetch(base + '/v1/speech', {
    method: 'POST',
    headers,
    body: JSON.stringify({ voice: http.voice || 'feiyu', text, style: http.style || 'cute' }),
    signal: AbortSignal.timeout(30000)
  });
  if (!submit.ok) throw new Error(`声音服务 HTTP ${submit.status}`);
  const job = await submit.json();
  await awaitJob(base, headers, job.id, output);
}

/**
 * provider = http-rvc：不跑 CosyVoice，用便宜的 edge-tts 出干声，
 * 再调飞鱼服务的 /v1/voice-conversion 换成肥鱼音色。
 * 服务端只要装了 RVC 就能用，比整套 TTS 轻。
 */
async function ttsHttpRvc(text, output) {
  const { http, base, headers } = httpService();
  const dry = path.join(TMP_DIR, `dry-${Date.now()}-${crypto.randomBytes(3).toString('hex')}.wav`);
  const mp3 = path.join(TMP_DIR, `dry-${Date.now()}-${crypto.randomBytes(3).toString('hex')}.mp3`);
  await ttsEdge(text, mp3);
  await run(config.tts?.ffmpeg || 'ffmpeg', ['-y', '-loglevel', 'error', '-i', mp3, '-ac', '1', '-ar', '44100', dry]);

  const form = new FormData();
  form.append('file', new Blob([fs.readFileSync(dry)], { type: 'audio/wav' }), 'vocal.wav');
  const upload = await fetch(base + '/v1/assets', {
    method: 'POST',
    headers: { Authorization: headers.Authorization },
    body: form,
    signal: AbortSignal.timeout(60000)
  });
  if (!upload.ok) throw new Error(`上传干声 HTTP ${upload.status}`);
  const asset = await upload.json();

  const submit = await fetch(base + '/v1/voice-conversion', {
    method: 'POST',
    headers,
    body: JSON.stringify({ voice: http.voice || 'feiyu', audio_id: asset.id }),
    signal: AbortSignal.timeout(30000)
  });
  if (!submit.ok) throw new Error(`换声请求 HTTP ${submit.status}`);
  const job = await submit.json();
  await awaitJob(base, headers, job.id, output);
}

async function synthesize(text) {
  const stamp = `${Date.now()}-${crypto.randomBytes(3).toString('hex')}`;
  const provider = config.tts?.provider || 'edge';
  const raw = path.join(TMP_DIR, `tts-${stamp}` + (provider === 'edge' ? '.mp3' : '.wav'));
  if (provider === 'http') await ttsHttp(text, raw);
  else if (provider === 'http-rvc') await ttsHttpRvc(text, raw);
  else if (provider === 'audiocpp') await ttsAudiocpp(text, raw);
  else await ttsEdge(text, raw);
  const mp3 = path.join(TMP_DIR, `voice-${stamp}.mp3`);
  if (path.extname(raw) === '.mp3') {
    fs.copyFileSync(raw, mp3);
  } else {
    await run(config.tts?.ffmpeg || 'ffmpeg', ['-y', '-loglevel', 'error', '-i', raw, '-ac', '1', '-ar', '24000', '-b:a', config.send?.bitrate || '64k', mp3]);
  }
  const size = fs.statSync(mp3).size;
  if (size < 1024) throw new Error('合成结果异常（文件过小）');
  return mp3;
}

async function sendNativeVoice(target, staged, durationMs) {
  if (!cachedAccount) await hookHealth();
  for (let attempt = 1; ; attempt++) {
    // A timeout or connection failure has an unknown result: never retry it.
    const response = await fetch(`${hookBase()}/SendVoiceMsg`, {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + hookToken(), 'X-WeChatAgent-Account': cachedAccount, 'Content-Type': 'application/json' },
      body: JSON.stringify({ wxidorgid: target, path: staged.path, md5: staged.md5, size: staged.size, durationMs }),
      signal: AbortSignal.timeout(20000)
    });
    const text = await response.text();
    // 429 is returned before dispatch while the shared send lock is busy.
    if (response.status === 429 && attempt < 3) { await sleep(600 * attempt); continue; }
    if (!response.ok) throw new Error(`语音发送状态未知或被拒绝：HTTP ${response.status} ${text.slice(0, 120)}`);
    const body = JSON.parse(text || '{}');
    if (body.ret !== 0) throw new Error('语音未被原生接口接受：' + (body.error || text));
    return body;
  }
}
function splitSpeech(text) {
  const chars = Array.from(text);
  if (chars.length < 2) throw new Error('语音超过单条时长限制且无法继续拆分');
  const middle = Math.floor(chars.length / 2);
  let cut = -1, best = Infinity;
  for (let i = 1; i < chars.length; i++) {
    if (!/[。！？；，.!?;,\n]/u.test(chars[i - 1])) continue;
    const distance = Math.abs(i - middle);
    if (distance < best) { best = distance; cut = i; }
  }
  if (cut < 1) cut = middle;
  return [chars.slice(0, cut).join('').trim(), chars.slice(cut).join('').trim()].filter(Boolean);
}
async function prepareSpeech(text, depth = 0) {
  if (depth > 12) throw new Error('语音拆分次数过多');
  const mp3 = await synthesize(text);
  const seconds = await durationSeconds(mp3);
  if (!Number.isFinite(seconds) || seconds <= 0) throw new Error('无法确定合成语音时长');
  if (seconds > 58) {
    const pieces = splitSpeech(text);
    if (pieces.length < 2) throw new Error('语音太长，无法按语句拆分');
    const all = [];
    for (const piece of pieces) all.push(...await prepareSpeech(piece, depth + 1));
    return all;
  }
  const silk = path.join(TMP_DIR, `voice-${Date.now()}-${crypto.randomBytes(5).toString('hex')}.silk`);
  await toSilk(mp3, silk);
  const staged = stage(silk, 'voice.silk');
  return [{ ...staged, durationMs: Math.max(1, Math.round(seconds * 1000)) }];
}
async function speakTo(target, text) {
  if (/^\d+$/.test(String(target))) throw new Error('尚未获取会话 wxid，拒绝向裸 ID 发送');
  const spoken = cleanForSpeech(text);
  if (!spoken) throw new Error('文本为空');
  const segments = await prepareSpeech(spoken);
  for (let i = 0; i < segments.length; i++) {
    await sendNativeVoice(target, segments[i], segments[i].durationMs);
    log(`语音条已提交 → ${target} · 第 ${i + 1}/${segments.length} 段 · ${segments[i].durationMs}ms（送达待确认）`);
  }
  return { ...segments[0], segments: segments.length };
}

/* ───────────────────────── 监听 WeChatAgent 回复缓冲 ───────────────────────── */

const seen = new Set(readJson(SEEN_FILE, { ids: [] }).ids ?? []);
const lastSentAt = new Map();
const persistSeen = () => {
  const ids = [...seen].slice(-4000);
  writeJson(SEEN_FILE, { ids });
};

const decide = (key, message, prevIncoming = '') => {
  if (!config.chats?.[key]) return '未开放声音的会话';
  if (!message.outgoing) return '不是机器人发出';
  if (message.delivery_status !== 'confirmed') return '未确认送达';
  if (!message.text || !String(message.text).trim()) return '没有文字';
  const age = Date.now() / 1000 - Number(message.timestamp || 0);
  if (age > (config.policy?.freshSeconds ?? 120)) return '过期消息';
  const length = [...String(message.text)].length;
  if (length < (config.policy?.minChars ?? 2)) return '太短';
  if (length > (config.policy?.maxChars ?? 36)) return `太长（${length} 字）`;
  const blocked = (config.policy?.skipIfContains ?? []).find((needle) => String(message.text).includes(needle));
  if (blocked) return `含 ${blocked}`;
  const gap = (config.policy?.minIntervalSeconds ?? 150) * 1000;
  if (Date.now() - (lastSentAt.get(key) ?? 0) < gap) return '冷却中';
  if ((config.policy?.mode ?? 'probabilistic') === 'trigger') {
    // 只有她「被要求」才发：看她回复前那条用户消息里有没有触发词
    const words = config.policy?.triggerWords ?? [];
    const hit = words.find((word) => prevIncoming.includes(word));
    return hit ? 'ok' : `没被要求（缺 ${words.slice(0, 3).join('/')}…）`;
  }
  if (Math.random() > (config.policy?.probability ?? 0.3)) return '未抽中';
  return 'ok';
};

/**
 * 私聊的 conversation_id 是数字 ID（123456789），但 hook 的 /SendFileMsg 要的是 wxid。
 * 从对方向我发的消息里收集 conversation_id → sender_wxid 的对应关系，落盘复用。
 */
const PEERS_FILE = path.join(STATE_DIR, 'peers.json');
const peers = readJson(PEERS_FILE, {}) ?? {};
const rememberPeer = (key, message) => {
  if (message.outgoing || !message.sender_wxid) return;
  if (peers[key] !== message.sender_wxid) {
    peers[key] = message.sender_wxid;
    writeJson(PEERS_FILE, peers);
  }
};
const targetFor = (key) => peers[key] || key.split(':')[2];

let busy = false;
// 卡死保护：某次 TTS/发送请求挂住时 busy 会一直为 true，后续扫描全被 return 掉，
// 表现就是"她完全不理人"。超过 2 分钟强制复位。
let busySince = 0;
async function scan({ dry = false, bootstrap = false } = {}) {
  if (busy) {
    if (Date.now() - busySince < 120000) return;
    log('busy 超过 2 分钟，强制复位');
    busy = false;
  }
  busy = true;
  busySince = Date.now();
  reloadConfig();
  try {
    const buffer = readJson(path.join(ROOT, 'state/social-messages.json'));
    if (!buffer?.chats) return;
    const fresh = [];
    for (const [key, rows] of Object.entries(buffer.chats)) {
      if (!Array.isArray(rows)) continue;
      const recentIncoming = [];
      for (const message of rows) {
        if (!message.outgoing) {
          rememberPeer(key, message);
          const text = String(message.text || '').trim();
          if (text) {
            recentIncoming.push(text);
            if (recentIncoming.length > 3) recentIncoming.shift();
          }
          continue;
        }
        const id = message.delivery_id || message.id;
        if (!id || seen.has(id)) continue;
        seen.add(id);
        fresh.push([key, message, recentIncoming.join(' ')]);
      }
    }
    if (bootstrap) {
      persistSeen();
      log(`启动基线：跳过 ${fresh.length} 条历史消息`);
      return;
    }
    for (const [key, message, prev] of fresh) {
      const verdict = decide(key, message, prev);
      if (verdict !== 'ok') {
        if (verdict !== '未开放声音的会话' && verdict !== '不是机器人发出') log(`跳过 ${key} · ${verdict}`);
        continue;
      }
      if (dry) {
        log(`[dry] 会发语音 → ${key} · ${String(message.text).slice(0, 40)}`);
        continue;
      }
      try {
        await speakTo(targetFor(key), message.text);
        lastSentAt.set(key, Date.now());
      } catch (error) {
        log(`发送失败 ${key}：${error.message}`);
      }
    }
    persistSeen();
  } catch (error) {
    log('扫描失败：' + error.message);
  } finally {
    busy = false;
  }
}

/* ───────────────────────── 入口 ───────────────────────── */

/** 把一个已经生成好的音频文件直接发出去（audio.cpp 之类外部引擎的产物）
 *  --raw 原样发（不转 mp3），用 WAV 检听编码噪声时用；--bitrate 128k 覆盖转码码率 */
async function main() {
if (flagValue('--send-file')) {
  const source = flagValue('--send-file');
  const target = flagValue('--target') || config.send?.testTarget || 'filehelper';
  if (!fs.existsSync(source)) throw new Error('文件不存在');
  const seconds = await durationSeconds(source);
  if (!Number.isFinite(seconds) || seconds <= 0 || seconds > 60) throw new Error('音频时长必须在 0 至 60 秒之间');
  const silk = path.join(TMP_DIR, `file-${Date.now()}-${crypto.randomBytes(5).toString('hex')}.silk`);
  await toSilk(source, silk);
  const staged = stage(silk, 'voice.silk');
  await hookHealth();
  await sendNativeVoice(target, staged, Math.max(1, Math.round(seconds * 1000)));
  log(`语音条已提交 → ${target} · ${Math.round(seconds * 1000)}ms（送达待确认）`);
  console.log(JSON.stringify({ ok: true, target, size: staged.size, durationMs: Math.round(seconds * 1000), delivery: 'unconfirmed' }));
  return;
}

/** 只合成不发送：验证声音服务接线，不往微信里丢东西 */
if (ARG.has('--probe')) {
  const text = flagValue('--probe') || '我在呢，今天想听我说什么';
  const started = Date.now();
  const mp3 = await synthesize(cleanForSpeech(text));
  const duration = await new Promise((resolve) => {
    const child = spawn(config.tts?.ffmpeg ? config.tts.ffmpeg.replace(/ffmpeg(\.exe)?$/i, 'ffprobe$1') : 'ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', mp3], { windowsHide: true });
    let out = '';
    child.stdout.on('data', (chunk) => (out += chunk));
    child.on('error', () => resolve(null));
    child.on('close', () => resolve(Number.parseFloat(out) || null));
  });
  console.log(JSON.stringify({ ok: true, provider: config.tts?.provider || 'edge', bytes: fs.statSync(mp3).size, seconds: duration, costMs: Date.now() - started, path: mp3 }, null, 2));
  return;
}

if (flagValue('--test')) {
  const text = flagValue('--test');
  const target = flagValue('--target') || config.send?.testTarget || 'filehelper';
  await hookHealth();
  const staged = await speakTo(target, text);
  console.log(JSON.stringify({ ok: true, target, size: staged.size, segments: staged.segments, delivery: 'unconfirmed' }, null, 2));
  return;
}

await hookHealth();
const BACKEND = { edge: `edge-tts(${config.tts?.voice || 'zh-CN-XiaoxiaoNeural'})`, http: '飞鱼 TTS 服务', 'http-rvc': 'edge-tts + 飞鱼 RVC 换声' };
log(`语音桥启动 · root=${ROOT} · 后端=${BACKEND[config.tts?.provider || 'edge'] || config.tts?.provider}`);

if (ARG.has('--once') || ARG.has('--dry')) {
  await scan({ dry: ARG.has('--dry') });
  return;
}

await scan({ bootstrap: true });
if (!config.enabled) {
  log('config.enabled = false，只监听不发送');
  return;
}
for (;;) {
  await sleep(1200);
  await scan();
}
}
await main();
