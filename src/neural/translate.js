// 沉浸式翻译的本地实现：把外语段落译成中文，双语对照。
// 只有联网开关（plugins.jsx 的 useNetwork）打开时，调用方才会用到这里；缓存仅在内存中。
const CACHE = new Map();
const CJK_RE = /[\u4e00-\u9fff]/g;

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

async function viaMyMemory(text) {
  const r = await fetch(`https://api.mymemory.translated.net/get?q=${encodeURIComponent(text)}&langpair=en|zh-CN`);
  if (!r.ok) throw new Error('mymemory ' + r.status);
  const d = await r.json();
  const out = d?.responseData?.translatedText;
  if (!out || /MYMEMORY WARNING/i.test(out)) throw new Error('mymemory empty');
  return out;
}

async function viaGoogle(text) {
  const r = await fetch(`https://translate.googleapis.com/translate_a/single?client=gtx&sl=auto&tl=zh-CN&dt=t&q=${encodeURIComponent(text)}`);
  if (!r.ok) throw new Error('google ' + r.status);
  const j = await r.json();
  const out = (j?.[0] || []).map(x => x?.[0] || '').join('');
  if (!out) throw new Error('google empty');
  return out;
}

// 主通道 MyMemory（免密钥、支持 CORS），失败回落 Google gtx
const translateChunk = async text => {
  try { return await viaMyMemory(text); } catch {}
  return viaGoogle(text);
};

// 翻译一段原文（自动切块、并行、内存缓存）
export async function translateText(text) {
  const src = String(text || '').trim();
  if (!src) return '';
  if (CACHE.has(src)) return CACHE.get(src);
  const out = (await Promise.all(chunk(src).map(translateChunk))).join('');
  CACHE.set(src, out);
  return out;
}
