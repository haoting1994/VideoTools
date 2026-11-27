import { store, onChange, emit, commit, checkpoint, undo, redo, canUndo, canRedo, layout, totalDuration, reflow, sanitize, findItem, LISTS, newId, fmt, parseTime, outputSize } from './state.js';
import { initFFmpeg, ffReady, ffmpeg, importFile, kindOf, getLog } from './media.js';
import { initPreview, refresh as refreshPreview, draw, play, pause, toggle, seek, resize as resizePreview } from './preview.js';
import { initTimeline, render as renderTimeline, updatePlayhead, setZoom, fitZoom, dropTimeFromEvent } from './timeline.js';
import { autoSubtitles, toSrt, parseSrt, stopWhisper } from './subtitles.js';
import { exportVideo, cancelExport } from './export.js';

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// ---------- 引擎 ----------
function startEngine() {
  const pill = $('engine');
  pill.textContent = '引擎載入中…'; pill.className = 'pill';
  return initFFmpeg().then(() => { pill.textContent = '引擎就緒'; pill.className = 'pill ready'; })
    .catch((e) => { pill.textContent = '引擎載入失敗'; pill.className = 'pill err'; console.error(e); });
}
startEngine();
initPreview($('canvas'));
initTimeline();

// ---------- 小工具 ----------
let toastTimer;
function toast(msg, ms = 2600) {
  const t = $('toast');
  t.textContent = msg;
  t.classList.remove('hidden');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.add('hidden'), ms);
}

let busyCancel = null;
function busy(title, cancelFn) {
  $('busyTitle').textContent = title;
  $('busyText').textContent = '準備中…';
  $('busyBar').style.width = '0%';
  $('busy').classList.remove('hidden');
  busyCancel = cancelFn;
  $('busyCancel').classList.toggle('hidden', !cancelFn);
  return (text, p) => { $('busyText').textContent = text; if (p != null) $('busyBar').style.width = Math.round(p * 100) + '%'; };
}
function unbusy() { $('busy').classList.add('hidden'); busyCancel = null; }
$('busyCancel').onclick = () => busyCancel?.();

function hardCancel() {
  cancelExport();
  stopWhisper();
  try { ffmpeg.terminate(); } catch {}
  startEngine();
}

// ---------- 匯入 ----------
async function importFiles(files, at = null) {
  const list = [...files];
  if (!list.length) return;
  await ffReady?.catch(() => {});
  const wasEmpty = !store.project.clips.length;
  const set = busy('匯入素材');
  try {
    for (let i = 0; i < list.length; i++) {
      const f = list[i];
      set(`讀取 ${f.name}（${i + 1}/${list.length}）`, i / list.length);
      let s;
      try {
        s = await importFile(f, (msg) => set(msg));
      } catch (e) {
        toast(`無法匯入 ${f.name}：${e.message || e}`, 5000);
        continue;
      }
      if (s.converted) toast(`${f.name} 的格式已自動轉成 MP4 方便剪輯`);
      addToTimeline(s, at);
      if (at && at.track === 'clip') at = null;
    }
  } finally {
    unbusy();
  }
  emit('sources');
  if (wasEmpty && store.project.clips.length) { fitZoom(); seek(0); }
}

function addToTimeline(s, at) {
  commit((p) => {
    if (s.kind === 'audio') {
      const start = at?.track === 'music' ? at.t : (p.clips.length ? store.time : 0);
      p.music.push({ id: newId('m'), src: s.id, start, in: 0, out: s.duration, volume: 0.5, fade: true });
      return;
    }
    const clip = { id: newId('c'), src: s.id, in: 0, out: s.duration, volume: 1 };
    if (at?.track === 'clip') {
      const lay = layout(p.clips);
      let idx = lay.findIndex((c) => at.t < c.start + c.dur / 2);
      if (idx < 0) idx = p.clips.length;
      reflow((pp) => pp.clips.splice(idx, 0, clip));
    } else p.clips.push(clip);
  });
}

