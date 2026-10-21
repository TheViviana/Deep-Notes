import React, {useEffect, useRef, useState} from 'react';

// 开屏动画（精密科技感版本，主体约 4.6s + 0.62s 淡出）：
// 深空底色（纯黑 + 极淡深蓝星云）→ 细小星点从中心向外扩散成星野 → 能量核心球体浮现
// （几何网格纹路 + 流动蓝色光带 + 三圈细轨道环异速旋转）→ 球体脉冲一次、光环同步扩散成波纹
// → 画面渐暗 → 中心浮现带动态发光的 DeepNotes 字样 → 淡出进入主界面。
// 渲染要点：高 DPR（≤3）逐像素绘制；星点颗粒分明、线条 1px 锐利，无噪点、无拖影、无糊化；
// 每帧只有个位数渐变 + 少量描边，主线程开销极低（不再拖慢启动）。
// 桌面版每次启动都会播放；网页版同一标签页刷新不重播（sessionStorage 记忆）。
// prefers-reduced-motion、点击或按任意键都会直接跳过。
const KEY = 'neural-splash-seen';
const T_NE = 900;      // 星云淡入
const T_SPH = 850;     // 球体浮现开始
const SPH = 800;       // 球体浮现时长
const T_PULSE = 3000;  // 球体脉冲开始
const PULSE = 450;     // 脉冲时长
const T_WAVE = 3080;   // 光环波纹扩散开始
const WAVE = 1150;     // 波纹时长
const T_DIM = 3350;    // 画面渐暗开始
const DIM = 650;
const T_TEXT = 3600;   // DeepNotes 字样浮现
const TEXT = 650;
const T_HOLD = 4600;   // 开始淡出进入应用
const DEEP = '#01030a';                                  // 深空底色（近纯黑带一丝深蓝）
const BLUE = '96,178,255', CYAN = '190,235,255', WHITE = '240,248,255'; // 电光蓝 / 青白 / 高光
const clamp01 = v => Math.min(Math.max(v, 0), 1);
const easeOutCubic = p => 1 - Math.pow(1 - p, 3);

// 星云：离屏预渲染（两三团极淡的深蓝渐变，不对称分布），每帧只 drawImage 一次。
function makeNebula(w, h, dpr) {
  const c = document.createElement('canvas');
  c.width = Math.max(1, Math.round(w * dpr));
  c.height = Math.max(1, Math.round(h * dpr));
  const g = c.getContext('2d');
  g.scale(dpr, dpr);
  const blobs = [
    [w * .5, h * .46, Math.max(w, h) * .55, '14,40,86', .16],
    [w * .26, h * .3, Math.max(w, h) * .4, '10,58,96', .10],
    [w * .76, h * .68, Math.max(w, h) * .42, '16,34,74', .11],
  ];
  for (const [x, y, r, col, a] of blobs) {
    const gr = g.createRadialGradient(x, y, 0, x, y, r);
    gr.addColorStop(0, `rgba(${col},${a})`);
    gr.addColorStop(1, `rgba(${col},0)`);
    g.fillStyle = gr;
    g.fillRect(x - r, y - r, r * 2, r * 2);
  }
  return c;
}

// 远景星野：离屏预渲染的极淡小星点（与扩散星点分层，制造纵深），每帧一次 drawImage。
function makeFarStars(w, h, dpr) {
  const c = document.createElement('canvas');
  c.width = Math.max(1, Math.round(w * dpr));
  c.height = Math.max(1, Math.round(h * dpr));
  const g = c.getContext('2d');
  g.scale(dpr, dpr);
  const n = Math.round(w * h / 14000);
  for (let i = 0; i < n; i++) {
    const a = .07 + Math.random() * .2;
    g.fillStyle = Math.random() < .6 ? `rgba(${CYAN},${a})` : `rgba(${WHITE},${a})`;
    g.beginPath(); g.arc(Math.random() * w, Math.random() * h, .35 + Math.random() * .5, 0, Math.PI * 2); g.fill();
  }
  return c;
}

