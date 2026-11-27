// 自動字幕（Whisper）、SRT 匯入匯出
import * as OpenCC from '../vendor/opencc/cn2t.js';
import { store, layout, totalDuration, newId, fmtSrt, parseTime } from './state.js';
import { exclusive, withSources, buildAudioArgs, ffRun, ffTake, log } from './media.js';

let worker = null, reqId = 0;
const pending = new Map();

function getWorker() {
  if (worker) return worker;
  worker = new Worker(new URL('../whisper-worker.js', import.meta.url), { type: 'module' });
  worker.onmessage = (e) => {
    const m = e.data, p = pending.get(m.id);
    if (!p) return;
    if (m.type === 'download') p.onDownload(m);
    else if (m.type === 'status') log('[字幕] ' + m.text);
    else if (m.type === 'done') { pending.delete(m.id); p.resolve(m); }
    else if (m.type === 'error') { pending.delete(m.id); p.reject(new Error(m.message)); }
  };
  return worker;
}
export function stopWhisper() {
  if (worker) { worker.terminate(); worker = null; }
  for (const p of pending.values()) p.reject(new Error('已取消'));
  pending.clear();
}

const HALLU = [/請不吝點贊/, /订阅|訂閱.*轉發/, /明鏡與點點/, /字幕由.*提供/, /Amara\.org/i, /^(謝謝|谢谢)(大家)?(觀看|收看|观看)[。！!]?$/];

// 把很長的一句切成適合閱讀的短句（每句最多約 16 字），時間依字數分配
function splitCue(start, end, text, maxLen = 16) {
  const parts = text.split(/(?<=[，。！？、；,.!?;])/).map((x) => x.trim()).filter(Boolean);
  const groups = [];
  let cur = '';
  for (const p of parts) {
    if (cur && (cur + p).length > maxLen) { groups.push(cur); cur = p; } else cur += p;
  }
  if (cur) groups.push(cur);
  // 單一片段仍太長就硬切
  const final = [];
  for (const g of groups) {
    if (g.length <= maxLen * 1.6) { final.push(g); continue; }
    for (let i = 0; i < g.length; i += maxLen) final.push(g.slice(i, i + maxLen));
  }
  const clean = (s) => s.replace(/[，。、；,;]+$/u, '').replace(/[，、；]/g, ' ').replace(/。/g, ' ').trim();
  const total = final.reduce((s, g) => s + g.length, 0) || 1;
  let t = start;
  return final.map((g) => {
    const d = ((end - start) * g.length) / total;
    const cue = { start: t, end: t + d, text: clean(g) };
    t += d;
    return cue;
  }).filter((c) => c.text);
}

export function chunksToCues(chunks, total) {
  const conv = store.settings.subTrad ? OpenCC.Converter({ from: 'cn', to: 'twp' }) : (s) => s;
  const cues = [];
  chunks.forEach((c, i) => {
    let [a, b] = c.timestamp || [];
    if (a == null) return;
    if (b == null || b <= a) b = chunks[i + 1]?.timestamp?.[0] ?? Math.min(total, a + 5);
    b = Math.min(b, total);
    const text = conv((c.text || '').trim());
    if (!text || HALLU.some((r) => r.test(text))) return;
    const prev = cues[cues.length - 1];
    if (prev && prev.text === text && a - prev.end < 1) { prev.end = b; return; }
    cues.push({ start: a, end: b, text });
  });
  return cues.flatMap((c) => splitCue(c.start, c.end, c.text));
}

// 依照「剪好的時間軸」產生字幕
export async function autoSubtitles(onStatus) {
  const lay = layout();
  const total = totalDuration();
  if (!total) throw new Error('時間軸上還沒有影片');
  const srcs = lay.map((c) => store.sources.get(c.src));
  if (!srcs.some((s) => s?.hasAudio)) throw new Error('時間軸上的影片沒有聲音');

  onStatus('擷取聲音…', 0.02);
  const raw = await exclusive(() => withSources(srcs, async () => {
    const args = buildAudioArgs(lay, [], total, store.settings, 'asr', '/asr.raw');
    await ffRun(args, total, (p) => onStatus(`擷取聲音… ${Math.round(p * 100)}%`, 0.02 + p * 0.08));
    return ffTake('/asr.raw');
  }));
  const audio = new Float32Array(raw.buffer, raw.byteOffset, raw.byteLength / 4).slice();

  const files = {};
  const t0 = performance.now();
  const timer = setInterval(() => {
    const tot = Object.values(files).reduce((s, f) => s + f.total, 0);
    const ld = Object.values(files).reduce((s, f) => s + f.loaded, 0);
    if (tot && ld < tot * 0.999) return;
    onStatus(`語音辨識中…（已經過 ${Math.round((performance.now() - t0) / 1000)} 秒）`, 0.5);
  }, 1000);

  try {
    const id = ++reqId;
    const res = await new Promise((resolve, reject) => {
      pending.set(id, {
        resolve, reject,
        onDownload: (d) => {
          if (d.status === 'progress' && d.file) files[d.file] = { loaded: d.loaded || 0, total: d.total || 0 };
          const tot = Object.values(files).reduce((s, f) => s + f.total, 0);
          const ld = Object.values(files).reduce((s, f) => s + f.loaded, 0);
          if (tot && ld < tot) onStatus(`下載辨識模型（只有第一次需要）… ${(ld / 1e6).toFixed(0)} / ${(tot / 1e6).toFixed(0)} MB`, 0.1 + 0.35 * (ld / tot));
        },
      });
      getWorker().postMessage({ type: 'transcribe', id, audio, model: store.settings.subModel, language: store.settings.subLang || null }, [audio.buffer]);
    });
    log(`[字幕] 使用 ${res.device === 'webgpu' ? 'WebGPU' : 'CPU'}，耗時 ${Math.round((performance.now() - t0) / 1000)} 秒`);
    return chunksToCues(res.chunks || [], total).map((c) => ({ id: newId('u'), ...c }));
  } finally {
    clearInterval(timer);
  }
}

export function toSrt(subs) {
  return subs.map((c, i) => `${i + 1}\n${fmtSrt(c.start)} --> ${fmtSrt(c.end)}\n${c.text}\n`).join('\n');
}

export function parseSrt(text) {
  const cues = [];
  const blocks = text.replace(/\r/g, '').replace(/^﻿/, '').split(/\n\s*\n/);
  for (const b of blocks) {
    const lines = b.split('\n').filter((l) => l.trim() !== '');
    const ti = lines.findIndex((l) => l.includes('-->'));
    if (ti < 0) continue;
    const [a, z] = lines[ti].split('-->').map((x) => parseTime(x.trim().split(' ')[0]));
    if (isNaN(a) || isNaN(z)) continue;
    cues.push({ id: newId('u'), start: a, end: z, text: lines.slice(ti + 1).join('\n') });
  }
  return cues;
}