$('importBtn').onclick = () => $('fileInput').click();
$('binDrop').onclick = () => $('fileInput').click();
$('fileInput').onchange = (e) => { importFiles(e.target.files); e.target.value = ''; };

// 拖放檔案：整個視窗都可以
let dragDepth = 0;
window.addEventListener('dragenter', (e) => { if (e.dataTransfer.types.includes('Files')) { dragDepth++; $('stage').classList.add('over'); } });
window.addEventListener('dragleave', () => { if (--dragDepth <= 0) { dragDepth = 0; $('stage').classList.remove('over'); } });
window.addEventListener('dragover', (e) => e.preventDefault());
window.addEventListener('drop', (e) => {
  e.preventDefault();
  dragDepth = 0;
  $('stage').classList.remove('over');
  const at = dropTimeFromEvent(e);
  const srcId = e.dataTransfer.getData('text/x-source');
  if (srcId) {
    const s = store.sources.get(srcId);
    if (s) addToTimeline(s, at.track ? at : null);
    return;
  }
  if (e.dataTransfer.files.length) importFiles(e.dataTransfer.files, at.track ? at : null);
});

// ---------- 素材庫 ----------
function renderBin() {
  const box = $('binList');
  box.innerHTML = '';
  for (const s of store.sources.values()) {
    const d = document.createElement('div');
    d.className = 'bin-item';
    d.draggable = true;
    const icon = s.kind === 'audio' ? '♪' : s.kind === 'image' ? '' : '';
    d.innerHTML = `<div class="th" style="${s.thumb ? `background-image:url(${s.thumb})` : ''}">${icon}</div>
      <div><div class="nm">${esc(s.name)}</div><div class="meta">${s.kind === 'image' ? '圖片' : fmt(s.duration, false)}${s.width ? '・' + s.width + '×' + s.height : ''}</div></div>`;
    d.title = '拖到時間軸，或點兩下加到最後面';
    d.addEventListener('dragstart', (e) => e.dataTransfer.setData('text/x-source', s.id));
    d.addEventListener('dblclick', () => addToTimeline(s, null));
    box.appendChild(d);
  }
}

// ---------- 播放控制 ----------
$('playBtn').onclick = toggle;
$('toStart').onclick = () => seek(0);
$('toEnd').onclick = () => seek(totalDuration());
$('stepBack').onclick = () => { pause(); seek(store.time - 1 / store.settings.fps); };
$('stepFwd').onclick = () => { pause(); seek(store.time + 1 / store.settings.fps); };

// ---------- 剪輯動作 ----------
function split() {
  const t = store.time;
  const c = layout().find((c) => t > c.start + 0.05 && t < c.end - 0.05);
  if (!c) return toast('播放頭要放在影片片段上才能分割');
  commit(() => reflow((p) => {
    const i = p.clips.findIndex((x) => x.id === c.id);
    const cut = c.in + (t - c.start);
    const right = { ...p.clips[i], id: newId('c'), in: cut };
    p.clips[i].out = cut;
    p.clips.splice(i + 1, 0, right);
    store.sel = { type: 'clip', id: right.id };
  }));
}

function del() {
  const sel = store.sel;
  if (!sel) return toast('先在時間軸上點選要刪除的項目');
  commit((p) => {
    if (sel.type === 'clip') reflow((pp) => { pp.clips = pp.clips.filter((c) => c.id !== sel.id); });
    else p[LISTS[sel.type]] = p[LISTS[sel.type]].filter((x) => x.id !== sel.id);
  });
  store.sel = null;
  seek(store.time);
  emit('sel');
}

function addTitle() {
  if (!totalDuration()) return toast('先匯入影片');
  const id = newId('t');
  commit((p) => p.titles.push({ id, start: store.time, end: Math.min(totalDuration(), store.time + 3) || store.time + 3, text: '輸入標題', size: 8, color: '#ffffff', x: 0.5, y: 0.18 }));
  store.sel = { type: 'title', id };
  emit('sel');
  focusText();
}

