// 專案資料、復原／重做、時間軸版面計算
export const store = {
  sources: new Map(), // id -> 素材 {id, file, name, kind:'video'|'image'|'audio', duration, width, height, hasAudio, el, img, thumb}
  project: { clips: [], titles: [], subs: [], music: [] },
  settings: {
    resolution: 1080, quality: 23, fps: 30,
    denoise: false, denoiseLevel: 18, loudnorm: false,
    subSize: 5.5, subBurn: true, subTrad: true, subLang: 'chinese', subModel: 'medium',
    logoPos: 'tr', logoSize: 12, logoOpacity: 90,
  },
  logo: null, // {img, w, h, name}
  sel: null, // {type:'clip'|'title'|'sub'|'music', id}
  time: 0,
  playing: false,
  zoom: 40, // 每秒幾個像素
};

let uid = Date.now() % 100000;
export const newId = (p = 'x') => `${p}${(++uid).toString(36)}`;

// ---------- 事件 ----------
const listeners = new Set();
export function onChange(fn) { listeners.add(fn); }
export function emit(kind = 'project') { listeners.forEach((fn) => fn(kind)); }

// ---------- 復原／重做 ----------
const undoStack = [];
const redoStack = [];
const snap = () => JSON.stringify(store.project);

export function checkpoint() {
  undoStack.push(snap());
  if (undoStack.length > 200) undoStack.shift();
  redoStack.length = 0;
}
// 拖曳等連續操作：結束時才記一次（傳入開始前的快照）
export function pushUndo(snapshot) {
  if (snapshot === snap()) return false;
  undoStack.push(snapshot);
  if (undoStack.length > 200) undoStack.shift();
  redoStack.length = 0;
  return true;
}
export const snapshot = () => snap();

export function commit(fn) {
  checkpoint();
  fn(store.project);
  sanitize();
  emit();
}
export function undo() {
  if (!undoStack.length) return;
  redoStack.push(snap());
  store.project = JSON.parse(undoStack.pop());
  fixSelection();
  emit();
}
export function redo() {
  if (!redoStack.length) return;
  undoStack.push(snap());
  store.project = JSON.parse(redoStack.pop());
  fixSelection();
  emit();
}
export const canUndo = () => undoStack.length > 0;
export const canRedo = () => redoStack.length > 0;

function fixSelection() {
  if (store.sel && !findItem(store.sel.type, store.sel.id)) store.sel = null;
}

// ---------- 查詢 ----------
export const LISTS = { clip: 'clips', title: 'titles', sub: 'subs', music: 'music' };
export function findItem(type, id) {
  return store.project[LISTS[type]]?.find((x) => x.id === id) || null;
}

// 影片軌是「磁吸」排列：片段依序接在一起
export function layout(clips = store.project.clips) {
  let t = 0;
  return clips.map((c) => {
    const d = c.out - c.in;
    const r = { ...c, start: t, end: t + d, dur: d };
    t += d;
    return r;
  });
}
export function totalDuration() {
  const p = store.project;
  let t = p.clips.reduce((s, c) => s + (c.out - c.in), 0);
  return t;
}
export function clipAt(t, lay = layout()) {
  if (!lay.length) return null;
  for (const c of lay) if (t >= c.start && t < c.end) return c;
  return t >= lay[lay.length - 1].end - 1e-6 ? null : null;
}

// ---------- 剪輯動作（標題、字幕會跟著所屬的影片片段移動） ----------
// mutate 只改影片片段；字幕與標題依照原本所在片段的「素材時間」重新定位
export function reflow(mutate) {
  const p = store.project;
  const before = layout(p.clips);
  const anchor = (it) => {
    const mid = (it.start + it.end) / 2;
    const c = before.find((c) => mid >= c.start && mid < c.end);
    if (!c) return { it, free: true };
    return { it, clipId: c.id, src: c.src, s: it.start - c.start + c.in, e: it.end - c.start + c.in };
  };
  const anchored = [...p.titles.map(anchor), ...p.subs.map(anchor)];
  const oldTotal = before.length ? before[before.length - 1].end : 0;

  mutate(p);

  const after = layout(p.clips);
  const newTotal = after.length ? after[after.length - 1].end : 0;
  const keep = new Set();
  for (const a of anchored) {
    if (a.free) {
      // 不在任何片段上（例如超出影片尾端）：跟著總長度平移
      const shift = newTotal - oldTotal;
      if (a.it.start >= oldTotal - 1e-6) { a.it.start += shift; a.it.end += shift; }
      if (a.it.end > 0) keep.add(a.it);
      continue;
    }
    const mid = (a.s + a.e) / 2;
    let c = after.find((c) => c.id === a.clipId && mid >= c.in && mid < c.out);
    if (!c) c = after.find((c) => c.src === a.src && mid >= c.in && mid < c.out);
    if (!c) continue; // 所在的段落被刪掉了
    a.it.start = Math.max(c.start, c.start + (a.s - c.in));
    a.it.end = Math.min(c.end, c.start + (a.e - c.in));
    if (a.it.end - a.it.start > 0.05) keep.add(a.it);
  }
  p.titles = p.titles.filter((x) => keep.has(x));
  p.subs = p.subs.filter((x) => keep.has(x));
}

export function sanitize() {
  const p = store.project;
  for (const c of p.clips) {
    c.in = Math.max(0, c.in);
    if (c.out - c.in < 0.1) c.out = c.in + 0.1;
  }
  for (const list of [p.titles, p.subs]) {
    for (const x of list) {
      x.start = Math.max(0, x.start);
      if (x.end - x.start < 0.1) x.end = x.start + 0.1;
    }
    list.sort((a, b) => a.start - b.start);
  }
  for (const m of p.music) { m.start = Math.max(0, m.start); m.in = Math.max(0, m.in); if (m.out - m.in < 0.1) m.out = m.in + 0.1; }
}

// ---------- 輸出尺寸 ----------
export const even = (n) => Math.max(2, Math.round(n / 2) * 2);
export function outputSize(resolution = store.settings.resolution) {
  const first = store.project.clips.map((c) => store.sources.get(c.src)).find((s) => s && s.width);
  let w = first?.width || 1920, h = first?.height || 1080;
  const short = Math.min(w, h);
  if (resolution && short > resolution) { const k = resolution / short; w *= k; h *= k; }
  return { W: even(w), H: even(h) };
}

// ---------- 時間格式 ----------
export function fmt(t, withMs = true) {
  t = Math.max(0, t || 0);
  const m = Math.floor(t / 60), s = Math.floor(t % 60), d = Math.floor((t * 10) % 10);
  const h = Math.floor(m / 60);
  const mm = String(m % 60).padStart(2, '0'), ss = String(s).padStart(2, '0');
  return (h ? h + ':' : '') + mm + ':' + ss + (withMs ? '.' + d : '');
}
export function fmtSrt(t) {
  const ms = Math.round(Math.max(0, t) * 1000);
  const p = (n, l = 2) => String(n).padStart(l, '0');
  return `${p(Math.floor(ms / 3600000))}:${p(Math.floor(ms / 60000) % 60)}:${p(Math.floor(ms / 1000) % 60)},${p(ms % 1000, 3)}`;
}
export function parseTime(str) {
  const t = String(str).trim().replace(',', '.');
  if (!t) return NaN;
  const parts = t.split(':').map(Number);
  if (parts.some(isNaN)) return NaN;
  return parts.reduce((a, v) => a * 60 + v, 0);
}
