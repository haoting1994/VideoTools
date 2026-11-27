// 素材匯入、ffmpeg 引擎、聲音處理
import { FFmpeg } from '../vendor/ffmpeg/index.js';
import { toBlobURL } from '../vendor/util/index.js';

const CORE_CDN = 'https://cdn.jsdelivr.net/npm/@ffmpeg/core@0.12.10/dist/esm';
import * as MB from '../vendor/mediabunny.min.mjs';
import { store, newId } from './state.js';

const root = new URL('..', import.meta.url).href;

// ---------- 紀錄 ----------
const logLines = [];
export function log(msg) {
  logLines.push(msg);
  if (logLines.length > 3000) logLines.splice(0, 1000);
}
export const getLog = () => logLines.join('\n');
window.__editorLog = getLog;

// ---------- ffmpeg ----------
export let ffmpeg = null;
export let ffReady = null;
let timeHook = null;

export function initFFmpeg() {
  ffmpeg = new FFmpeg();
  ffmpeg.on('log', ({ message }) => {
    log(message);
    if (timeHook) {
      const m = message.match(/time=\s*(\d+):(\d+):(\d+(?:\.\d+)?)/);
      if (m) timeHook(+m[1] * 3600 + +m[2] * 60 + +m[3]);
    }
  });
  // 引擎核心（32MB）從 CDN 載入：GitHub 網頁上傳單檔上限 25MB，放不進 repository
  ffReady = (async () => {
    const coreURL = await toBlobURL(`${CORE_CDN}/ffmpeg-core.js`, 'text/javascript');
    const wasmURL = await toBlobURL(`${CORE_CDN}/ffmpeg-core.wasm`, 'application/wasm');
    await ffmpeg.load({ coreURL, wasmURL });
  })();
  return ffReady;
}

// ffmpeg 一次只能做一件事
let lock = Promise.resolve();
export function exclusive(fn) {
  const p = lock.then(fn);
  lock = p.catch(() => {});
  return p;
}

export async function ffRun(args, dur, onPct) {
  await ffReady;
  timeHook = (t) => onPct && dur && onPct(Math.min(1, t / dur));
  log('$ ffmpeg ' + args.join(' '));
  const code = await ffmpeg.exec(args);
  timeHook = null;
  if (code !== 0) throw new Error(`ffmpeg 執行失敗（代碼 ${code}）`);
}

export async function ffTake(path) {
  const data = await ffmpeg.readFile(path);
  await ffmpeg.deleteFile(path).catch(() => {});
  return data;
}

const extOf = (n) => { const i = n.lastIndexOf('.'); return i > 0 ? n.slice(i + 1).toLowerCase() : ''; };
const srcName = (s) => `${s.id}.${extOf(s.file.name) || 'bin'}`;
export const srcPath = (s) => '/src/' + srcName(s);

// 把素材檔「掛載」進 ffmpeg（不複製進記憶體）
export async function withSources(list, fn) {
  await ffReady;
  try { await ffmpeg.createDir('/src'); } catch {}
  const files = [...new Map(list.map((s) => [s.id, s])).values()].map((s) => new File([s.file], srcName(s)));
  await ffmpeg.mount('WORKERFS', { files }, '/src');
  try {
    return await fn();
  } finally {
    await ffmpeg.unmount('/src').catch(() => {});
  }
}

// ---------- 匯入素材 ----------
const IMAGE_EXT = ['png', 'jpg', 'jpeg', 'webp', 'gif', 'bmp'];
const AUDIO_EXT = ['mp3', 'wav', 'm4a', 'aac', 'flac', 'ogg', 'opus'];

export function kindOf(file) {
  const e = extOf(file.name);
  if (file.type.startsWith('image/') || IMAGE_EXT.includes(e)) return 'image';
  if (file.type.startsWith('audio/') || AUDIO_EXT.includes(e)) return 'audio';
  return 'video';
}

function waitMedia(el, okFn, ms = 10000) {
  return new Promise((res) => {
    let done = false;
    const fin = (ok) => { if (done) return; done = true; clearTimeout(tm); res(ok); };
    const tm = setTimeout(() => fin(false), ms);
    el.addEventListener('loadeddata', () => fin(okFn()), { once: true });
    el.addEventListener('error', () => fin(false), { once: true });
  });
}

