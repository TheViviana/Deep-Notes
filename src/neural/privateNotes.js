// —— 隐私笔记的加密层：WebCrypto AES-GCM 256 + PBKDF2（150k 轮）——
// 密文与盐存在 .deepnotes/meta.json 的 private 键（随知识库走、可同步）；密码本身不落盘，
// 解锁后的密钥只在内存——「上锁」即清。列表 / 搜索 / 图谱都看不到密文内容。
import {privateStore} from './conceptStore';

const enc = new TextEncoder(), dec = new TextDecoder();
// 分块转 base64：spread 展开受调用栈限制（约 150-200KB 即 RangeError），长笔记必须分块
const b64 = buf => {
  const u8 = new Uint8Array(buf);
  let out = '';
  for (let i = 0; i < u8.length; i += 0x8000) out += String.fromCharCode(...u8.subarray(i, i + 0x8000));
  return btoa(out);
};
const unb64 = s => Uint8Array.from(atob(s), c => c.charCodeAt(0));
const MAGIC = 'deep-notes-private-check';
let key = null; // CryptoKey | null：unlock 后驻内存，relock 即清

export const isUnlocked = () => !!key;
export const hasVault = () => !!privateStore.get()?.salt;

async function deriveKey(password, salt) {
  const base = await crypto.subtle.importKey('raw', enc.encode(password), 'PBKDF2', false, ['deriveKey']);
  return crypto.subtle.deriveKey({name: 'PBKDF2', salt, iterations: 150000, hash: 'SHA-256'}, base,
    {name: 'AES-GCM', length: 256}, false, ['encrypt', 'decrypt']);
}
async function seal(k, plain) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const data = await crypto.subtle.encrypt({name: 'AES-GCM', iv}, k, enc.encode(plain));
  const out = new Uint8Array(iv.length + data.byteLength);
  out.set(iv); out.set(new Uint8Array(data), iv.length);
  return b64(out);
}
async function open_(k, blob) {
  const raw = unb64(blob);
  const iv = raw.slice(0, 12), data = raw.slice(12);
  const pt = await crypto.subtle.decrypt({name: 'AES-GCM', iv}, k, data);
  return dec.decode(pt);
}

// 首次启用：设置密码，建立校验串（解锁时验证密码正确性）
export async function setupVault(password) {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const k = await deriveKey(password, salt);
  const check = await seal(k, MAGIC);
  key = k;
  privateStore.write({salt: b64(salt), check, notes: []});
}

export async function unlock(password) {
  const d = privateStore.get();
  if (!d?.salt || !d?.check) throw new Error('尚未启用隐私区');
  const k = await deriveKey(password, unb64(d.salt));
  const probe = await open_(k, d.check).catch(() => null);
  if (probe !== MAGIC) throw new Error('密码不正确');
  key = k;
}

export function relock() { key = null; }

// 明文列表（需已解锁）
export async function listNotes() {
  if (!key) return [];
  const d = privateStore.get();
  const out = [];
  for (const n of d?.notes || []) {
    try { out.push({id: n.id, ts: n.ts, ...(JSON.parse(await open_(key, n.enc)))}); } catch {}
  }
  return out.sort((a, b) => (b.ts || 0) - (a.ts || 0));
}

// 读-改-写串行锁：seal 是异步的，并发调用会互相覆盖整个 notes 数组（新建丢失 / 已删复活）
let chain = Promise.resolve();
const serialized = fn => { const p = chain.then(fn, fn); chain = p.catch(() => {}); return p; };

// 新建或更新（id 缺省新建）；保存的是密文，title/body 不进任何明文存储
export function upsertNote(args) {
  return serialized(async () => {
    if (!key) throw new Error('请先解锁');
    const d = privateStore.get();
    const notes = [...(d?.notes || [])];
    const enc2 = await seal(key, JSON.stringify({title: String(args.title || ''), body: String(args.body || '')}));
    const ts = Date.now();
    const nid = args.id || 'pn-' + ts.toString(36) + Math.random().toString(36).slice(2, 6);
    const idx = notes.findIndex(n => n.id === nid);
    if (idx >= 0) notes[idx] = {...notes[idx], enc: enc2, ts};
    else notes.unshift({id: nid, enc: enc2, ts});
    privateStore.write({...d, notes});
    return nid;
  });
}

export function deleteNote(id) {
  return serialized(() => {
    const d = privateStore.get();
    privateStore.write({...d, notes: (d?.notes || []).filter(n => n.id !== id)});
  });
}

// —— 备份导入导出：整个加密库（盐 + 校验串 + 全部密文条目）导出为 .json 文件，
// 在另一台机器导入后用同一密码即可解锁。不包含密码本身。 ——
export function exportVault() {
  const d = privateStore.get();
  if (!d?.salt) throw new Error('隐私区尚未启用');
  return JSON.stringify({format: 'deepnotes-private-v1', salt: d.salt, check: d.check, notes: d.notes || []}, null, 2);
}

export function importVault(jsonText) {
  return serialized(() => {
    const v = JSON.parse(String(jsonText || ''));
    if (v?.format !== 'deepnotes-private-v1' || !v?.salt || !v?.check) throw new Error('不是有效的隐私备份文件 · Invalid backup');
    const cur = privateStore.get();
    // 空库直接导入（salt + check 随备份，用备份的密码解锁）
    if (!cur?.salt) {
      privateStore.write({salt: v.salt, check: v.check, notes: v.notes || []});
      return {adopted: true};
    }
    // 已有库 + 备份用同一密码生成（salt 相同）= 密文条目安全追加
    if (v.salt === cur.salt) {
      const existingIds = new Set((cur?.notes || []).map(n => n.id));
      const merged = [...(cur?.notes || []), ...(v.notes || []).filter(n => !existingIds.has(n.id))];
      privateStore.write({...cur, notes: merged});
      return {merged: (v.notes || []).filter(n => !existingIds.has(n.id)).length};
    }
    // 已有库 + 备份用不同密码生成：密文无法用任何密码解密（当前密码对不上备份的盐），
    // 必须拒绝而不是静默追加黑洞条目
    throw new Error('备份与当前隐私区使用了不同密码，无法合并导入。请先清空当前隐私区（或换一个空库）再导入此备份 · Password mismatch');
  });
}
