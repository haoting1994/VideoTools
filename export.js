// 匯出：聲音用 ffmpeg 混音，畫面用 WebCodecs（硬體加速）逐格合成
import * as MB from '../vendor/mediabunny.min.mjs';
import { store, layout, totalDuration, outputSize } from './state.js';
import { exclusive, withSources, buildAudioArgs, ffRun, ffTake, log } from './media.js';
import { drawOverlays } from './compose.js';

let cancelled = false;
export function cancelExport() { cancelled = true; }

export async function exportVideo({ resolution, quality, burnSubs }, onStatus) {
  cancelled = false;
  const lay = layout();
  const total = totalDuration();
  if (!total) throw new Error('時間軸上還沒有影片');
  if (typeof VideoEncoder === 'undefined') throw new Error('這個瀏覽器不支援影片編碼，請使用最新版 Chrome 或 Edge');
  const { W, H } = outputSize(resolution);
  const fps = store.settings.fps;
  const music = store.project.music;

  // ---- 1. 聲音 ----
  onStatus('處理聲音…', 0);
  const srcs = [...lay.map((c) => store.sources.get(c.src)), ...music.map((m) => store.sources.get(m.src))].filter(Boolean);
  const audioBytes = await exclusive(() => withSources(srcs, async () => {
    const args = buildAudioArgs(lay, music, total, store.settings, 'export', '/mix.m4a');
    await ffRun(args, total, (p) => onStatus(`處理聲音… ${Math.round(p * 100)}%`, p * 0.1));
    return ffTake('/mix.m4a');
  }));
  if (cancelled) throw new Error('已取消');

  // ---- 2. 輸出檔 ----
  const target = new MB.BufferTarget();
  const output = new MB.Output({ format: new MB.Mp4OutputFormat({ fastStart: 'in-memory' }), target });
  const canvas = new OffscreenCanvas(W, H);
  const ctx = canvas.getContext('2d', { alpha: false });
  const base1080 = { 18: 14e6, 20: 10e6, 23: 6e6, 27: 3.5e6 }[quality] || 6e6;
  const bitrate = Math.round(base1080 * Math.pow((W * H) / (1920 * 1080), 0.75));
  const videoSrc = new MB.CanvasSource(canvas, {
    codec: 'avc',
    bitrate: new MB.Quality({ quantizer: quality, bitrate, bitrateMode: 'variable' }),
    keyFrameInterval: 2,
  });
  output.addVideoTrack(videoSrc, { frameRate: fps });

  const audioIn = new MB.Input({ source: new MB.BlobSource(new Blob([audioBytes])), formats: MB.ALL_FORMATS });
  const aTrack = await audioIn.getPrimaryAudioTrack();
  const audioSrc = new MB.EncodedAudioPacketSource(aTrack.codec);
  output.addAudioTrack(audioSrc);
  await output.start();

  const aIter = new MB.EncodedPacketSink(aTrack).packets()[Symbol.asyncIterator]();
  const aCfg = await aTrack.getDecoderConfig();
  let aFirst = true, aDone = false, aNext = null;
  async function pumpAudio(upTo) {
    while (!aDone) {
      if (!aNext) { const r = await aIter.next(); if (r.done) { aDone = true; break; } aNext = r.value; }
      if (aNext.timestamp > upTo) break;
      await audioSrc.add(aNext, aFirst ? { decoderConfig: aCfg } : undefined);
      aFirst = false;
      aNext = null;
    }
  }

  // ---- 3. 畫面：逐格解碼、合成、編碼 ----
  const totalFrames = Math.max(1, Math.round(total * fps));
  const inputs = new Map();
  const getInput = (s) => {
    if (!inputs.has(s.id)) inputs.set(s.id, new MB.Input({ source: new MB.BlobSource(s.file), formats: MB.ALL_FORMATS }));
    return inputs.get(s.id);
  };
  let frame = 0;
  const t0 = performance.now();

  const finishFrame = async (t) => {
    drawOverlays(ctx, W, H, t, { subs: burnSubs });
    await videoSrc.add(frame / fps, 1 / fps);
    frame++;
    if (frame % 15 === 0) {
      await pumpAudio(frame / fps);
      const el = (performance.now() - t0) / 1000;
      const left = el / frame * (totalFrames - frame);
      onStatus(`輸出畫面… ${Math.round((frame / totalFrames) * 100)}%（約剩 ${Math.ceil(left)} 秒）`, 0.1 + 0.88 * (frame / totalFrames));
    }
    if (cancelled) throw new Error('已取消');
  };

  for (const c of lay) {
    const s = store.sources.get(c.src);
    const endFrame = Math.min(totalFrames, Math.round(c.end * fps));
    const startFrame = frame;
    if (endFrame <= startFrame) continue;

    if (s.kind === 'image') {
      while (frame < endFrame) {
        ctx.fillStyle = '#000'; ctx.fillRect(0, 0, W, H);
        const k = Math.min(W / s.width, H / s.height);
        ctx.drawImage(s.img, (W - s.width * k) / 2, (H - s.height * k) / 2, s.width * k, s.height * k);
        await finishFrame(frame / fps);
      }
      continue;
    }

    const vt = await getInput(s).getPrimaryVideoTrack();
    const sink = new MB.VideoSampleSink(vt);
    const times = [];
    for (let f = startFrame; f < endFrame; f++) times.push(c.in + (f / fps - c.start));
    for await (const sample of sink.samplesAtTimestamps(times)) {
      ctx.fillStyle = '#000'; ctx.fillRect(0, 0, W, H);
      if (sample) {
        sample.drawWithFit(ctx, { fit: 'contain' });
        sample.close();
      }
      await finishFrame(frame / fps);
    }
  }

  await pumpAudio(Infinity);
  onStatus('寫入檔案…', 0.99);
  await output.finalize();
  for (const i of inputs.values()) i.dispose?.();
  audioIn.dispose?.();
  log(`[匯出] ${W}x${H} ${totalFrames} 格，耗時 ${Math.round((performance.now() - t0) / 1000)} 秒`);
  return new Blob([target.buffer], { type: 'video/mp4' });
}