async function probeMB(file) {
  try {
    const input = new MB.Input({ source: new MB.BlobSource(file), formats: MB.ALL_FORMATS });
    const vt = await input.getPrimaryVideoTrack();
    const at = await input.getPrimaryAudioTrack();
    const r = {
      ok: true,
      hasVideo: !!vt,
      hasAudio: !!at,
      canDecode: vt ? await vt.canDecode() : false,
      width: vt?.displayWidth || 0,
      height: vt?.displayHeight || 0,
      duration: await input.computeDuration(),
    };
    input.dispose?.();
    return r;
  } catch (e) {
    return { ok: false, error: e.message || String(e) };
  }
}

async function makeThumb(drawable, w, h) {
  const tw = 160, th = Math.max(2, Math.round((tw * h) / w));
  const c = document.createElement('canvas');
  c.width = tw; c.height = th;
  c.getContext('2d').drawImage(drawable, 0, 0, tw, th);
  return c.toDataURL('image/jpeg', 0.7);
}

// 瀏覽器不能直接剪的格式（例如 AVI、部分 MKV、HEVC），先轉成 H.264 MP4
async function makeProxy(file, kind, onStatus) {
  return exclusive(async () => {
    await ffReady;
    const tmp = { id: 'proxy', file };
    return withSources([tmp], async () => {
      // 先讀長度，才能顯示進度
      let dur = 0;
      const hook = ({ message }) => { const m = message.match(/Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/); if (m) dur = +m[1] * 3600 + +m[2] * 60 + +m[3]; };
      ffmpeg.on('log', hook);
      await ffmpeg.exec(['-hide_banner', '-i', srcPath(tmp)]).catch(() => {});
      ffmpeg.off('log', hook);
      const out = kind === 'audio' ? '/proxy.m4a' : '/proxy.mp4';
      const args = ['-hide_banner', '-i', srcPath(tmp)];
      if (kind === 'audio') args.push('-vn', '-c:a', 'aac', '-b:a', '192k', out);
      else args.push('-map', '0:v:0', '-map', '0:a:0?', '-vf', "scale='if(gt(iw,ih),-2,min(1080,iw))':'if(gt(iw,ih),min(1080,ih),-2)',format=yuv420p",
        '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20', '-c:a', 'aac', '-b:a', '192k', '-movflags', '+faststart', out);
      await ffRun(args, dur, (p) => onStatus?.(`轉換格式中（這個格式需要先轉檔）… ${Math.round(p * 100)}%`));
      const data = await ffTake(out);
      const base = file.name.replace(/\.[^.]+$/, '');
      return new File([data.buffer], base + (kind === 'audio' ? '.m4a' : '.mp4'), { type: kind === 'audio' ? 'audio/mp4' : 'video/mp4' });
    });
  });
}

export async function importFile(file, onStatus) {
  const kind = kindOf(file);
  const s = { id: newId('s'), file, name: file.name, kind, duration: 0, width: 0, height: 0, hasAudio: false, el: null, img: null, thumb: '' };

  if (kind === 'image') {
    s.img = await createImageBitmap(file);
    s.width = s.img.width; s.height = s.img.height; s.duration = 5;
    s.thumb = await makeThumb(s.img, s.width, s.height);
    store.sources.set(s.id, s);
    return s;
  }

  const attach = async (f) => {
    s.file = f;
    const url = URL.createObjectURL(f);
    const el = document.createElement(kind === 'audio' ? 'audio' : 'video');
    el.preload = 'auto';
    el.playsInline = true;
    el.crossOrigin = 'anonymous';
    el.src = url;
    const elOk = await waitMedia(el, () => (kind === 'audio' ? el.duration > 0 : el.videoWidth > 0));
    const mb = await probeMB(f);
    return { el, elOk, mb };
  };

  onStatus?.(`讀取 ${file.name}…`);
  let { el, elOk, mb } = await attach(file);
  const good = kind === 'audio' ? elOk : elOk && mb.ok && mb.hasVideo && mb.canDecode;
  if (!good) {
    log(`[匯入] ${file.name} 需要轉檔：預覽=${elOk} 解析=${mb.ok} 解碼=${mb.canDecode} ${mb.error || ''}`);
    const proxy = await makeProxy(file, kind, onStatus);
    ({ el, elOk, mb } = await attach(proxy));
    if (!elOk) throw new Error(`無法讀取 ${file.name}`);
    s.converted = true;
  }
  s.el = el;
  s.duration = (mb.ok && mb.duration) || el.duration || 0;
  s.hasAudio = mb.ok ? mb.hasAudio : true;
  if (kind === 'video') {
    s.width = mb.width || el.videoWidth;
    s.height = mb.height || el.videoHeight;
    // 縮圖
    await new Promise((r) => { el.addEventListener('seeked', r, { once: true }); el.currentTime = Math.min(1, s.duration / 3); setTimeout(r, 3000); });
    try { s.thumb = await makeThumb(el, el.videoWidth, el.videoHeight); } catch {}
  }
  store.sources.set(s.id, s);
  return s;
}

