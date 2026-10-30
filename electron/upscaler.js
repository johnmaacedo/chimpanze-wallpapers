'use strict';
// GPU upscaling with Real-ESRGAN (ncnn + Vulkan, runs on the RTX) followed by a
// Lanczos3 resample to the exact target (e.g. 3840×2160 "cover").
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const os = require('os');
const tools = require('./tools');
const library = require('./library');

const MODELS = {
  'realesrgan-x4plus-anime': { label: 'Real-ESRGAN Anime (ilustração/anime)', kind: 'anime' },
  'digital-art-4x': { label: 'Digital Art (arte digital, traço limpo)', kind: 'art' },
  'ultrasharp-4x': { label: '4x-UltraSharp (foto, máximo detalhe)', kind: 'photo' },
  'high-fidelity-4x': { label: 'High Fidelity (foto, natural)', kind: 'photo' },
  'remacri-4x': { label: 'Remacri (foto, textura suave)', kind: 'photo' },
  'realesrgan-x4plus': { label: 'Real-ESRGAN x4plus (geral)', kind: 'photo' },
};

const TARGETS = {
  '4k': { width: 3840, height: 2160 },
  '5k': { width: 5120, height: 2880 },
  '8k': { width: 7680, height: 4320 },
};

/**
 * Heuristic content classifier: anime/illustration images have large flat
 * regions and a limited palette; photos have noise/texture everywhere.
 */
async function classify(file) {
  const sharp = require('./img');
  const { data, info } = await sharp(file, { limitInputPixels: false })
    .rotate().resize(256, 256, { fit: 'fill' }).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  const w = info.width; const h = info.height; const c = info.channels;
  let flat = 0; let strong = 0; let total = 0;
  const colors = new Set();
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      const i = (y * w + x) * c;
      let g = 0;
      for (let k = 0; k < 3; k++) {
        g += Math.abs(data[i + k] - data[i + c + k]) + Math.abs(data[i + k] - data[i + w * c + k]);
      }
      if (g < 9) flat++;
      if (g > 120) strong++;
      total++;
      colors.add(((data[i] >> 3) << 10) | ((data[i + 1] >> 3) << 5) | (data[i + 2] >> 3));
    }
  }
  const flatRatio = flat / total;
  const strongRatio = strong / total;
  const colorRatio = colors.size / total;
  let score = 0;
  score += Math.min(1, flatRatio / 0.45) * 0.6;
  score += (colorRatio < 0.1 ? 0.25 : colorRatio < 0.2 ? 0.12 : 0);
  score += (strongRatio > 0.02 && strongRatio < 0.18 ? 0.15 : 0);
  const kind = score >= 0.55 ? 'anime' : 'photo';
  return { kind, score: Number(score.toFixed(2)), flatRatio, colorRatio, strongRatio };
}

function chooseModel(kind, settings) {
  if (kind === 'anime') return settings.animeModel || 'realesrgan-x4plus-anime';
  if (kind === 'art') return settings.artModel || 'digital-art-4x';
  return settings.photoModel || 'ultrasharp-4x';
}

function computeTarget(meta, target, monitors) {
  if (target === 'x2' || target === 'x4') {
    const f = target === 'x2' ? 2 : 4;
    return { width: Math.round(meta.width * f), height: Math.round(meta.height * f), factor: f };
  }
  let t = TARGETS[target];
  if (target === 'monitor') {
    const biggest = (monitors || []).reduce((a, m) => (m.rect.width * m.rect.height > a.width * a.height ? m.rect : a), { width: 3840, height: 2160 });
    t = { width: Math.max(biggest.width, biggest.height), height: Math.min(biggest.width, biggest.height) };
  }
  if (!t) t = TARGETS['4k'];
  // Orientation-aware: portrait images target a portrait 4K canvas.
  const portrait = meta.height > meta.width;
  const tw = portrait ? Math.min(t.width, t.height) : Math.max(t.width, t.height);
  const th = portrait ? Math.max(t.width, t.height) : Math.min(t.width, t.height);
  // "Cover": scale so the image fills the whole target screen.
  const factor = Math.max(tw / meta.width, th / meta.height);
  return { width: Math.round(meta.width * factor), height: Math.round(meta.height * factor), factor };
}

/**
 * Upscales one image. Returns { output, model, kind, width, height, skipped }.
 * ctx: { progress(p, stage), onCancel(fn), checkCanceled() }
 */
