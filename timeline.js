// 多軌時間軸：顯示、選取、拖曳移動、拉邊緣修剪、排序
import { store, layout, totalDuration, emit, reflow, sanitize, snapshot, pushUndo, LISTS, fmt } from './state.js';
import { seek, pause } from './preview.js';

let scroll, content, ruler, playhead, marker;
const tracks = {};
const xOf = (t) => t * store.zoom;
const tOf = (clientX) => (clientX - content.getBoundingClientRect().left) / store.zoom;

export function initTimeline() {
  scroll = document.getElementById('tlScroll');
  content = document.getElementById('tlContent');
  ruler = document.getElementById('ruler');
  playhead = document.getElementById('playhead');
  marker = document.getElementById('dropMarker');
  content.querySelectorAll('.track').forEach((el) => (tracks[el.dataset.track] = el));

  // 尺規和空白處：點一下跳到該時間，按住可以拖動播放頭
  const scrub = (e) => {
    if (store.playing) pause();
    seek(tOf(e.clientX));
    const move = (ev) => seek(tOf(ev.clientX));
    const up = () => { window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up); };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  };
  ruler.addEventListener('pointerdown', scrub);
  playhead.querySelector('.ph-head').addEventListener('pointerdown', scrub);
  Object.values(tracks).forEach((tr) => tr.addEventListener('pointerdown', (e) => {
    if (e.target !== tr) return;
    store.sel = null;
    emit('sel');
    scrub(e);
  }));

  // Ctrl + 滾輪縮放
  scroll.addEventListener('wheel', (e) => {
    if (!e.ctrlKey && !e.metaKey) return;
    e.preventDefault();
    const t = tOf(e.clientX);
    const before = e.clientX - scroll.getBoundingClientRect().left;
    setZoom(store.zoom * (e.deltaY < 0 ? 1.15 : 1 / 1.15));
    scroll.scrollLeft = xOf(t) - before;
  }, { passive: false });
  scroll.addEventListener('scroll', renderRuler);
  window.addEventListener('resize', render);
}

export function setZoom(z) {
  store.zoom = Math.max(2, Math.min(300, z));
  document.getElementById('zoom').value = store.zoom;
  render();
}
export function fitZoom() {
  const total = totalDuration();
  if (!total) return;
  setZoom((scroll.clientWidth - 40) / total);
  scroll.scrollLeft = 0;
}

export function render() {
  const total = totalDuration();
  const musicEnd = store.project.music.reduce((m, x) => Math.max(m, x.start + x.out - x.in), 0);
  const w = Math.max(scroll.clientWidth, xOf(Math.max(total, musicEnd) + 30));
  content.style.width = w + 'px';
  renderRuler();
  renderItems();
  updatePlayhead();
}

// 只畫看得到的刻度
function renderRuler() {
  const z = store.zoom;
  const steps = [0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300, 600, 1200];
  const step = steps.find((s) => s * z >= 80) || 1800;
  const minor = step / 5;
  const from = Math.max(0, Math.floor(scroll.scrollLeft / z / step) * step);
  const to = (scroll.scrollLeft + scroll.clientWidth) / z + step;
  let html = '';
  for (let t = from; t <= to; t += step) {
    html += `<div class="tick" style="left:${t * z}px"><span>${fmt(t, step < 1)}</span></div>`;
    if (minor * z >= 10) for (let k = 1; k < 5; k++) html += `<div class="tick minor" style="left:${(t + k * minor) * z}px"></div>`;
  }
  ruler.innerHTML = html;
}

export function updatePlayhead(follow = false) {
  const x = xOf(store.time);
  playhead.style.left = x + 'px';
  if (follow) {
    const v0 = scroll.scrollLeft, v1 = v0 + scroll.clientWidth;
    if (x > v1 - 40 || x < v0) scroll.scrollLeft = x - 60;
  }
}

function makeItem(type, it, left, width, label) {
  const d = document.createElement('div');
  d.className = `item ${type}` + (store.sel?.type === type && store.sel.id === it.id ? ' sel' : '');
  d.style.left = left + 'px';
  d.style.width = Math.max(4, width) + 'px';
  d.dataset.type = type;
  d.dataset.id = it.id;
  d.innerHTML = `<div class="h l"></div><span class="lbl"></span><div class="h r"></div>`;
  d.querySelector('.lbl').textContent = label;
  d.title = label;
  d.addEventListener('pointerdown', onItemDown);
  d.addEventListener('dblclick', () => emit('focus-text'));
  return d;
}

function renderItems() {
  for (const k in tracks) tracks[k].innerHTML = '';
  const z = store.zoom;
  for (const c of layout()) {
    const s = store.sources.get(c.src);
    const d = makeItem('clip', c, c.start * z, c.dur * z, (s?.name || '') + (c.volume === 0 ? '（靜音）' : ''));
    if (s?.thumb) d.style.backgroundImage = `url(${s.thumb})`;
    tracks.clip.appendChild(d);
  }
  for (const t of store.project.titles) tracks.title.appendChild(makeItem('title', t, t.start * z, (t.end - t.start) * z, 'T  ' + t.text));
  for (const u of store.project.subs) tracks.sub.appendChild(makeItem('sub', u, u.start * z, (u.end - u.start) * z, u.text));
  for (const m of store.project.music) {
    const s = store.sources.get(m.src);
    tracks.music.appendChild(makeItem('music', m, m.start * z, (m.out - m.in) * z, '♪ ' + (s?.name || '')));
  }
}