function addSub() {
  if (!totalDuration()) return toast('先匯入影片');
  const id = newId('u');
  const next = store.project.subs.find((s) => s.start > store.time);
  const end = Math.min(store.time + 2.5, next ? next.start : Infinity, totalDuration());
  commit((p) => p.subs.push({ id, start: store.time, end: Math.max(end, store.time + 0.5), text: '' }));
  store.sel = { type: 'sub', id };
  emit('sel');
  focusText();
}

function focusText() {
  setTab('props');
  setTimeout(() => { const t = $('tab-props').querySelector('textarea'); if (t) { t.focus(); t.select(); } }, 30);
}

$('splitBtn').onclick = split;
$('delBtn').onclick = del;
$('addTitleBtn').onclick = addTitle;
$('addSubBtn').onclick = addSub;
$('undoBtn').onclick = undo;
$('redoBtn').onclick = redo;
$('zoom').oninput = (e) => setZoom(+e.target.value);
$('fitBtn').onclick = fitZoom;

// ---------- 自動字幕 ----------
async function runAutoSubs() {
  if (!totalDuration()) return toast('先匯入影片');
  if (store.project.subs.length && !confirm('會用新的字幕取代目前所有字幕，確定嗎？')) return;
  if (store.playing) pause();
  const set = busy('自動產生字幕', () => { hardCancel(); unbusy(); toast('已取消'); });
  try {
    const cues = await autoSubtitles(set);
    commit((p) => { p.subs = cues; });
    setTab('subs');
    toast(cues.length ? `產生了 ${cues.length} 句字幕，可以在「字幕清單」直接修改` : '沒有辨識到語音');
  } catch (e) {
    if (!/取消/.test(e.message)) alert('字幕產生失敗：' + (e.message || e));
    console.error(e);
  } finally {
    unbusy();
  }
}
$('autoSubBtn').onclick = runAutoSubs;
$('autoSubBtn2').onclick = runAutoSubs;
$('importSrtBtn').onclick = () => $('srtInput').click();
$('srtInput').onchange = async (e) => {
  const f = e.target.files[0];
  e.target.value = '';
  if (!f) return;
  const cues = parseSrt(await f.text());
  if (!cues.length) return toast('這個 SRT 檔裡沒有字幕');
  commit((p) => { p.subs = cues; });
  toast(`匯入了 ${cues.length} 句字幕`);
};
$('exportSrtBtn').onclick = () => {
  if (!store.project.subs.length) return toast('目前沒有字幕');
  download(new Blob(['﻿' + toSrt(store.project.subs)], { type: 'application/x-subrip' }), baseName() + '.srt');
};

function download(blob, name) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 60000);
}
function baseName() {
  const c = store.project.clips[0];
  const s = c && store.sources.get(c.src);
  return (s?.name || '影片').replace(/\.[^.]+$/, '') + '_剪輯';
}

// ---------- 屬性面板 ----------
function setTab(name) {
  document.querySelectorAll('.tabs button').forEach((b) => b.classList.toggle('on', b.dataset.tab === name));
  ['props', 'subs', 'settings'].forEach((n) => $('tab-' + n).classList.toggle('hidden', n !== name));
  if (name === 'subs') renderSubList();
}
document.querySelectorAll('.tabs button').forEach((b) => (b.onclick = () => setTab(b.dataset.tab)));

// 文字、滑桿等連續修改：第一次修改時記錄復原點，之後只即時更新
function live(el, ev, fn) {
  let armed = true;
  el.addEventListener('focus', () => (armed = true));
  el.addEventListener('pointerdown', () => (armed = true));
  el.addEventListener(ev, () => {
    if (armed) { checkpoint(); armed = false; }
    fn(el);
    sanitize();
    emit('live');
  });
  el.addEventListener('change', () => (armed = true));
}

