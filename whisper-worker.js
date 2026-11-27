// 語音辨識（Whisper）背景執行緒：模型從 Hugging Face 下載後存在瀏覽器快取，之後不用再下載
import { pipeline, env } from 'https://cdn.jsdelivr.net/npm/@huggingface/transformers@4.3.2';

env.allowLocalModels = false;

// 每個模型在 WebGPU（顯示卡）與 CPU 下使用的量化版本
const MODELS = {
  base: { id: 'onnx-community/whisper-base', webgpu: { encoder_model: 'q4', decoder_model_merged: 'q4' }, wasm: 'q8' },
  small: { id: 'onnx-community/whisper-small', webgpu: { encoder_model: 'q4', decoder_model_merged: 'q4' }, wasm: 'q8' },
  // 與電腦版 ggml-medium.bin 相同的 OpenAI Whisper medium 權重，轉成瀏覽器可用的 ONNX 格式
  medium: { id: 'onnx-community/whisper-medium-ONNX', webgpu: { encoder_model: 'q4', decoder_model_merged: 'q4' }, wasm: 'q8' },
  turbo: { id: 'onnx-community/whisper-large-v3-turbo', webgpu: { encoder_model: 'q4', decoder_model_merged: 'q4' }, wasm: null },
};

let current = { key: null, asr: null, device: null };

async function hasWebGPU() {
  try {
    if (!self.navigator?.gpu) return false;
    return !!(await navigator.gpu.requestAdapter());
  } catch {
    return false;
  }
}

async function load(key, id) {
  if (current.key === key && current.asr) return current;
  const cfg = MODELS[key];
  if (!cfg) throw new Error('未知的模型：' + key);
  const progress_callback = (p) => self.postMessage({ type: 'download', id, ...p });

  let asr = null, device = null;
  if (await hasWebGPU()) {
    try {
      post(id, '使用顯示卡（WebGPU）載入模型');
      asr = await pipeline('automatic-speech-recognition', cfg.id, { device: 'webgpu', dtype: cfg.webgpu, progress_callback });
      device = 'webgpu';
    } catch (e) {
      post(id, 'WebGPU 載入失敗，改用 CPU：' + (e.message || e));
    }
  }
  if (!asr) {
    if (!cfg.wasm) throw new Error('這台電腦的瀏覽器不支援 WebGPU，無法使用「最準確」模型，請改選「標準」模型');
    post(id, '使用 CPU 載入模型');
    asr = await pipeline('automatic-speech-recognition', cfg.id, { device: 'wasm', dtype: cfg.wasm, progress_callback });
    device = 'wasm';
  }
  if (current.asr?.dispose) { try { await current.asr.dispose(); } catch {} }
  current = { key, asr, device };
  return current;
}

function post(id, text) {
  self.postMessage({ type: 'status', id, text });
}

self.onmessage = async (e) => {
  const { type, id, audio, model, language } = e.data;
  if (type !== 'transcribe') return;
  try {
    const { asr, device } = await load(model, id);
    post(id, `開始辨識，音訊長度 ${(audio.length / 16000).toFixed(1)} 秒`);
    const opts = { task: 'transcribe', chunk_length_s: 30, stride_length_s: 5, return_timestamps: true };
    if (language) opts.language = language;
    const out = await asr(audio, opts);
    self.postMessage({ type: 'done', id, device, text: out.text, chunks: out.chunks || [] });
  } catch (err) {
    let message = err?.message || String(err);
    if (/fetch|network|load/i.test(message)) message = '無法下載辨識模型，請確認網路連線（需要能連到 huggingface.co）。原始訊息：' + message;
    self.postMessage({ type: 'error', id, message });
  }
};