// ---------- 吸附 ----------
function snapPoints(excludeId) {
  const pts = [store.time, 0];
  for (const c of layout()) pts.push(c.start, c.end);
  for (const list of [store.project.subs, store.project.titles]) for (const x of list) if (x.id !== excludeId) pts.push(x.start, x.end);
  return pts;
}
function snap(t, pts) {
  const th = 7 / store.zoom;
  let best = t, bd = th;
  for (const p of pts) { const d = Math.abs(p - t); if (d < bd) { bd = d; best = p; } }
  return best;
}

// ---------- 拖曳 ----------
function onItemDown(e) {
  if (e.button !== 0) return;
  e.stopPropagation();
  const el = e.currentTarget;
  const type = el.dataset.type, id = el.dataset.id;
  const edge = e.target.classList.contains('l') ? 'l' : e.target.classList.contains('r') ? 'r' : null;
  if (store.playing) pause();
  store.sel = { type, id };
  emit('sel');

  const snap0 = snapshot();
  const x0 = e.clientX;
  const pts = snapPoints(id);
  let started = false;
  let reorderIdx = null;

  const apply = (dx) => {
    store.project = JSON.parse(snap0);
    const p = store.project;
    if (type === 'clip') {
      const idx = p.clips.findIndex((c) => c.id === id);
      const c0 = p.clips[idx];
      const s = store.sources.get(c0.src);
      const maxOut = s?.kind === 'image' ? 3600 : (s?.duration || c0.out);
      if (edge) {
        reflow((pp) => {
          const c = pp.clips[idx];
          if (edge === 'l') {
            if (s?.kind === 'image') c.out = Math.max(c.in + 0.1, c.out - dx);
            else c.in = Math.min(c.out - 0.1, Math.max(0, c.in + dx));
          } else c.out = Math.max(c.in + 0.1, Math.min(maxOut, c.out + dx));
        });
      } else {
        // 排序：找出放開時要插入的位置
        const lay = layout().filter((c) => c.id !== id);
        const me = layout().find((c) => c.id === id);
        const center = me.start + me.dur / 2 + dx;
        let pos = lay.findIndex((c) => center < c.start + c.dur / 2);
        if (pos < 0) pos = lay.length;
        reorderIdx = pos;
        const mx = pos < lay.length ? lay[pos].start : (lay.length ? lay[lay.length - 1].end : 0);
        marker.classList.remove('hidden');
        marker.style.left = xOf(mx) - 1 + 'px';
        marker.style.top = tracks.clip.offsetTop + 'px';
        marker.style.height = tracks.clip.offsetHeight + 'px';
      }
    } else {
      const it = p[LISTS[type]].find((x) => x.id === id);
      if (type === 'music') {
        const s = store.sources.get(it.src);
        if (edge === 'l') { const d = Math.max(-it.in, Math.min(it.out - it.in - 0.1, snap(it.start + dx, pts) - it.start)); it.in += d; it.start += d; }
        else if (edge === 'r') it.out = Math.max(it.in + 0.1, Math.min(s?.duration || it.out, it.out + dx));
        else it.start = Math.max(0, snap(it.start + dx, pts));
      } else {
        const len = it.end - it.start;
        if (edge === 'l') it.start = Math.min(it.end - 0.1, snap(it.start + dx, pts));
        else if (edge === 'r') it.end = Math.max(it.start + 0.1, snap(it.end + dx, pts));
        else {
          let ns = it.start + dx;
          const se = snap(ns + len, pts), ss = snap(ns, pts);
          if (ss !== ns) ns = ss; else if (se !== ns + len) ns = se - len;
          it.start = Math.max(0, ns); it.end = it.start + len;
        }
      }
    }
    sanitize();
  };

  const move = (ev) => {
    const dxPx = ev.clientX - x0;
    if (!started && Math.abs(dxPx) < 3) return;
    started = true;
    apply(dxPx / store.zoom);
    emit('live');
    if (type === 'clip' && !edge) {
      const d = content.querySelector(`.item[data-id="${id}"]`);
      if (d) { d.style.transform = `translateX(${dxPx}px)`; d.classList.add('dragging'); }
    }
  };
  const up = () => {
    window.removeEventListener('pointermove', move);
    window.removeEventListener('pointerup', up);
    marker.classList.add('hidden');
    if (!started) return;
    if (type === 'clip' && !edge) {
      store.project = JSON.parse(snap0);
      const from = store.project.clips.findIndex((c) => c.id === id);
      if (reorderIdx !== null && reorderIdx !== from) {
        reflow((p) => { const [c] = p.clips.splice(from, 1); p.clips.splice(reorderIdx, 0, c); });
      }
      sanitize();
    }
    pushUndo(snap0);
    emit('project');
  };
  window.addEventListener('pointermove', move);
  window.addEventListener('pointerup', up);
}

// 從素材庫拖到時間軸
export function dropTimeFromEvent(e) {
  const tr = e.target.closest?.('.track');
  return { track: tr?.dataset.track || null, t: Math.max(0, tOf(e.clientX)) };
}