function timeInputs(it, box) {
  const wrap = document.createElement('div');
  wrap.className = 'two';
  wrap.innerHTML = `<label class="field">開始<input type="text" data-k="start" value="${fmt(it.start)}"></label>
    <label class="field">結束<input type="text" data-k="end" value="${fmt(it.end)}"></label>`;
  wrap.querySelectorAll('input').forEach((inp) => inp.addEventListener('change', () => {
    const v = parseTime(inp.value);
    if (isNaN(v)) { inp.value = fmt(it[inp.dataset.k]); return; }
    commit(() => { const x = findItem(store.sel.type, it.id); if (x) x[inp.dataset.k] = v; });
  }));
  box.appendChild(wrap);
}

function renderProps() {
  const box = $('tab-props');
  const sel = store.sel;
  const it = sel && findItem(sel.type, sel.id);
  box.innerHTML = '';
  if (!it) {
    box.innerHTML = `<div class="empty-props">
      在時間軸上點選片段、標題、字幕或音樂，這裡會顯示可以調整的項目。<br><br>
      <b>常用快捷鍵</b><br>
      空白鍵　播放／暫停<br>S　在播放頭分割<br>Delete　刪除選取項目<br>T　加標題<br>← →　上一格／下一格（按住 Shift 跳 1 秒）<br>Ctrl+Z　復原<br>Ctrl+滾輪　縮放時間軸</div>`;
    return;
  }
  const head = (name, color) => `<div class="prop-title"><span class="dot" style="background:${color}"></span>${name}</div>`;

  if (sel.type === 'clip') {
    const s = store.sources.get(it.src);
    const c = layout().find((c) => c.id === it.id);
    box.innerHTML = head('影片片段', 'var(--c-clip)') + `
      <div class="muted small" style="margin-bottom:10px">${esc(s?.name || '')}<br>
      時間軸 ${fmt(c.start)} – ${fmt(c.end)}（${c.dur.toFixed(1)} 秒）<br>
      ${s?.kind === 'image' ? '圖片' : `素材 ${fmt(it.in)} – ${fmt(it.out)}`}</div>
      ${s?.kind === 'image' ? `<label class="field">顯示秒數<input type="number" id="pDur" min="0.5" step="0.5" value="${(it.out - it.in).toFixed(1)}"></label>` : `
      <label class="field">音量 <output id="pVolOut">${Math.round((it.volume ?? 1) * 100)}%</output><input type="range" id="pVol" min="0" max="200" step="5" value="${Math.round((it.volume ?? 1) * 100)}"></label>
      <p class="muted small">超過 100% 的部分匯出時才會套用。</p>`}
      <button class="btn small danger" id="pDel">刪除這個片段</button>`;
    if ($('pVol')) live($('pVol'), 'input', (el) => { findItem('clip', it.id).volume = el.value / 100; $('pVolOut').textContent = el.value + '%'; });
    if ($('pDur')) $('pDur').addEventListener('change', (e) => { const v = Math.max(0.5, +e.target.value || 5); commit(() => reflow((p) => { const x = p.clips.find((c) => c.id === it.id); x.out = x.in + v; })); });
  }

  if (sel.type === 'title') {
    box.innerHTML = head('文字標題', 'var(--c-title)') + `
      <label class="field">文字<textarea id="pText">${esc(it.text)}</textarea></label>
      <label class="field">大小 <output id="pSizeOut">${it.size}</output><input type="range" id="pSize" min="3" max="20" step="0.5" value="${it.size}"></label>
      <label class="field">顏色<div class="row gap"><input type="color" id="pColor" value="${it.color}">
        ${['#ffffff', '#ffd43b', '#ff6b6b', '#4dabf7', '#000000'].map((c) => `<button class="btn small swatch" data-c="${c}" style="background:${c};width:26px;height:26px;padding:0"></button>`).join('')}</div></label>
      <label class="field">位置<div class="seg" id="pPos"><button data-y="0.15">上</button><button data-y="0.5">中</button><button data-y="0.85">下</button></div></label>
      <label class="field">左右 <input type="range" id="pX" min="0.05" max="0.95" step="0.01" value="${it.x}"></label>
      <label class="field">上下 <input type="range" id="pY" min="0.05" max="0.95" step="0.01" value="${it.y}"></label>`;
    timeInputs(it, box);
    box.insertAdjacentHTML('beforeend', `<button class="btn small danger" id="pDel">刪除標題</button>`);
    const get = () => findItem('title', it.id);
    live($('pText'), 'input', (el) => { get().text = el.value; });
    live($('pSize'), 'input', (el) => { get().size = +el.value; $('pSizeOut').textContent = el.value; });
    live($('pColor'), 'input', (el) => { get().color = el.value; });
    live($('pX'), 'input', (el) => { get().x = +el.value; });
    live($('pY'), 'input', (el) => { get().y = +el.value; });
    box.querySelectorAll('.swatch').forEach((b) => (b.onclick = () => commit(() => { get().color = b.dataset.c; })));
    box.querySelectorAll('#pPos button').forEach((b) => (b.onclick = () => commit(() => { get().y = +b.dataset.y; })));
  }

  if (sel.type === 'sub') {
    box.innerHTML = head('字幕', 'var(--c-sub)') + `<label class="field">文字<textarea id="pText">${esc(it.text)}</textarea></label>`;
    timeInputs(it, box);
    box.insertAdjacentHTML('beforeend', `<button class="btn small danger" id="pDel">刪除這句字幕</button>
      <p class="muted small">所有字幕可以在「字幕清單」一次修改。</p>`);
    live($('pText'), 'input', (el) => { findItem('sub', it.id).text = el.value; });
  }

  if (sel.type === 'music') {
    const s = store.sources.get(it.src);
    box.innerHTML = head('音樂', 'var(--c-music)') + `
      <div class="muted small" style="margin-bottom:10px">${esc(s?.name || '')}<br>從 ${fmt(it.start)} 開始，長度 ${(it.out - it.in).toFixed(1)} 秒</div>
      <label class="field">音量 <output id="pVolOut">${Math.round((it.volume ?? 0.5) * 100)}%</output><input type="range" id="pVol" min="0" max="150" step="5" value="${Math.round((it.volume ?? 0.5) * 100)}"></label>
      <label class="check"><input type="checkbox" id="pFade" ${it.fade ? 'checked' : ''}> 開頭淡入、結尾淡出</label>
      <button class="btn small danger" id="pDel">刪除音樂</button>`;
    live($('pVol'), 'input', (el) => { findItem('music', it.id).volume = el.value / 100; $('pVolOut').textContent = el.value + '%'; });
    $('pFade').onchange = (e) => commit(() => { findItem('music', it.id).fade = e.target.checked; });
  }
  $('pDel')?.addEventListener('click', del);
}

