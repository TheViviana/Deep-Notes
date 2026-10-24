// —— 番茄钟铃声：默认用 WebAudio 现场合成「滴滴」声（不随包带音频资产）；
// 传入自定义铃声（dataURL，来自用户本地文件）则直接播放。任何失败都静默——提醒音缺位不能影响计时。 ——
let ringCtx = null; // 复用：连点试听不再堆积 AudioContext（浏览器对并发数有上限）
let ringAudio = null; // 自定义铃声的上一段：重复播放前先停，长音频不会一直响
export function playRing(custom) {
  if (custom) {
    try {
      if (ringAudio) { ringAudio.pause(); ringAudio.currentTime = 0; }
      ringAudio = new Audio(custom);
      ringAudio.play().catch(() => {});
      return;
    } catch {}
  }
  try {
    const Ctx = window.AudioContext || window.webkitAudioContext;
    if (!Ctx) return;
    if (ringCtx && ringCtx.state !== 'closed') { try { ringCtx.close(); } catch {} }
    const ctx = ringCtx = new Ctx();
    const t0 = ctx.currentTime;
    // 三组「滴-滴」，末组升调：像厨房计时器而非刺耳警报
    for (let r = 0; r < 3; r++) for (let i = 0; i < 2; i++) {
      const o = ctx.createOscillator(), g = ctx.createGain();
      o.type = 'sine';
      o.frequency.value = r === 2 ? 1320 : 990;
      const at = t0 + r * 0.62 + i * 0.18;
      g.gain.setValueAtTime(0.0001, at);
      g.gain.exponentialRampToValueAtTime(0.3, at + 0.012);
      g.gain.exponentialRampToValueAtTime(0.0001, at + 0.13);
      o.connect(g).connect(ctx.destination);
      o.start(at); o.stop(at + 0.16);
    }
    setTimeout(() => { try { ctx.close(); } catch {} }, 2600);
  } catch {}
}
