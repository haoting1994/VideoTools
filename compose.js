// 畫面合成：預覽和匯出共用同一套畫法，所見即所得
import { store } from './state.js';

const FONT = '"Noto Sans TC", "PingFang TC", "Microsoft JhengHei", "Heiti TC", sans-serif';

// 中英文混排的自動換行
function wrap(ctx, text, maxW) {
  const out = [];
  for (const para of String(text).split('\n')) {
    let line = '';
    for (const ch of para) {
      const test = line + ch;
      if (line && ctx.measureText(test).width > maxW) { out.push(line); line = ch.trim() ? ch : ''; }
      else line = test;
    }
    out.push(line);
  }
  return out;
}

function outlinedText(ctx, lines, x, y, size, color, lineH, align = 'center') {
  ctx.textAlign = align;
  ctx.textBaseline = 'middle';
  ctx.lineJoin = 'round';
  ctx.lineWidth = Math.max(2, size * 0.16);
  ctx.strokeStyle = 'rgba(0,0,0,0.85)';
  ctx.fillStyle = color;
  const top = y - ((lines.length - 1) * lineH) / 2;
  lines.forEach((l, i) => {
    ctx.strokeText(l, x, top + i * lineH);
    ctx.fillText(l, x, top + i * lineH);
  });
}

export function drawFrameSource(ctx, W, H, src, srcW, srcH) {
  if (!src || !srcW || !srcH) return;
  const k = Math.min(W / srcW, H / srcH);
  const dw = srcW * k, dh = srcH * k;
  ctx.drawImage(src, (W - dw) / 2, (H - dh) / 2, dw, dh);
}

export function drawOverlays(ctx, W, H, t, opts = {}) {
  const p = store.project;
  const st = store.settings;

  // 文字標題
  for (const ti of p.titles) {
    if (t < ti.start || t >= ti.end) continue;
    const size = Math.round(H * (ti.size || 8) / 100);
    ctx.font = `700 ${size}px ${FONT}`;
    const lines = wrap(ctx, ti.text || '', W * 0.9);
    outlinedText(ctx, lines, W * (ti.x ?? 0.5), H * (ti.y ?? 0.2), size, ti.color || '#ffffff', size * 1.25);
  }

  // LOGO
  const lg = store.logo;
  if (lg) {
    const lw = W * st.logoSize / 100, lh = lw * lg.h / lg.w, m = W * 0.03;
    const pos = st.logoPos;
    ctx.globalAlpha = st.logoOpacity / 100;
    ctx.drawImage(lg.img, pos.includes('l') ? m : W - lw - m, pos.includes('t') ? m : H - lh - m, lw, lh);
    ctx.globalAlpha = 1;
  }

  // 字幕
  if (opts.subs !== false) {
    const cue = p.subs.find((s) => t >= s.start && t < s.end);
    if (cue && cue.text) {
      const size = Math.round(H * st.subSize / 100);
      ctx.font = `600 ${size}px ${FONT}`;
      const lines = wrap(ctx, cue.text, W * 0.88);
      const lineH = size * 1.3;
      const y = H - H * 0.07 - ((lines.length - 1) * lineH) / 2 - size / 2;
      outlinedText(ctx, lines, W / 2, y, size, '#ffffff', lineH);
    }
  }
}