// ---------- 聲音：用 ffmpeg 依照時間軸把各段聲音接起來、混入配樂 ----------
// mode: 'export'（48kHz 立體聲 AAC） 或 'asr'（16kHz 單聲道，給語音辨識）
export function buildAudioArgs(lay, music, total, settings, mode, outPath) {
  const args = ['-hide_banner'];
  const filters = [];
  let idx = 0;
  const norm = 'aresample=48000,aformat=sample_fmts=fltp:channel_layouts=stereo';
  const labels = [];

  lay.forEach((c, i) => {
    const s = store.sources.get(c.src);
    const d = c.dur.toFixed(4);
    const vol = c.volume ?? 1;
    if (s && s.kind === 'video' && s.hasAudio && vol > 0) {
      args.push('-ss', c.in.toFixed(4), '-t', (c.dur + 0.5).toFixed(4), '-i', srcPath(s));
      filters.push(`[${idx}:a:0]${norm},apad,atrim=0:${d},asetpts=N/SR/TB,volume=${vol.toFixed(2)},afade=t=in:d=0.012,afade=t=out:st=${Math.max(0, c.dur - 0.012).toFixed(4)}:d=0.012[c${i}]`);
      idx++;
    } else {
      filters.push(`anullsrc=r=48000:cl=stereo,atrim=0:${d},asetpts=N/SR/TB,aformat=sample_fmts=fltp:channel_layouts=stereo[c${i}]`);
    }
    labels.push(`[c${i}]`);
  });
  filters.push(`${labels.join('')}concat=n=${labels.length}:v=0:a=1[dia0]`);

  let dia = '[dia0]';
  if (settings.denoise) {
    filters.push(`${dia}highpass=f=70,afftdn=nr=${settings.denoiseLevel}:nf=-30:tn=1[dia1]`);
    dia = '[dia1]';
  }

  const musicLabels = [];
  if (mode === 'export') {
    music.forEach((m, j) => {
      const s = store.sources.get(m.src);
      if (!s || m.start >= total) return;
      const len = Math.min(m.out - m.in, total - m.start);
      if (len <= 0.05) return;
      args.push('-ss', m.in.toFixed(4), '-t', (len + 0.5).toFixed(4), '-i', srcPath(s));
      const ms = Math.round(m.start * 1000);
      const fade = m.fade ? `,afade=t=in:d=1,afade=t=out:st=${Math.max(0, len - 1.5).toFixed(3)}:d=1.5` : '';
      filters.push(`[${idx}:a:0]${norm},apad,atrim=0:${len.toFixed(4)},asetpts=N/SR/TB,volume=${(m.volume ?? 0.5).toFixed(2)}${fade},adelay=delays=${ms}:all=1[m${j}]`);
      musicLabels.push(`[m${j}]`);
      idx++;
    });
  }

  let mix = dia;
  if (musicLabels.length) {
    filters.push(`${dia}${musicLabels.join('')}amix=inputs=${1 + musicLabels.length}:duration=first:dropout_transition=0:normalize=0[mix]`);
    mix = '[mix]';
  }

  if (mode === 'export') {
    let chain = settings.loudnorm ? 'loudnorm=I=-14:TP=-1.5:LRA=11,aresample=48000' : 'anull';
    filters.push(`${mix}${chain}[out]`);
    args.push('-filter_complex', filters.join(';'), '-map', '[out]', '-c:a', 'aac', '-b:a', '192k', '-ac', '2', outPath);
  } else {
    filters.push(`${mix}aresample=16000,aformat=sample_fmts=flt:channel_layouts=mono[out]`);
    args.push('-filter_complex', filters.join(';'), '-map', '[out]', '-f', 'f32le', '-c:a', 'pcm_f32le', outPath);
  }
  return args;
}