// ---------- 字幕清單 ----------
function renderSubList() {
  const box = $('subList');
  if ($('tab-subs').classList.contains('hidden')) return;
  box.innerHTML = '';
  if (!store.project.subs.length) {
    box.innerHTML = `<p class="muted small">還沒有字幕。按「自動產生字幕」，或匯入現有的 SRT 檔。<br><br>建議先剪好影片再產生字幕。之後再剪，字幕也會跟著所在的片段移動。</p>`;
    return;
  }
  for (const u of store.project.subs) {
    const row = document.createElement('div');
    row.className = 'sub-row';
    row.dataset.id = u.id;
    row.innerHTML = `<div class="t">${fmt(u.start)}</div><textarea rows="1"></textarea>`;
    const ta = row.querySelector('textarea');
    ta.value = u.text;
    row.querySelector('.t').onclick = () => { pause(); seek(u.start + 0.01); store.sel = { type: 'sub', id: u.id }; emit('sel'); };
    ta.addEventListener('focus', () => { if (!store.playing) seek(u.start + 0.01); store.sel = { type: 'sub', id: u.id }; renderTimeline(); });
    live(ta, 'input', (el) => { const x = findItem('sub', u.id); if (x) x.text = el.value; });
    box.appendChild(row);
  }
  highlightSub();
}
function highlightSub() {
  const cur = store.project.subs.find((s) => store.time >= s.start && store.time < s.end);
  $('subList').querySelectorAll('.sub-row').forEach((r) => {
    const on = cur && r.dataset.id === cur.id;
    if (on !== r.classList.contains('on')) {
      r.classList.toggle('on', on);
      if (on && store.playing) r.scrollIntoView({ block: 'nearest' });
    }
  });
}