async function upscaleImage(file, settings, ctx, { monitors, outputDir } = {}) {
  const sharp = require('./img');
  const exe = tools.upscalerExe();
  if (!fs.existsSync(exe)) throw new Error('O upscaler de GPU não foi encontrado na instalação.');
  const metaRaw = await sharp(file, { limitInputPixels: false }).metadata();
  const rotated = metaRaw.orientation && metaRaw.orientation >= 5;
  const meta = { width: rotated ? metaRaw.height : metaRaw.width, height: rotated ? metaRaw.width : metaRaw.height };
  const target = computeTarget(meta, settings.target || '4k', monitors);

  let kind = settings.mode && settings.mode !== 'auto' ? settings.mode : null;
  let detected = null;
  if (!kind) {
    ctx.stage('Analisando a imagem…');
    detected = await classify(file);
    kind = detected.kind;
  }
  const model = settings.model || chooseModel(kind, settings);

  const outDir = outputDir || path.join(path.dirname(file), library.UPSCALE_DIR);
  await fsp.mkdir(outDir, { recursive: true });
  const ext = settings.format === 'jpg' ? '.jpg' : settings.format === 'webp' ? '.webp' : '.png';
  const output = path.join(outDir, path.parse(file).name + ext);

  if (settings.skipIfLarger !== false && target.factor <= 1.0001) {
    return { output: null, skipped: true, reason: 'A imagem já tem a resolução alvo ou maior.', kind, model, width: meta.width, height: meta.height, detected };
  }

  const tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'cw-up-'));
  try {
    // Normalise input (orientation, alpha, exotic formats) to PNG for the ncnn tool.
    ctx.stage('Preparando…');
    const inPng = path.join(tmpDir, 'in.png');
    await sharp(file, { limitInputPixels: false }).rotate().png({ compressionLevel: 1 }).toFile(inPng);
    ctx.checkCanceled();

    // Very large inputs: pre-shrink so the 4x pass lands near 2× the target
    // (keeps VRAM/time sane while still super-sampling the final resample).
    let passIn = inPng;
    const maxPre = Math.max(target.width, target.height) / 2;
    if (Math.max(meta.width, meta.height) > maxPre * 1.15 && target.factor < 2) {
      const pre = path.join(tmpDir, 'pre.png');
      await sharp(inPng, { limitInputPixels: false })
        .resize(Math.round(maxPre), Math.round(maxPre), { fit: 'inside', kernel: 'lanczos3' })
        .png({ compressionLevel: 1 }).toFile(pre);
      passIn = pre;
    }

    const passOut = path.join(tmpDir, 'out.png');
    const args = ['-i', passIn, '-o', passOut, '-n', model, '-s', '4', '-m', tools.upscalerModels(), '-f', 'png'];
    if (settings.gpu && settings.gpu !== 'auto') args.push('-g', String(settings.gpu));
    if (settings.tta) args.push('-x');
    ctx.progress(0.02, `Upscaling na GPU (${MODELS[model] ? MODELS[model].label : model})…`);
    const proc = tools.run(exe, args, {
      cwd: path.dirname(exe),
      onLine: (l) => {
        const m = /([\d.]+)%/.exec(l);
        if (m) ctx.progress(0.02 + (parseFloat(m[1]) / 100) * 0.83);
      },
    });
    ctx.onCancel(proc.kill);
    await proc.promise;
    ctx.checkCanceled();
    if (!fs.existsSync(passOut)) throw new Error('O upscaler não gerou a imagem (verifique o driver de vídeo/Vulkan).');

    ctx.progress(0.88, 'Ajustando para a resolução alvo (Lanczos3)…');
    let pipeline = sharp(passOut, { limitInputPixels: false }).resize(target.width, target.height, { fit: 'fill', kernel: 'lanczos3' });
    if (ext === '.jpg') pipeline = pipeline.jpeg({ quality: 95, chromaSubsampling: '4:4:4', mozjpeg: true });
    else if (ext === '.webp') pipeline = pipeline.webp({ quality: 95, smartSubsample: true, effort: 5 });
    else pipeline = pipeline.png({ compressionLevel: 6 });
    // Keep the original's colour profile if present.
    if (typeof pipeline.keepIccProfile === 'function') pipeline = pipeline.keepIccProfile();
    const tmpOut = path.join(tmpDir, 'final' + ext);
    await pipeline.toFile(tmpOut);
    await fsp.copyFile(tmpOut, output);
    ctx.progress(1, 'Concluído');
    return { output, skipped: false, kind, model, width: target.width, height: target.height, detected, source: meta };
  } finally {
    fsp.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  }
}

module.exports = { MODELS, TARGETS, classify, chooseModel, computeTarget, upscaleImage };
