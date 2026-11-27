// 預覽播放：以時鐘為主，影片元素跟著時鐘走；畫面畫在 canvas 上，疊上標題、字幕、LOGO
import { store, layout, totalDuration, outputSize, emit } from './state.js';
import { drawFrameSource, drawOverlays } from './compose.js';

let canvas, ctx, raf = 0, last = 0;
let lay = [];
const musicEls = new Map(); // music.id -> <audio>

export function initPreview(cv) {
  canvas = cv;
  ctx = canvas.getContext('2d');
  resize();
}

export function resize() {
  const { W, H } = outputSize();
  // 預覽用較小的解析度，節省效能
  const k = Math.min(1, 1280 / Math.max(W, H));
  const w = Math.round(W * k), h = Math.round(H * k);
  if (canvas.width !== w || canvas.height !== h) { canvas.width = w; canvas.height = h; }
  draw();
}

export function refresh() {
  lay = layout();
  syncMusicElements();
  resize();
  if (!store.playing) seek(Math.min(store.time, totalDuration()));
}

function current(t = store.time) {
  return lay.find((c) => t >= c.start && t < c.end) || null;
}

// 每個素材準備兩個播放器，相鄰的片段輪流用，下一段可以先跳到位
function elOf(c) {
  const s = store.sources.get(c.src);
  if (!s || s.kind !== 'video') return null;
  const i = lay.indexOf(c);
  if (i % 2 === 0) return s.el;
  if (!s.el2) {
    s.el2 = document.createElement('video');
    s.el2.preload = 'auto';
    s.el2.playsInline = true;
    s.el2.src = s.el.src;
  }
  return s.el2;
}
function allEls() {
  const out = [];
  for (const s of store.sources.values()) if (s.kind === 'video') { out.push(s.el); if (s.el2) out.push(s.el2); }
  // 暫停時，影片跳轉完成就重畫一次
  for (const el of out) if (!el.__hooked) { el.__hooked = true; el.addEventListener('seeked', () => { if (!store.playing) draw(); }); }
  return out;
}
function preloadNext(c) {
  const i = lay.indexOf(c);
  const n = lay[i + 1];
  if (!n) return;
  const el = elOf(n);
  if (!el || el === elOf(c) || !el.paused || el.seeking) return;
  if (Math.abs(el.currentTime - n.in) > 0.05) el.currentTime = n.in;
}

function syncMusicElements() {
  const ids = new Set(store.project.music.map((m) => m.id));
  for (const [id, el] of musicEls) if (!ids.has(id)) { el.pause(); el.src = ''; musicEls.delete(id); }
  for (const m of store.project.music) {
    if (musicEls.has(m.id)) continue;
    const s = store.sources.get(m.src);
    if (!s) continue;
    const el = new Audio(s.el.src);
    el.preload = 'auto';
    musicEls.set(m.id, el);
  }
}

function pauseAll(except) {
  for (const el of allEls()) if (el !== except && !el.paused) el.pause();
}

// 讓影片元素對上時間軸時間；回傳畫面是否已就緒
function syncVideo(t, playing) {
  const c = current(t);
  const el = c && elOf(c);
  if (!el) { pauseAll(null); return true; }
  pauseAll(el);
  if (playing) preloadNext(c);
  const target = c.in + (t - c.start);
  el.volume = Math.min(1, c.volume ?? 1);
  el.muted = (c.volume ?? 1) === 0;
  if (playing) {
    if (Math.abs(el.currentTime - target) > 0.3) el.currentTime = target;
    if (el.paused) el.play().catch(() => {});
  } else {
    if (!el.paused) el.pause();
    if (Math.abs(el.currentTime - target) > 0.02) el.currentTime = target;
  }
  return !el.seeking && el.readyState >= 2;
}

function syncMusic(t, playing) {
  for (const m of store.project.music) {
    const el = musicEls.get(m.id);
    if (!el) continue;
    const len = m.out - m.in;
    const active = playing && t >= m.start && t < m.start + len;
    if (!active) { if (!el.paused) el.pause(); continue; }
    let v = m.volume ?? 0.5;
    if (m.fade) {
      const rel = t - m.start;
      v *= Math.min(1, rel / 1, (len - rel) / 1.5);
    }
    el.volume = Math.max(0, Math.min(1, v));
    const target = m.in + (t - m.start);
    if (Math.abs(el.currentTime - target) > 0.3) el.currentTime = target;
    if (el.paused) el.play().catch(() => {});
  }
}

export function draw() {
  if (!ctx) return;
  const W = canvas.width, H = canvas.height;
  ctx.fillStyle = '#000';
  ctx.fillRect(0, 0, W, H);
  const c = current();
  const s = c && store.sources.get(c.src);
  if (s) {
    const el = elOf(c);
    if (s.kind === 'image') drawFrameSource(ctx, W, H, s.img, s.width, s.height);
    else if (el && el.readyState >= 2) drawFrameSource(ctx, W, H, el, el.videoWidth, el.videoHeight);
  }
  drawOverlays(ctx, W, H, store.time);
}

function loop(now) {
  const total = totalDuration();
  const dt = Math.min(0.1, (now - last) / 1000);
  last = now;
  const c = current();
  const s = c && store.sources.get(c.src);
  if (s && s.kind === 'video') {
    // 以影片本身的播放進度當時鐘，畫面最順
    const el = elOf(c);
    if (!el.paused && !el.seeking && el.readyState >= 2) {
      const t = c.start + (el.currentTime - c.in);
      if (t > store.time - 0.05) store.time = Math.min(Math.max(store.time, t), c.end);
      if (el.currentTime >= c.out - 0.02 || el.ended) store.time = c.end; // 進入下一段
    }
  } else {
    store.time += dt; // 圖片或空白：用時鐘
  }
  if (store.time >= total) { store.time = total; pause(); emit('time'); draw(); return; }
  syncVideo(store.time, true);
  syncMusic(store.time, true);
  draw();
  emit('time');
  raf = requestAnimationFrame(loop);
}

export function play() {
  const total = totalDuration();
  if (!total) return;
  if (store.time >= total - 0.05) store.time = 0;
  store.playing = true;
  last = performance.now();
  syncVideo(store.time, true);
  raf = requestAnimationFrame(loop);
  emit('play');
}

export function pause() {
  store.playing = false;
  cancelAnimationFrame(raf);
  pauseAll(null);
  for (const el of musicEls.values()) el.pause();
  emit('play');
}

export function toggle() { store.playing ? pause() : play(); }

let seekDrawPending = false;
export function seek(t) {
  store.time = Math.max(0, Math.min(totalDuration(), t));
  if (store.playing) { syncVideo(store.time, true); syncMusic(store.time, true); }
  else {
    syncVideo(store.time, false);
    const c = current();
    const el = c && elOf(c);
    if (el && !seekDrawPending) {
      seekDrawPending = true;
      el.addEventListener('seeked', () => { seekDrawPending = false; draw(); }, { once: true });
      setTimeout(() => { seekDrawPending = false; draw(); }, 400);
    }
  }
  draw();
  emit('time');
}