// ---------- 設定 ----------
const S = store.settings;
function bindSetting(id, key, kind = 'value', after) {
  const el = $(id);
  if (kind === 'checked') el.checked = S[key]; else el.value = S[key];
  el.addEventListener(kind === 'checked' ? 'change' : 'input', () => {
    S[key] = kind === 'checked' ? el.checked : (el.type === 'range' || /level/i.test(key) ? +el.value : el.value);
    after?.();
    saveSettings();
    draw();
  });
}
function saveSettings() { try { localStorage.setItem('editor-settings', JSON.stringify(S)); } catch {} }
try { Object.assign(S, JSON.parse(localStorage.getItem('editor-settings') || '{}')); } catch {}
const outs = () => {
  $('logoSizeOut').textContent = S.logoSize + '%';
  $('logoOpacityOut').textContent = S.logoOpacity + '%';
  $('subSizeOut').textContent = S.subSize;
};
bindSetting('logoPos', 'logoPos');
bindSetting('logoSize', 'logoSize', 'value', outs);
bindSetting('logoOpacity', 'logoOpacity', 'value', outs);
bindSetting('denoise', 'denoise', 'checked');
bindSetting('denoiseLevel', 'denoiseLevel');
bindSetting('loudnorm', 'loudnorm', 'checked');
bindSetting('subSize', 'subSize', 'value', outs);
bindSetting('subLang', 'subLang');
bindSetting('subModel', 'subModel');
bindSetting('subTrad', 'subTrad', 'checked');
outs();

$('logoBtn').onclick = () => $('logoInput').click();
$('logoInput').onchange = async (e) => {
  const f = e.target.files[0];
  e.target.value = '';
  if (!f) return;
  const img = await createImageBitmap(f);
  store.logo = { img, w: img.width, h: img.height, name: f.name };
  $('logoName').textContent = f.name;
  $('logoClear').classList.remove('hidden');
  draw();
};
$('logoClear').onclick = () => { store.logo = null; $('logoName').textContent = ''; $('logoClear').classList.add('hidden'); draw(); };

