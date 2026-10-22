// 沉浸式翻译的本地实现：把外语段落译成中文，双语对照。
// 只有联网开关（plugins.jsx 的 useNetwork）打开时，调用方才会用到这里；缓存仅在内存中。
const CACHE = new Map();
const CACHE_MAX = 300; // 缓存上限：超限按插入序淘汰最旧（命中时刷新位置），翻译一整本长文也不再无限吃内存
const CJK_RE = /[\u4e00-\u9fff]/g;

const cacheGet = k => {
  if (!CACHE.has(k)) return undefined;
  const v = CACHE.get(k);
  CACHE.delete(k); CACHE.set(k, v); // 刷新新鲜度
  return v;
};
const cacheSet = (k, v) => {
  if (CACHE.has(k)) CACHE.delete(k);
  CACHE.set(k, v);
  while (CACHE.size > CACHE_MAX) CACHE.delete(CACHE.keys().next().value);
};

// 已经基本是中文、或太短的段落不翻译
export const isTranslatable = text => {
  const s = String(text || '').replace(/\s/g, '');
  if (s.length < 8) return false;
  const cjk = (s.match(CJK_RE) || []).length;
  return cjk / s.length < .3;
};

// 按句子边界切块（免费接口单次约 500 字节上限）
function chunk(text) {
  if (text.length <= 450) return [text];
  const parts = [];
  let buf = '';
  for (const seg of text.split(/(?<=[.!?;。！？；])/)) {
    if (buf && (buf + seg).length > 450) { parts.push(buf); buf = seg; }
    else buf += seg;
  }
  if (buf) parts.push(buf);
  return parts;
}

// 单次请求超时（12s）：免费接口偶发挂起，没有超时会让整段翻译一直卡在「进行中」
const TIMEOUT = 12000;
async function fetchWithTimeout(url) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), TIMEOUT);
  try { return await fetch(url, {signal: ctrl.signal}); }
  finally { clearTimeout(t); }
}

async function viaMyMemory(text) {
  const r = await fetchWithTimeout(`https://api.mymemory.translated.net/get?q=${encodeURIComponent(text)}&langpair=en|zh-CN`);
  if (!r.ok) throw new Error('mymemory ' + r.status);
  const d = await r.json();
  const out = d?.responseData?.translatedText;
  if (!out || /MYMEMORY WARNING/i.test(out)) throw new Error('mymemory empty');
  return out;
}

async function viaGoogle(text) {
  const r = await fetchWithTimeout(`https://translate.googleapis.com/translate_a/single?client=gtx&sl=auto&tl=zh-CN&dt=t&q=${encodeURIComponent(text)}`);
  if (!r.ok) throw new Error('google ' + r.status);
  const j = await r.json();
  const out = (j?.[0] || []).map(x => x?.[0] || '').join('');
  if (!out) throw new Error('google empty');
  return out;
}

// 单通道一次尝试：免费接口偶发限流 / 超时，失败退避 600ms 重试一次再认输
const viaChannel = async (fn, text) => {
  try { return await fn(text); }
  catch { await new Promise(r => setTimeout(r, 600)); return fn(text); }
};

// 主通道 MyMemory（免密钥、支持 CORS），失败回落 Google gtx
const translateChunk = async text => {
  try { return await viaChannel(viaMyMemory, text); } catch {}
  return viaChannel(viaGoogle, text);
};

// 翻译一段原文（自动切块、2 路并发、内存缓存）
// 单个分块失败时回落原文而不是整体 reject：整段可用，只有失败的那几句保持原文；
// 结果照常写缓存，避免同一段反复重试形成请求风暴。
const CONCURRENCY = 2;
export async function translateText(text) {
  const src = String(text || '').trim();
  if (!src) return '';
  const hit = cacheGet(src);
  if (hit !== undefined) return hit;
  const parts = chunk(src);
  const out = new Array(parts.length);
  let i = 0;
  const worker = async () => {
    while (i < parts.length) {
      const k = i++;
      out[k] = await translateChunk(parts[k]).catch(() => parts[k]);
    }
  };
  await Promise.all(Array.from({length: Math.min(CONCURRENCY, parts.length)}, worker));
  const res = out.join('');
  cacheSet(src, res);
  return res;
}
