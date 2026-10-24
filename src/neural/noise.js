// —— 专注白噪音：WebAudio 本地实时合成（无音频资产、不联网）——
// 三种声景都是噪声合成的近似：雨声（白噪+高频衰减+稀疏雨滴）、溪流（棕噪+低频起伏）、
// 咖啡馆（棕噪+偶发杯碟叮声）。单例管理，番茄钟专注开始自动播、结束/停止即停。
let ctx = null;
let master = null;
let nodes = [];
let timer = null;
let cur = '';

function makeNoiseBuffer(type) {
  // 2 秒循环缓冲：白噪 / 棕噪（积分白噪）。棕噪是积分游走，首尾不接会每圈「噗」一声：
  // 尾部 0.5 秒做线性回归淡出，把游走拉回首样本的量级，循环无缝
  const len = ctx.sampleRate * 2;
  const buf = ctx.createBuffer(1, len, ctx.sampleRate);
  const d = buf.getChannelData(0);
  let last = 0;
  const fade = Math.floor(len / 4);
  for (let i = 0; i < len; i++) {
    const w = Math.random() * 2 - 1;
    if (type === 'brown') { last = (last + 0.02 * w) / 1.02; d[i] = last * 3.2; }
    else d[i] = w;
  }
  if (type === 'brown') {
    const tail = len - fade;
    for (let i = 0; i < fade; i++) {
      const k = i / fade; // 0→1：把尾部混向首样本，权重渐增
      d[tail + i] = d[tail + i] * (1 - k) + d[i] * k;
    }
  }
  return buf;
}

function build(kind) {
  // 基底噪声源 + 滤波，按声景调音色
  const src = ctx.createBufferSource();
  src.buffer = makeNoiseBuffer(kind === 'rain' ? 'white' : 'brown');
  src.loop = true;
  const filter = ctx.createBiquadFilter();
  const gain = ctx.createGain();
  if (kind === 'rain') {
    filter.type = 'highshelf'; filter.frequency.value = 1400; filter.gain.value = 6; // 雨声偏亮
    gain.gain.value = 0.10;
  } else if (kind === 'stream') {
    filter.type = 'lowpass'; filter.frequency.value = 900; // 溪流偏沉
    gain.gain.value = 0.16;
    // 低频缓慢起伏：像水流忽大忽小
    const lfo = ctx.createOscillator(), lg = ctx.createGain();
    lfo.frequency.value = 0.13; lg.gain.value = 0.05;
    lfo.connect(lg).connect(gain.gain); lfo.start();
    nodes.push(lfo);
  } else { // cafe
    filter.type = 'lowpass'; filter.frequency.value = 700;
    gain.gain.value = 0.12;
  }
  src.connect(filter).connect(gain).connect(master);
  src.start();
  nodes.push(src);
  if (kind === 'rain') {
    // 稀疏「雨滴」：随机时刻的短促带通脉冲
    timer = setInterval(() => {
      if (!ctx || ctx.state === 'closed') return;
      const t = ctx.currentTime;
      const o = ctx.createOscillator(), g = ctx.createGain(), bp = ctx.createBiquadFilter();
      o.type = 'sine'; o.frequency.value = 2400 + Math.random() * 2200;
      bp.type = 'bandpass'; bp.frequency.value = o.frequency.value; bp.Q.value = 9;
      g.gain.setValueAtTime(0.0001, t);
      g.gain.exponentialRampToValueAtTime(0.05 + Math.random() * 0.05, t + 0.004);
      g.gain.exponentialRampToValueAtTime(0.0001, t + 0.05);
      o.connect(bp).connect(g).connect(master);
      o.start(t); o.stop(t + 0.07);
    }, 260);
  } else if (kind === 'cafe') {
    // 偶发杯碟轻碰
    timer = setInterval(() => {
      if (!ctx || ctx.state === 'closed' || Math.random() < 0.45) return;
      const t = ctx.currentTime;
      [1900, 2700].forEach((f, i) => {
        const o = ctx.createOscillator(), g = ctx.createGain();
        o.type = 'sine'; o.frequency.value = f * (0.96 + Math.random() * 0.08);
        const at = t + i * 0.045;
        g.gain.setValueAtTime(0.0001, at);
        g.gain.exponentialRampToValueAtTime(0.035, at + 0.005);
        g.gain.exponentialRampToValueAtTime(0.0001, at + 0.16);
        o.connect(g).connect(master);
        o.start(at); o.stop(at + 0.2);
      });
    }, 2100);
  }
}

export function noiseStart(kind) {
  if (!kind || kind === 'none') { noiseStop(); return; }
  try {
    if (cur === kind) return;
    noiseStop();
    const Ctx = window.AudioContext || window.webkitAudioContext;
    if (!Ctx) return;
    ctx = new Ctx();
    master = ctx.createGain();
    master.gain.value = 1;
    master.connect(ctx.destination);
    build(kind);
    cur = kind;
  } catch {}
}

export function noiseStop() {
  try { if (timer) clearInterval(timer); } catch {}
  timer = null;
  try { nodes.forEach(n => { try { n.stop(); } catch {} try { n.disconnect(); } catch {} }); } catch {}
  nodes = [];
  try { if (master) master.disconnect(); } catch {}
  master = null;
  try { if (ctx) ctx.close(); } catch {}
  ctx = null;
  cur = '';
}

export const noiseCur = () => cur;