// ---------- 匯出 ----------
$('exportBtn').onclick = () => {
  if (!totalDuration()) return;
  pause();
  $('exName').value = baseName();
  const { W, H } = outputSize(0);
  $('exRes').value = Math.min(W, H) > 1080 ? '1080' : '0';
  $('exQuality').value = String(S.quality);
  $('exSubs').parentElement.classList.toggle('hidden', !store.project.subs.length);
  $('exResult').innerHTML = '';
  $('exGo').disabled = false;
  $('exportDlg').classList.remove('hidden');
};
$('exClose').onclick = () => $('exportDlg').classList.add('hidden');
$('exGo').onclick = async () => {
  const name = ($('exName').value.trim() || baseName()).replace(/[\\/:*?"<>|]/g, '_');
  const opts = { resolution: +$('exRes').value, quality: +$('exQuality').value, burnSubs: $('exSubs').value === 'burn' };
  S.quality = opts.quality; saveSettings();
  $('exportDlg').classList.add('hidden');
  const set = busy('匯出影片', () => { hardCancel(); });
  const t0 = performance.now();
  try {
    const blob = await exportVideo(opts, set);
    const res = $('exResult');
    res.innerHTML = '';
    const add = (b, fn, note) => {
      const url = URL.createObjectURL(b);
      res.insertAdjacentHTML('beforeend', `<div class="result"><span>${esc(fn)}</span><span class="muted small">${(b.size / 1e6).toFixed(1)} MB${note ? '・' + note : ''}</span><span class="sp"></span><a href="${url}" download="${esc(fn)}">下載</a></div>`);
    };
    add(blob, name + '.mp4', `${Math.round((performance.now() - t0) / 1000)} 秒完成`);
    if (store.project.subs.length) add(new Blob(['﻿' + toSrt(store.project.subs)], { type: 'application/x-subrip' }), name + '.srt', '字幕檔');
    $('exGo').disabled = true;
    $('exportDlg').classList.remove('hidden');
    res.querySelector('a')?.click();
  } catch (e) {
    if (!/取消/.test(e.message)) alert('匯出失敗：' + (e.message || e));
    console.error(e);
  } finally {
    unbusy();
  }
};

// ---------- 鍵盤 ----------
// 勾選框、選單、滑桿改完就放掉焦點，讓空白鍵等快捷鍵繼續有效
document.addEventListener('change', (e) => {
  const t = e.target;
  if (t.matches('input[type=checkbox], input[type=range], input[type=color], select')) t.blur();
});
window.addEventListener('keydown', (e) => {
  const tag = e.target.tagName;
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') {
    if (e.key === 'Escape') e.target.blur();
    return;
  }
  const mod = e.ctrlKey || e.metaKey;
  if (mod && e.key.toLowerCase() === 'z') { e.preventDefault(); e.shiftKey ? redo() : undo(); return; }
  if (mod && e.key.toLowerCase() === 'y') { e.preventDefault(); redo(); return; }
  if (mod) return;
  const fps = store.settings.fps;
  switch (e.key) {
    case ' ': e.preventDefault(); toggle(); break;
    case 's': case 'S': split(); break;
    case 't': case 'T': addTitle(); break;
    case 'Delete': case 'Backspace': e.preventDefault(); del(); break;
    case 'ArrowLeft': e.preventDefault(); pause(); seek(store.time - (e.shiftKey ? 1 : 1 / fps)); break;
    case 'ArrowRight': e.preventDefault(); pause(); seek(store.time + (e.shiftKey ? 1 : 1 / fps)); break;
    case 'Home': seek(0); break;
    case 'End': seek(totalDuration()); break;
    case 'Escape': store.sel = null; emit('sel'); break;
  }
});

// ---------- 畫面更新 ----------
function updateChrome() {
  const total = totalDuration();
  $('tcTotal').textContent = fmt(total);
  $('emptyHint').classList.toggle('hidden', total > 0);
  $('exportBtn').disabled = !total;
  $('undoBtn').disabled = !canUndo();
  $('redoBtn').disabled = !canRedo();
}
let lastSubRender = 0;
onChange((kind) => {
  if (kind === 'time') {
    $('tcNow').textContent = fmt(store.time);
    updatePlayhead(store.playing);
    highlightSub();
    return;
  }
  if (kind === 'play') { $('playBtn').textContent = store.playing ? '❚❚' : '▶'; return; }
  if (kind === 'sources') { renderBin(); refreshPreview(); return; }
  if (kind === 'focus-text') { focusText(); return; }
  renderTimeline();
  updateChrome();
  if (kind === 'live') { refreshPreview(); return; }
  if (kind === 'sel') { renderProps(); return; }
  // project
  refreshPreview();
  renderProps();
  renderSubList();
});
emit('project');

// ---------- PWA ----------
if ('serviceWorker' in navigator && location.protocol !== 'file:' && !/^(localhost|127\.0\.0\.1)$/.test(location.hostname)) {
  navigator.serviceWorker.register('./sw.js').catch(() => {});
}
let installPrompt = null;
window.addEventListener('beforeinstallprompt', (e) => { e.preventDefault(); installPrompt = e; $('installBtn').classList.remove('hidden'); });
$('installBtn').onclick = async () => { if (!installPrompt) return; installPrompt.prompt(); await installPrompt.userChoice; installPrompt = null; $('installBtn').classList.add('hidden'); };
window.addEventListener('beforeunload', (e) => { if (store.project.clips.length) { e.preventDefault(); e.returnValue = ''; } });

window.__editor = { store, importFiles, split, del, addTitle, addSub, emit, seek, getLog };