// 扩散星点：从画面中心沿随机方位向外扩散，最终落位成主星野；少数带细十字光芒。
function makeDiffStars(w, h) {
  const maxR = Math.hypot(w, h) / 2;
  const n = Math.max(200, Math.min(460, Math.round(w * h / 5200)));
  const list = [];
  for (let i = 0; i < n; i++) {
    const th = Math.random() * Math.PI * 2;
    list.push({
      th, rf: Math.sqrt(Math.random()) * maxR * 1.02,
      jit: Math.random() * 350,                       // 出生错峰
      s: .5 + Math.random() * .85,                    // 半径：小而实
      a: .3 + Math.random() * .5,
      col: Math.random() < .62 ? CYAN : WHITE,
      cross: Math.random() < .08 ? 2 + Math.random() * 1.6 : 0, // 少数亮星带细十字光芒
    });
  }
  return list;
}

export function Intro() {
  // 已看过（网页刷新）或系统要求减少动态效果：直接不播
  const [done, setDone] = useState(() => {
    try { if (sessionStorage.getItem(KEY)) return true; } catch {}
    try { if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return true; } catch {}
    return false;
  });
  const [fade, setFade] = useState(false);
  const ref = useRef(null);

  useEffect(() => {
    if (done) { try { sessionStorage.setItem(KEY, '1'); } catch {} return; }
    const canvas = ref.current;
    const ctx = canvas.getContext('2d');
    let raf = 0, t0 = performance.now(), dead = false, fading = false;
    const finish = () => {
      if (dead) return;
      dead = true;
      cancelAnimationFrame(raf);
      try { sessionStorage.setItem(KEY, '1'); } catch {}
      setDone(true);
    };
    const failsafe = setTimeout(finish, T_HOLD + 2000); // 兜底：任何异常都不能卡住黑幕

    const dpr = Math.min(window.devicePixelRatio || 1, 3);
    let w = window.innerWidth, h = window.innerHeight;
    let nebula = null, far = null, stars = [];
    const resize = () => {
      w = window.innerWidth; h = window.innerHeight;
      canvas.width = w * dpr; canvas.height = h * dpr;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      nebula = makeNebula(w, h, dpr);
      far = makeFarStars(w, h, dpr);
      stars = makeDiffStars(w, h);
    };
    resize();
    window.addEventListener('resize', resize);

    // 三圈轨道环：半径 / 倾角 / 扁率 / 转速各不相同，细如发丝（1px）
    const RINGS = [
      {k: 1.55, tilt: -.42, ryk: .30, sp: .0011, ph: .6},
      {k: 1.95, tilt: .30, ryk: .24, sp: -.0007, ph: 2.7},
      {k: 2.42, tilt: .62, ryk: .20, sp: .00045, ph: 4.6},
    ];

    const step = now => {
      const t = now - t0;
      const cx = w / 2, cy = h / 2;
      const pN = clamp01(t / T_NE);
      const pS = clamp01((t - T_SPH) / SPH);
      const b = Math.sin(Math.PI * clamp01((t - T_PULSE) / PULSE)); // 脉冲包络（0→1→0）
      const pW = clamp01((t - T_WAVE) / WAVE);
      const pDim = clamp01((t - T_DIM) / DIM);
      const pT = clamp01((t - T_TEXT) / TEXT);
      const dimK = 1 - pDim; // 渐暗系数（文字阶段不受影响）

      // 背景：深空底色 + 星云 + 远景星野
      ctx.globalCompositeOperation = 'source-over';
      ctx.globalAlpha = 1;
      ctx.fillStyle = DEEP;
      ctx.fillRect(0, 0, w, h);
      if (pN > 0) {
        if (nebula) { ctx.globalAlpha = pN * (.35 + .65 * dimK); ctx.drawImage(nebula, 0, 0, w, h); }
        if (far) { ctx.globalAlpha = pN * dimK; ctx.drawImage(far, 0, 0, w, h); }
        ctx.globalAlpha = 1;
      }

      // 星点扩散：中心向外，落位后成为主星野（微微闪烁但保持锐利）
      for (const s of stars) {
        const p = clamp01((t - 60 - s.jit) / 1000);
        if (p <= 0) continue;
        const r = s.rf * easeOutCubic(p);
        const x = cx + Math.cos(s.th) * r, y = cy + Math.sin(s.th) * r;
        const a = s.a * Math.min(1, p * 3) * (.9 + .1 * Math.sin(now / 700 + s.jit)) * dimK;
        if (a <= .02) continue;
        ctx.fillStyle = `rgba(${s.col},${a})`;
        ctx.beginPath(); ctx.arc(x, y, s.s, 0, Math.PI * 2); ctx.fill();
        if (s.cross && a > .18) { // 细十字光芒：短直线，干净不发糊
          ctx.strokeStyle = `rgba(${s.col},${a * .5})`;
          ctx.lineWidth = 1;
          ctx.beginPath(); ctx.moveTo(x - s.cross, y); ctx.lineTo(x + s.cross, y);
          ctx.moveTo(x, y - s.cross); ctx.lineTo(x, y + s.cross); ctx.stroke();
        }
      }

      // 能量核心球体
      if (pS > 0 && dimK > .02) {
        const R = Math.min(w, h) * .155 * easeOutCubic(pS) * (1 + .05 * b);
        const gA = pS * dimK; // 球体组整体透明度
        // 核心辉光：紧凑的青白渐变，脉冲时增亮
        const glow = ctx.createRadialGradient(cx, cy, R * .1, cx, cy, R * 1.75);
        glow.addColorStop(0, `rgba(${CYAN},${(.30 + .18 * b) * gA})`);
        glow.addColorStop(.45, `rgba(${BLUE},${(.12 + .08 * b) * gA})`);
        glow.addColorStop(1, `rgba(${BLUE},0)`);
        ctx.fillStyle = glow;
        ctx.fillRect(cx - R * 1.8, cy - R * 1.8, R * 3.6, R * 3.6);

        ctx.save();
        ctx.beginPath(); ctx.arc(cx, cy, R, 0, Math.PI * 2); ctx.clip();
        // 纬线：五圈固定纬度的椭圆，透视压扁
        ctx.lineWidth = 1;
        for (let i = -2; i <= 2; i++) {
          const beta = i * Math.PI / 6;
          const rx = R * Math.cos(beta), yy = cy + R * Math.sin(beta) * .96;
          ctx.strokeStyle = `rgba(${BLUE},${.16 * gA})`;
          ctx.beginPath(); ctx.ellipse(cx, yy, rx, Math.max(.5, rx * .30), 0, 0, Math.PI * 2); ctx.stroke();
        }
        // 经线：六条大圆绕纵轴旋转，投影成宽度呼吸的椭圆
        for (let i = 0; i < 6; i++) {
          const psi = i * Math.PI / 6 + t * .00055;
          const rx = R * Math.abs(Math.cos(psi));
          if (rx < R * .05) continue;
          ctx.strokeStyle = `rgba(${BLUE},${.20 * gA})`;
          ctx.beginPath(); ctx.ellipse(cx, cy, rx, R, 0, 0, Math.PI * 2); ctx.stroke();
        }
        // 流动光带：两条近赤道的亮弧沿椭圆游走，边缘锐利（butt 端帽 + 窄线宽）
        const band = (beta, sp, off, al) => {
          const rx = R * Math.cos(beta), yy = cy + R * Math.sin(beta) * .96, ry = Math.max(.5, rx * .30);
          const u = (t * sp + off) % (Math.PI * 2);
          ctx.strokeStyle = `rgba(${BLUE},${al * gA})`;
          ctx.lineWidth = 1.8; ctx.lineCap = 'butt';
          ctx.beginPath(); ctx.ellipse(cx, yy, rx, ry, 0, u, u + 2.1); ctx.stroke();
          ctx.strokeStyle = `rgba(${CYAN},${al * .4 * gA})`;
          ctx.lineWidth = 1;
          ctx.beginPath(); ctx.ellipse(cx, yy, rx, ry, 0, u + 2.1, u + 2.9); ctx.stroke();
          // 前导亮点
          const lx = cx + rx * Math.cos(u), ly = yy + ry * Math.sin(u);
          ctx.fillStyle = `rgba(${CYAN},${.9 * gA})`;
          ctx.beginPath(); ctx.arc(lx, ly, 1.6, 0, Math.PI * 2); ctx.fill();
        };
        band(-.21, .0011, 0, .8);
        band(.14, -.0007, 2.4, .6);
        ctx.restore();

        // 球体轮廓：一圈清晰的亮边
        ctx.strokeStyle = `rgba(${CYAN},${(.42 + .3 * b) * gA})`;
        ctx.lineWidth = 1;
        ctx.beginPath(); ctx.arc(cx, cy, R, 0, Math.PI * 2); ctx.stroke();

        // 三圈轨道环：整体细描 + 一段亮弧指示转动
        const rA = clamp01((t - T_SPH - 500) / 500) * gA;
        if (rA > .02) {
          for (const rg of RINGS) {
            const rx = R * rg.k, ry = rx * rg.ryk;
            ctx.save();
            ctx.translate(cx, cy); ctx.rotate(rg.tilt);
            ctx.strokeStyle = `rgba(${BLUE},${.30 * rA})`;
            ctx.lineWidth = 1;
            ctx.beginPath(); ctx.ellipse(0, 0, rx, ry, 0, 0, Math.PI * 2); ctx.stroke();
            const u = t * rg.sp + rg.ph;
            ctx.strokeStyle = `rgba(${CYAN},${.9 * rA})`;
            ctx.beginPath(); ctx.ellipse(0, 0, rx, ry, 0, u, u + .9); ctx.stroke();
            ctx.restore();
          }
        }
      }

      // 脉冲光环波纹：一圈清晰的波纹从球面向外扩散并淡去
      if (pW > 0 && pW < 1) {
        const maxR = Math.hypot(w, h) / 2 + 30;
        for (let i = 0; i < 2; i++) {
          const p = clamp01(pW * 1.25 - i * .22);
          if (p <= 0 || p >= 1) continue;
          ctx.strokeStyle = i ? `rgba(${BLUE},${(1 - p) * .55})` : `rgba(${CYAN},${(1 - p) * .8})`;
          ctx.lineWidth = i ? 1 : 1.5;
          ctx.beginPath(); ctx.arc(cx, cy, Math.min(w, h) * .155 + p * maxR, 0, Math.PI * 2); ctx.stroke();
        }
      }

      // 画面渐暗（文字在其上绘制，不受影响）
      if (pDim > 0) {
        ctx.fillStyle = `rgba(0,1,6,${pDim})`;
        ctx.fillRect(0, 0, w, h);
      }

      // DeepNotes 字样：动态发光（浮现时辉光由大收拢，之后缓慢呼吸）
      if (pT > 0) {
        const size = Math.round(Math.min(w, h) * .058);
        ctx.save();
        ctx.font = `600 ${size}px "SF Pro Display","Segoe UI",system-ui,-apple-system,sans-serif`;
        try { ctx.letterSpacing = Math.round(size * .16) + 'px'; } catch {}
        ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
        const g = .8 + .2 * Math.sin(now / 230);
        const blur = 16 + 46 * (1 - easeOutCubic(pT)) * g;
        const tx = cx, ty = cy - size * .2;
        ctx.shadowColor = `rgba(${BLUE},.9)`;
        ctx.shadowBlur = blur;
        ctx.fillStyle = `rgba(${BLUE},${.55 * pT})`;
        ctx.fillText('DeepNotes', tx, ty);
        ctx.shadowBlur = 6;
        ctx.fillStyle = `rgba(${CYAN},${.95 * pT})`;
        ctx.fillText('DeepNotes', tx, ty);
        ctx.shadowBlur = 0;
        ctx.fillStyle = `rgba(${WHITE},${pT})`;
        ctx.fillText('DeepNotes', tx, ty);
        ctx.restore();
      }

      // 淡出进入应用
      if (t >= T_HOLD && !fading) {
        fading = true;
        setFade(true);
        setTimeout(finish, 720);
      }
    };
    // 与核心动效同一套防中断写法：先排下一帧，再在 try 里执行本帧；出错直接放行进入应用
    const frame = now => { raf = requestAnimationFrame(frame); try { step(now); } catch { finish(); } };
    raf = requestAnimationFrame(frame);

    // 点击或按任意键跳过：直接淡出进入应用
    const skip = () => {
      if (fading) return;
      fading = true;
      setFade(true);
      setTimeout(finish, 720);
    };
    window.addEventListener('pointerdown', skip);
    window.addEventListener('keydown', skip);
    return () => {
      dead = true;
      cancelAnimationFrame(raf);
      clearTimeout(failsafe);
      window.removeEventListener('resize', resize);
      window.removeEventListener('pointerdown', skip);
      window.removeEventListener('keydown', skip);
    };
  }, [done]);

  if (done) return null;
  return <canvas ref={ref} className={`intro-veil${fade ? ' fade' : ''}`} aria-hidden="true"/>;
}
