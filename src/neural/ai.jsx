// AI 助手插件：接入用户自配的 OpenAI 兼容 API（/v1/chat/completions）。
// 硬约束：默认断网——只有顶栏联网开关与本插件同时打开才会发起请求；
// API key 与对话记录只存本机 localStorage；Electron 桌面版经主进程转发以绕开浏览器 CORS。
import React, {useEffect, useMemo, useRef, useState} from 'react';
import {Icon} from './icons';
import {CONFIG} from '../config';
import {isNetworkOn, useNetwork, usePlugins} from './plugins';
import {renderMarkdown} from './ArticleView.jsx';
import {CONTENT, nameIndex} from './graph';
import {aiMemory, aiPersona, saveAiMemory, forgetAiMemory, aiMemoryPrompt} from './conceptStore';

// —— 服务商预设：baseUrl 与常用模型来自各家公开文档；custom 允许接任意 OpenAI 兼容端点 ——
export const AI_PROVIDERS = [
  {id: 'deepseek', name: 'DeepSeek', baseUrl: 'https://api.deepseek.com/v1', models: ['deepseek-v4-flash', 'deepseek-v4-pro'],
    modelNames: {'deepseek-v4-flash': 'DeepSeek V4.1 Flash', 'deepseek-v4-pro': 'DeepSeek V4 Pro'},
    note: '推理等级经 reasoning_effort 传给 API（关 = 不推理）；模型清单与 DeepSeek Harness 一致。'},
  {id: 'openai', name: 'OpenAI', baseUrl: 'https://api.openai.com/v1', models: ['gpt-4.1-mini', 'gpt-4.1', 'gpt-4o', 'o4-mini'],
    note: '深度思考 = 对推理模型附加 reasoning_effort=high。'},
  {id: 'openrouter', name: 'OpenRouter', baseUrl: 'https://openrouter.ai/api/v1', models: ['openrouter/auto', 'deepseek/deepseek-chat', 'anthropic/claude-sonnet-4'], customModel: true},
  {id: 'siliconflow', name: '硅基流动', baseUrl: 'https://api.siliconflow.cn/v1', models: ['deepseek-ai/DeepSeek-V3', 'Qwen/Qwen2.5-72B-Instruct'], customModel: true},
  {id: 'ollama', name: 'Ollama 本地', baseUrl: 'http://127.0.0.1:11434/v1', models: ['qwen2.5', 'deepseek-r1'], customModel: true, needKey: false,
    note: '本机模型，无需 API Key；推理等级由所选模型决定。'},
  {id: 'custom', name: '自定义', baseUrl: '', models: [], customModel: true},
];
const providerOf = cfg => AI_PROVIDERS.find(x => x.id === cfg.provider) || AI_PROVIDERS[0];

// 本机回环端口白名单：本地模型 / 推理服务的常用端口（Ollama / LM Studio / Jan / OpenWebUI /
// text-gen-webui / KoboldCpp / Gradio / vLLM / llama.cpp）。与 electron/main.cjs 的 LOCAL_PORTS 保持一致。
const LOCAL_PORTS = new Set([11434, 11435, 1234, 1337, 3000, 5000, 5001, 7860, 8000, 8080, 8081, 8888]);

// —— 配置单例：模块级 state + 订阅（chip、面板、发送逻辑共享同一份） ——
const AI_KEY = CONFIG.storagePrefix + '-ai-v1';
const ENC_PREFIX = 'enc:'; // 桌面版 safeStorage 密文（base64）前缀；无前缀为旧版明文，读取时自动升级
const canSecure = () => !!(window.electronAPI?.keyEncrypt && window.electronAPI?.keyDecrypt);
let encSeq = 0; // 密钥连续编辑时防止乱序的旧密文覆盖新密文
let secureWarn = false; // safeStorage 加密失败：密钥本轮只留在内存、没有落盘，配置面板据此提示
function persistAi(state) {
  // 桌面版：密钥经主进程 safeStorage 加密后一次性落盘（enc: 前缀 + base64），localStorage 不存明文。
  // 审计 M3：不再「先落空 key 占位、密文回来再覆盖」——两步之间崩溃会把密钥抹掉。
  // 现在密文没回来之前不写盘，落盘只有一次原子写入；加密失败才落一份去密钥的配置并提示，
  // 明文绝不入库的底线不变
  if (state.apiKey && canSecure() && !state.apiKey.startsWith(ENC_PREFIX)) {
    const seq = ++encSeq;
    const saveBare = () => { try { localStorage.setItem(AI_KEY, JSON.stringify({...state, apiKey: ''})); } catch (err) { console.warn('localStorage 写入失败 · Save failed:', err); } };
    window.electronAPI.keyEncrypt(state.apiKey).then(res => {
      if (!res?.ok || seq !== encSeq) {
        // 加密失败（系统安全存储不可用等）：密钥本轮只留在内存，面板给出提示，
        // 用户至少知道为什么重启后密钥没了
        if (res && !res.ok && seq === encSeq) { secureWarn = true; saveBare(); for (const f of aiSubs) f(aiState); }
        return;
      }
      secureWarn = false;
      try { localStorage.setItem(AI_KEY, JSON.stringify({...state, apiKey: ENC_PREFIX + res.data})); } catch {}
    }).catch(() => { if (seq === encSeq) { secureWarn = true; saveBare(); for (const f of aiSubs) f(aiState); } });
    return;
  }
  try { localStorage.setItem(AI_KEY, JSON.stringify(state)); }
  catch (err) { console.warn('localStorage 写入失败 · Save failed:', err); }
}
// 用户在本会话里动过密钥输入框（改值或清掉）：此后一切异步回填 / 明文升级都必须让位，
// 否则「删掉旧密钥」会被解密回调或明文升级把旧密钥又写上盘、塞回面板。
let keyUserEdited = false;
function loadAi() {
  let cfg;
  try { cfg = JSON.parse(localStorage.getItem(AI_KEY)) || {}; } catch { cfg = {}; }
  if (cfg.apiKey?.startsWith(ENC_PREFIX)) {
    // 密文：异步解密回填内存，localStorage 里的密文保持不动
    const b64 = cfg.apiKey.slice(ENC_PREFIX.length);
    cfg.apiKey = '';
    window.electronAPI?.keyDecrypt(b64).then(res => {
      // 用户可能在解密回调返回前已手动输入新密钥：不得用旧密钥覆盖新输入
      if (res?.ok && res.data && !keyUserEdited && !aiState.apiKey) { aiState = {...aiState, apiKey: res.data}; for (const f of aiSubs) f(aiState); }
    }).catch(() => {});
  } else if (cfg.apiKey && canSecure()) {
    // 旧版明文密钥：读进内存后立即升级为密文落盘
    const plain = cfg.apiKey;
    cfg.apiKey = '';
    window.electronAPI.keyEncrypt(plain).then(res => {
      // 落盘侧清理只动「仍是那份旧明文」的存储：回调晚到时用户可能已输入新密钥，不能误清
      const clearStale = () => {
        try {
          const cur = JSON.parse(localStorage.getItem(AI_KEY)) || {};
          if (cur.apiKey === plain) persistAi({...cur, apiKey: ''});
        } catch {}
      };
      if (!res?.ok) { clearStale(); return; } // 加密失败则清掉明文不落盘：重启后需重填
      // 升级回填只在密钥未被用户改动时执行：回调晚到时用户的新输入优先
      // 用户已亲手改过密钥（含改完又清空）：不再回填、不再升级；
      // 但盘上仍躺着那份旧明文时照样清掉——它已经不是用户认可的密钥，留着只是风险
      if (keyUserEdited) { clearStale(); return; }
      if (aiState.apiKey && aiState.apiKey !== plain) return;
      persistAi({...aiState, apiKey: ENC_PREFIX + res.data}); // 落盘密文
      aiState = {...aiState, apiKey: plain}; // 内存回填明文（升级前 cfg 已清空，不回填则本次会话 AI 无密钥可用）
      for (const f of aiSubs) f(aiState);
    }).catch(() => {
      try {
        const cur = JSON.parse(localStorage.getItem(AI_KEY)) || {};
        if (cur.apiKey === plain) persistAi({...cur, apiKey: ''});
      } catch {}
    });
  }
  return cfg;
}
let aiState = {provider: 'deepseek', baseUrl: '', apiKey: '', model: '', gear: 'off', ...loadAi()};
const aiSubs = new Set();
function writeAi(patch) {
  // 只认「密钥字段的值真的变了」：面板整份配置的写入不该被误判成用户编辑密钥
  if (patch && Object.prototype.hasOwnProperty.call(patch, 'apiKey') && patch.apiKey !== aiState.apiKey) keyUserEdited = true;
  aiState = {...aiState, ...patch};
  persistAi(aiState);
  for (const f of aiSubs) f(aiState);
}
export function useAiConfig() {
  const [s, setS] = useState(aiState);
  useEffect(() => { const f = v => setS(v); aiSubs.add(f); return () => { aiSubs.delete(f); }; }, []);
  return [s, writeAi];
}
export const aiConfig = () => aiState;

// —— 推理等级：Off / Low / High / Max 四档（与 DeepSeek Harness 的模型选项一致）；
// 旧配置里的 standard / deep 两档自动迁移为 off / high ——
export const AI_GEARS = [
  {id: 'off', zh: '关', en: 'Off', title: '关闭推理，直出答案 · No reasoning'},
  {id: 'low', zh: '低', en: 'Low', title: '轻度推理 · Light reasoning'},
  {id: 'high', zh: '高', en: 'High', title: '深度推理 · Deep reasoning'},
  {id: 'max', zh: '最大', en: 'Max', title: '最大推理预算 · Max reasoning budget'},
];
export function effectiveGear(cfg = aiState) {
  if (cfg.gear === 'deep') return 'high';
  return AI_GEARS.some(g => g.id === cfg.gear) ? cfg.gear : 'off';
}
// DeepSeek v4 系列没有独立 reasoner 模型（与 DeepSeek Harness 一致）；旧配置里已退役的
// chat / reasoner 自动归一为 deepseek-v4-flash。其余服务商保持所选模型
export function effectiveModel(cfg = aiState) {
  const p = providerOf(cfg);
  let m = cfg.model || p.models[0] || '';
  if (p.id === 'deepseek' && !p.models.includes(m)) m = 'deepseek-v4-flash';
  return m;
}
// 模型下拉显示名：DeepSeek 显示产品名，其余显示模型 id
export const modelLabel = (p, m) => p.modelNames?.[m] || m;

// —— 请求层：Electron 下走主进程转发（部分服务商不允许浏览器 CORS），浏览器直连 ——
// 传入 onDelta 时走流式（SSE）：主进程只转发原始字节，渲染层解析并逐段回调，
// 同时聚合成与非流式一致的 {choices:[{message}]} 结构——工具调用循环逻辑完全不变。
// delta.tool_calls 按 index 增量聚合（id / 函数名 / 参数串都是分片到达的）。
function sseFeeder(onEvent) {
  let buf = '';
  return chunk => {
    buf += chunk;
    let idx;
    while ((idx = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, idx).replace(/\r$/, '');
      buf = buf.slice(idx + 1);
      if (!line.startsWith('data:')) continue;
      const payload = line.slice(5).trim();
      if (!payload || payload === '[DONE]') continue;
      try { onEvent(JSON.parse(payload)); } catch { /* 半行 / 心跳注释：跳过 */ }
    }
  };
}

export async function aiChat(messages, {onDelta} = {}) {
  const cfg = aiState, p = providerOf(cfg);
  const baseUrl = (cfg.baseUrl || p.baseUrl || '').replace(/\/+$/, '');
  if (!baseUrl) throw new Error('还没有配置 Base URL · Base URL missing');
  const model = effectiveModel(cfg);
  const streaming = typeof onDelta === 'function';
  const body = {model, messages, stream: streaming};
  // 推理等级：DeepSeek 四档经 reasoning_effort 传给 API（关 = 不传）；OpenAI 推理模型沿用 high
  const gear = effectiveGear(cfg);
  if (p.id === 'deepseek' && gear !== 'off') body.reasoning_effort = gear;
  else if (p.id === 'openai' && gear !== 'off' && /^(o\d|gpt-5)/.test(model)) body.reasoning_effort = gear === 'low' ? 'low' : 'high';
  const headers = {'content-type': 'application/json'};
  if (cfg.apiKey && p.needKey !== false) headers.authorization = 'Bearer ' + cfg.apiKey;
  const url = baseUrl + '/chat/completions';
  let u;
  try { u = new URL(url); } catch { throw new Error('Base URL 无效 · Invalid Base URL'); }

  // —— 流式路径：桌面走主进程转发，浏览器直连（地址规则同非流式） ——
  if (streaming) {
    // 桌面/浏览器同一套地址校验：https 公网放行，明文 http 仅本机回环 + 常见本地服务端口
    if (!(window.electronAPI?.aiFetchStream)) {
      const host = u.hostname.toLowerCase();
      if (u.protocol === 'https:') { /* 任意 https 放行 */ }
      else if (u.protocol === 'http:' && (host === 'localhost' || host === '::1' || /^127\./.test(host))) {
        if (!LOCAL_PORTS.has(Number(u.port) || 0)) {
          throw new Error(`本机 http 仅允许常见本地服务端口（${[...LOCAL_PORTS].sort((a, b) => a - b).join(' / ')}）· Local port not allowed`);
        }
      }
      else if (u.protocol === 'http:') throw new Error('明文 http 仅允许本机地址（localhost / 127.0.0.1 / ::1）· Plain http only for local addresses');
      else throw new Error('仅允许 http(s) 地址 · Only http(s) URLs are allowed');
    }
    const agg = {content: '', tools: []};
    const onEvent = ev => {
      const d = ev?.choices?.[0]?.delta;
      if (!d) return;
      if (d.content) { agg.content += d.content; onDelta(d.content); }
      if (Array.isArray(d.tool_calls)) for (const tc of d.tool_calls) {
        const i = Number(tc.index) || 0;
        agg.tools[i] = agg.tools[i] || {id: '', name: '', arguments: ''};
        if (tc.id) agg.tools[i].id = tc.id;
        if (tc.function?.name) agg.tools[i].name += tc.function.name;
        if (tc.function?.arguments) agg.tools[i].arguments += tc.function.arguments;
      }
      // delta.reasoning_content（DeepSeek 推理痕迹）有意忽略：不进正文，也不上屏
    };
    const feed = sseFeeder(onEvent);
    const finish = () => {
      if (!agg.content && !agg.tools.length) throw new Error('模型没有返回内容 · Empty response');
      const message = {role: 'assistant', content: agg.content};
      if (agg.tools.length) message.tool_calls = agg.tools.map(t => ({
        id: t.id || 'call_' + Math.random().toString(36).slice(2, 8), type: 'function',
        function: {name: t.name, arguments: t.arguments || ''}}));
      return {choices: [{message}]};
    };
    try {
      let res;
      if (window.electronAPI?.aiFetchStream) {
        res = await window.electronAPI.aiFetchStream({url, headers, body}, feed);
        if (!res?.ok) throw new Error(res?.error || res?.data?.error?.message || `HTTP ${res?.status}`);
      } else {
        const resp = await fetch(u, {method: 'POST', headers, body: JSON.stringify(body)});
        if (!resp.ok) { const data = await resp.json().catch(() => null); throw new Error(data?.error?.message || `HTTP ${resp.status}`); }
        if (!resp.body) throw new Error('响应体不可读 · Unreadable response');
        const reader = resp.body.getReader(), dec = new TextDecoder();
        for (;;) {
          const {done, value} = await reader.read();
          if (done) break;
          feed(dec.decode(value, {stream: true}));
        }
      }
      return finish();
    } catch (err) {
      // 流式通道整体失败（端点不支持 stream 字段 / 旧版主进程等）且没收到任何内容：
      // 自动回退一次非流式——退化为「等全部生成完再出现」的旧行为，而不是直接报错
      if (agg.content || agg.tools.length) throw err;
      const data = await aiChatNonStream(url, headers, {...body, stream: false}); // 回退请求必须去掉 stream 标记
      const m = data?.choices?.[0]?.message;
      if (m?.content) { agg.content = m.content; onDelta(m.content); }
      return finish();
    }
  }

  return aiChatNonStream(url, headers, body, u);
}
// —— 非流式请求（工具建议 / 润色等一次性请求 & 流式回退）：桌面主进程转发，浏览器直连 ——
// 直连走与桌面主进程同一套地址规则——https 公网放行，明文 http 仅本机回环且限常见本地
// 服务端口（本地 Ollama 场景），其余协议拒绝，防止 Base URL 被填成奇怪地址后带着密钥发出去
async function aiChatNonStream(url, headers, body, u = null) {
  if (window.electronAPI?.aiFetch) {
    const res = await window.electronAPI.aiFetch({url, headers, body});
    if (!res.ok) throw new Error(res.error || res.data?.error?.message || `HTTP ${res.status}`);
    return res.data;
  }
  if (!u) { try { u = new URL(url); } catch { throw new Error('Base URL 无效 · Invalid Base URL'); } }
  const host = u.hostname.toLowerCase();
  if (u.protocol === 'https:') { /* 任意 https 放行 */ }
  else if (u.protocol === 'http:' && (host === 'localhost' || host === '::1' || /^127\./.test(host))) {
    // 回环地址也限制端口：与 electron/main.cjs 的 LOCAL_PORTS 保持一致
    if (!LOCAL_PORTS.has(Number(u.port) || 0)) {
      throw new Error(`本机 http 仅允许常见本地服务端口（${[...LOCAL_PORTS].sort((a, b) => a - b).join(' / ')}）· Local port not allowed`);
    }
  }
  else if (u.protocol === 'http:') throw new Error('明文 http 仅允许本机地址（localhost / 127.0.0.1 / ::1）· Plain http only for local addresses');
  else throw new Error('仅允许 http(s) 地址 · Only http(s) URLs are allowed');
  const res = await fetch(u, {method: 'POST', headers, body: JSON.stringify(body)});
  const data = await res.json().catch(() => null);
  if (!res.ok) throw new Error(data?.error?.message || `HTTP ${res.status}`);
  return data;
}

// —— 文件工具协议：main.jsx 把读写接口挂到 aiRuntime；AI 通过 tool_calls 增删改查 ——
export const aiRuntime = {getContext: null, ops: null, toast: null};
const AI_TOOLS = [
  {type: 'function', function: {name: 'list_files', description: '列出知识库全部文章、草稿与方法笔记（仅 id、类型、标题、字数）', parameters: {type: 'object', properties: {}}}},
  {type: 'function', function: {name: 'read_file', description: '读取一个文件的完整正文', parameters: {type: 'object', properties: {id: {type: 'string', description: '文件 id，来自 list_files'}}, required: ['id']}}},
  {type: 'function', function: {name: 'search_files', description: '按关键词搜索文件标题与正文', parameters: {type: 'object', properties: {q: {type: 'string'}}, required: ['q']}}},
  {type: 'function', function: {name: 'create_file', description: '新建文章 / 草稿 / 方法笔记，返回新 id', parameters: {type: 'object', properties: {
    kind: {type: 'string', enum: ['post', 'draft', 'note']}, title: {type: 'string'}, body: {type: 'string'}, tags: {type: 'array', items: {type: 'string'}}}, required: ['kind', 'title']}}},
  {type: 'function', function: {name: 'update_file', description: '更新文件标题或正文（全量覆盖正文，先 read_file 再改）', parameters: {type: 'object', properties: {
    id: {type: 'string'}, title: {type: 'string'}, body: {type: 'string'}}, required: ['id']}}},
  {type: 'function', function: {name: 'delete_file', description: '删除文件；执行时软件会向用户弹出确认框', parameters: {type: 'object', properties: {
    id: {type: 'string'}}, required: ['id']}}},
  {type: 'function', function: {name: 'save_memory', description: '把需要跨会话记住的用户偏好、设定或事实存进本地长期记忆（之后的对话会自动携带）', parameters: {type: 'object', properties: {
    text: {type: 'string', description: '要记住的一条内容（一句话到一段话）'}}, required: ['text']}}},
  {type: 'function', function: {name: 'forget_memory', description: '按 id 删除一条长期记忆', parameters: {type: 'object', properties: {
    id: {type: 'string'}}, required: ['id']}}},
];
async function runTool(name, args = {}) {
  const ops = aiRuntime.ops;
  if (!ops) return {error: '文件操作不可用'};
  try {
    if (name === 'list_files') return {files: ops.list()};
    if (name === 'read_file') return ops.read(String(args.id || '')) || {error: `找不到文件 ${args.id}`};
    if (name === 'search_files') return {matches: ops.search(String(args.q || ''))};
    if (name === 'create_file') return ops.create(String(args.kind || ''), args);
    if (name === 'update_file') return ops.update(String(args.id || ''), args);
    if (name === 'delete_file') return ops.remove(String(args.id || ''));
    if (name === 'save_memory') { const e = saveAiMemory(String(args.text || '')); return e ? {ok: true, id: e.id} : {error: '内容为空'}; }
    if (name === 'forget_memory') { forgetAiMemory(String(args.id || '')); return {ok: true}; }
    return {error: `未知工具 ${name}`};
  } catch (e) { return {error: String(e?.message || e)}; }
}

// —— 对话单例：dock（工作台）与浮动面板共享同一条会话 ——
const CHAT_KEY = CONFIG.storagePrefix + '-ai-chat-v1';
function loadChat() { try { const v = JSON.parse(localStorage.getItem(CHAT_KEY)); return Array.isArray(v) ? v : []; } catch { return []; } }
let chatLog = loadChat();
let busy = false, chatErr = '';
const chatSubs = new Set(), busySubs = new Set(), errSubs = new Set();
const notify = subs => { for (const f of subs) f(); };
function persistChat() { try { localStorage.setItem(CHAT_KEY, JSON.stringify(chatLog.slice(-60))); } catch {} }
function pushMsg(m) { chatLog = [...chatLog, {...m, ts: Date.now()}].slice(-60); persistChat(); notify(chatSubs); }
export const useAiChat = () => {
  const [msgs, setMsgs] = useState(chatLog);
  useEffect(() => { const f = () => setMsgs(chatLog); chatSubs.add(f); return () => { chatSubs.delete(f); }; }, []);
  return msgs;
};
export const useAiBusy = () => {
  const [b, setB] = useState(busy);
  useEffect(() => { const f = () => setB(busy); busySubs.add(f); return () => { busySubs.delete(f); }; }, []);
  return b;
};
export const useAiErr = () => {
  const [e, setE] = useState(chatErr);
  useEffect(() => { const f = () => setE(chatErr); errSubs.add(f); return () => { errSubs.delete(f); }; }, []);
  return e;
};
export function clearAiChat() { chatLog = []; chatErr = ''; persistChat(); notify(chatSubs); notify(errSubs); }

// —— 流式草稿：aiSend 请求期间把模型逐字输出广播给 UI（「思考中」气泡原地变成实时文本）。
// rAF 合帧：SSE chunk 可能每秒几十次，逐次 setState 会让消息列表高频重渲染；
// 隐藏时 rAF 停转，流结束的 finally 里同步 flush 兜底 ——
let streamText = '', streamPending = '', streamRaf = 0;
const streamSubs = new Set();
function streamPublish(text) {
  streamPending = text;
  if (streamRaf) return;
  streamRaf = requestAnimationFrame(() => {
    streamRaf = 0;
    streamText = streamPending;
    for (const f of streamSubs) f(streamText);
  });
}
function streamFlush() {
  if (streamRaf) { cancelAnimationFrame(streamRaf); streamRaf = 0; }
  streamText = streamPending;
  for (const f of streamSubs) f(streamText);
}
export function useAiStream() {
  const [t, setT] = useState(streamText);
  useEffect(() => { const f = v => setT(v); streamSubs.add(f); return () => { streamSubs.delete(f); }; }, []);
  return t;
}

// —— 「选中 AI 菜单」预填通道：编辑器把动作提示写进草稿，AI 输入框消费后自动清空；
// auto 为 true 时预填即自动发送（润色之外的动作都是一步直达） ——
let aiDraft = '';
let aiDraftAuto = false;
const draftSubs = new Set();
export function setAiDraft(text, auto) {
  aiDraft = String(text || '');
  aiDraftAuto = !!auto;
  for (const f of draftSubs) f(aiDraft);
}
export function useAiDraft() {
  const [v, setV] = useState(aiDraft);
  useEffect(() => { const f = t => setV(t); draftSubs.add(f); return () => { draftSubs.delete(f); }; }, []);
  return v;
}
// 唤起 AI 面板：非工作台页面打开浮动面板；工作台的 dock 常驻，只需聚焦输入框。
export const openAiPanel = () => window.dispatchEvent(new CustomEvent('dn-ai-open'));

function buildSystem(ctx = {}) {
  const persona = aiPersona.get();
  const personaText = persona?.enabled ? String(persona.text || '').trim().slice(0, 2000) : ''; // 人设限长：超长人设会撑爆每次请求的上下文
  const mem = aiMemoryPrompt();
  const lines = [
    '你是「创作神经网络看板」笔记软件内置的 AI 助手。用户的全部数据（文章、草稿、方法笔记、选题）都保存在本机。',
    personaText ? `用户为你设定的人设（回答风格与立场优先遵循它）：${personaText}` : '',
    `当前界面：${ctx.page || '未知'}${ctx.title ? `；用户正在查看/编辑《${ctx.title}》` : ''}${ctx.excerpt ? `，正文节选：「${ctx.excerpt}」` : ''}。`,
    mem ? `你的本地长期记忆（跨会话保留；新的重要偏好/事实可用 save_memory 工具追加）：\n${mem}` : '',
    ctx.brief || '',
    '规则：用用户的语言（默认简体中文）简洁作答；需要读写文件时先 list_files / read_file 了解现状再动手；update_file 是全量覆盖正文，改动前先读取原文；delete_file 会向用户弹出确认框；写长文前先读长期记忆与相关旧文，保持人设与既往设定一致；不确定时先问用户，不要编造文件 id。',
  ];
  return lines.filter(Boolean).join('\n');
}

export async function aiSend(text) {
  const q = String(text || '').trim();
  if (!q || busy) return;
  if (!isNetworkOn()) { chatErr = '顶栏联网开关未打开，AI 不会发起请求 · Network switch is off'; notify(errSubs); return; }
  const cfg = aiState, p = providerOf(cfg);
  if (p.needKey !== false && !cfg.apiKey) { chatErr = '先在模型按钮里填 API Key · API key missing'; notify(errSubs); return; }
  chatErr = ''; notify(errSubs);
  pushMsg({role: 'user', content: q});
  const sys = {role: 'system', content: buildSystem(typeof aiRuntime.getContext === 'function' ? aiRuntime.getContext() : {})};
  // 上下文放宽：长文写作需要更多历史（24 轮）与更长的工具结果（12k 字符）
  const convo = chatLog.filter(m => m.role === 'user' || m.role === 'assistant').slice(-24).map(m => ({role: m.role, content: m.content}));
  busy = true; notify(busySubs);
  // onDelta 收到的是增量片段：累积成完整草稿再发布（streamPublish 是覆盖语义）
  let draft = '';
  const onDelta = d => { draft += d; streamPublish(draft); };
  draft = ''; streamPublish(''); // 清空上一轮的流式草稿，「思考中」气泡就位
  try {
    for (let round = 0; round < 6; round++) {
      draft = ''; streamPublish(''); // 工具轮之间也重置：上一轮草稿不残留
      const data = await aiChat([sys, ...convo], {onDelta});
      const m = data?.choices?.[0]?.message;
      if (!m) throw new Error(data?.error?.message || '模型没有返回内容 · Empty response');
      if (Array.isArray(m.tool_calls) && m.tool_calls.length) {
        convo.push({role: 'assistant', content: m.content || '', tool_calls: m.tool_calls});
        for (const tc of m.tool_calls) {
          let args = {};
          try { args = JSON.parse(tc.function?.arguments || '{}'); } catch {}
          const out = await runTool(tc.function?.name, args);
          pushMsg({role: 'op', text: opBrief(tc.function?.name, args, out)});
          convo.push({role: 'tool', tool_call_id: tc.id, content: JSON.stringify(out).slice(0, 12000)});
        }
        streamPublish(''); // 工具轮的草稿不固化为正式消息，清空等下一轮
        continue;
      }
      pushMsg({role: 'assistant', content: m.content || '（空回复）'});
      return;
    }
    chatErr = '工具调用轮次过多，已停止 · Too many tool rounds'; notify(errSubs);
  } catch (e) {
    chatErr = `AI 请求失败：${e?.message || e}`; notify(errSubs);
  } finally {
    streamPublish(''); // 清空流式草稿（正式消息已入列 / 出错时只留报错）
    streamFlush();
    busy = false; notify(busySubs);
  }
}
// 工具记录的用户可读一行
function opBrief(name, args, out) {
  const t = args?.title ? `《${args.title}》` : '';
  if (name === 'list_files') return `读取了文件清单（${out?.files?.length ?? 0} 个文件）`;
  if (name === 'read_file') return `读取了《${out?.title || args?.id || ''}》`;
  if (name === 'search_files') return `搜索「${args?.q || ''}」（${out?.matches?.length ?? 0} 个结果）`;
  if (name === 'create_file') return out?.error ? `创建失败：${out.error}` : `新建了${t || '文件'}（${out?.id || ''}）`;
  if (name === 'update_file') return out?.error ? `更新失败：${out.error}` : `更新了《${out?.title || args?.id || ''}》`;
  if (name === 'delete_file') return out?.error ? `删除失败：${out.error}` : `删除了《${out?.title || args?.id || ''}》`;
  if (name === 'save_memory') return out?.error ? '记忆保存失败' : `记住了：${String(args?.text || '').slice(0, 50)}${String(args?.text || '').length > 50 ? '…' : ''}`;
  if (name === 'forget_memory') return '删除了一条长期记忆';
  return name;
}

// —— AI 模型按钮：chip + popover，样式与交互参考 DeepSeek Harness 的 InlineModelSwitcher ——
// 弹层按「服务商与模型 / 推理等级 / 密钥 / 人设 / 长期记忆」分区展示（带小节标题与分隔），
// 芯片本体同时显示推理等级徽标——只看顶栏也能确认当前生效的推理档位
export function AiChip() {
  const {on} = usePlugins();
  const [cfg, setCfg] = useAiConfig();
  const {on: net} = useNetwork();
  const [open, setOpen] = useState(false);
  const wrap = useRef(null);
  // 人设与长期记忆：本地保存（连库时随 meta.json 走），随时启停
  const persona = aiPersona.use();
  const memory = aiMemory.use();
  const memList = Array.isArray(memory.list) ? memory.list : [];
  const [personaDraft, setPersonaDraft] = useState(null); // null = 未编辑，显示已存版本
  const [personaSaved, setPersonaSaved] = useState(false); // 保存成功的瞬时反馈
  const personaSavedTimer = useRef(null);
  const [memOpen, setMemOpen] = useState(false);
  const [memDraft, setMemDraft] = useState('');
  const mdImport = useRef(null);
  useEffect(() => () => clearTimeout(personaSavedTimer.current), []);
  const savePersona = () => {
    if (personaDraft == null) return;
    aiPersona.write({...persona, enabled: persona?.enabled ?? true, text: (personaDraft || '').slice(0, 2000)});
    setPersonaDraft(null);
    setPersonaSaved(true);
    clearTimeout(personaSavedTimer.current);
    personaSavedTimer.current = setTimeout(() => setPersonaSaved(false), 1800);
  };
  const onImportMd = async e => {
    const f = e.target.files?.[0];
    e.target.value = '';
    if (!f) return;
    try {
      const text = await f.text();
      // 按标题切块入库（无标题整篇作一条，超长由 saveAiMemory 截断）
      const chunks = text.split(/\n(?=#{1,3} )/).map(s => s.trim()).filter(s => s.length > 10);
      let n = 0;
      if (chunks.length) for (const c of chunks.slice(0, 50)) { saveAiMemory(c); n += 1; }
      else { saveAiMemory(text); n = 1; }
      window.showGlobalNotice?.(`已把 ${n} 条内容存入 AI 长期记忆 · ${n} memories imported`);
    } catch (err) { window.showGlobalNotice?.(`导入失败：${err?.message || err}`); }
  };
  useEffect(() => {
    if (!open) return;
    const away = e => { if (!wrap.current?.contains(e.target)) setOpen(false); };
    const esc = e => { if (e.key === 'Escape' && !e.isComposing) setOpen(false); };
    document.addEventListener('mousedown', away);
    document.addEventListener('keydown', esc);
    return () => { document.removeEventListener('mousedown', away); document.removeEventListener('keydown', esc); };
  }, [open]);
  if (!on('ai')) return null;
  const p = providerOf(cfg);
  const gear = effectiveGear(cfg);
  const gearOf = AI_GEARS.find(g => g.id === gear);
  // 芯片显示「实际生效」的模型：DeepSeek 退役旧值归一为 v4-flash
  const model = effectiveModel(cfg) || '未设置模型';
  const personaText = personaDraft ?? String(persona?.text || '');
  const noteKind = !net ? 'off' : secureWarn ? 'warn' : p.needKey !== false && !cfg.apiKey ? 'warn' : 'ok';
  const pick = id => {
    const np = AI_PROVIDERS.find(x => x.id === id);
    setCfg(id === 'custom'
      ? {provider: id}
      : {provider: id, baseUrl: np.baseUrl || '', model: np.models[0] || ''});
  };
  return <span className="ai-chip-wrap" ref={wrap}>
    <button type="button" className={`ai-chip ${open ? 'open' : ''}`} aria-expanded={open} aria-haspopup="dialog"
      title="选择 AI 服务商、模型与推理等级 · Pick provider, model & reasoning" onClick={() => setOpen(o => !o)}>
      <Icon name="agent" size={13}/><span className="ai-chip-mode">{p.name}</span>
      <i className="ai-chip-sep" aria-hidden="true"/><span className="ai-chip-model">{model}</span>
      {gear !== 'off' && <span className="ai-chip-gear" title={gearOf?.title}>{gearOf?.zh}</span>}
      <Icon name="chevron" size={10}/>
    </button>
    {open && <div className="ai-pop glass" role="dialog" aria-label="AI 服务商设置 Provider settings">
      <header className="ai-pop-head">
        <b>AI 模型设置</b><em>Model settings</em>
        <span className={`ai-net ${net ? 'on' : ''}`} title={net ? '顶栏联网开关已打开' : '顶栏联网开关未打开，AI 不会发起任何请求'}>
          <i aria-hidden="true"/>{net ? '联网已开' : '断网中'}
        </span>
      </header>

      <section className="ai-sec">
        <p className="ai-sec-title">服务商 <em>Provider</em></p>
        <div className="ai-providers" role="tablist">{AI_PROVIDERS.map(x =>
          <button key={x.id} type="button" role="tab" aria-selected={x.id === cfg.provider}
            className={x.id === cfg.provider ? 'is-active' : ''} title={x.note || x.name}
            onClick={() => pick(x.id)}>{x.name}</button>)}</div>
        {p.customModel
          ? <input className="ai-model-input" value={cfg.model || ''} placeholder="模型名 · model id" aria-label="模型名 Model id"
              onChange={e => setCfg({model: e.target.value})}/>
          : <select className="ai-model-input" value={model} aria-label="选择模型 Model" onChange={e => setCfg({model: e.target.value})}>
              {p.models.map(m => <option key={m} value={m}>{modelLabel(p, m)}</option>)}
              {!p.models.includes(model) && <option value={model}>{modelLabel(p, model)}</option>}
            </select>}
      </section>

      <section className="ai-sec">
        <p className="ai-sec-title">推理等级 <em>Reasoning</em></p>
        <div className="ai-seg" role="tablist">
          {AI_GEARS.map(g => <button key={g.id} type="button" role="tab" aria-selected={gear === g.id}
            className={gear === g.id ? 'is-active' : ''} title={g.title} onClick={() => setCfg({gear: g.id})}>{g.zh} <em>{g.en}</em></button>)}
        </div>
      </section>

      {p.needKey !== false && <section className="ai-sec">
        <p className="ai-sec-title">API Key</p>
        <input type="password" value={cfg.apiKey || ''} placeholder="sk-…" aria-label="API Key"
          autoComplete="off" onChange={e => setCfg({apiKey: e.target.value})}/>
      </section>}

      {p.id === 'custom' && <section className="ai-sec">
        <p className="ai-sec-title">Base URL</p>
        <input value={cfg.baseUrl || ''} placeholder="https://…/v1" aria-label="Base URL"
          onChange={e => setCfg({baseUrl: e.target.value})}/>
      </section>}

      <section className="ai-sec">
        <p className="ai-sec-title">人设 <em>Persona</em>
          <label className="ai-persona-toggle" title="启用后 AI 的回答风格与立场优先遵循人设">
            <input type="checkbox" checked={!!persona?.enabled} onChange={e => aiPersona.write({...persona, enabled: e.target.checked})}/>
            <i className="ai-switch-track" aria-hidden="true"><b/></i>
            {persona?.enabled ? '已启用' : '已停用'}
          </label>
        </p>
        <textarea rows={3} value={personaText} aria-label="AI 人设" maxLength={2000}
          placeholder="例如：你是我的写作教练，风格犀利直接，多给例子，少客套…（启用后注入每次对话）"
          onChange={e => setPersonaDraft(e.target.value)}/>
        <div className="ai-persona-foot">
          <span className="ai-count">{personaText.length}/2000{personaDraft != null ? ' · 未保存' : ''}</span>
          {personaSaved
            ? <span className="ai-saved" role="status">已保存 ✓</span>
            : <button type="button" className="pill" disabled={personaDraft == null} onClick={savePersona}>保存人设 <em>Save</em></button>}
        </div>
      </section>

      <section className="ai-sec">
        <p className="ai-sec-title">长期记忆 <em>Memory</em>
          <span className="ai-mem-count">{memList.length} 条</span>
          <button type="button" className="ai-mini" onClick={() => setMemOpen(o => !o)} aria-expanded={memOpen}>{memOpen ? '收起' : '管理'}</button>
          <button type="button" className="ai-mini" onClick={() => mdImport.current?.click()} title="把一个 .md 的章节逐条存入长期记忆">导入 .md</button>
          <input ref={mdImport} type="file" accept=".md,.markdown,.txt" hidden onChange={onImportMd} aria-hidden="true"/>
        </p>
        {memOpen && <div className="ai-mem-list">
          {[...memList].reverse().slice(0, 12).map(m => <div key={m.id} className="ai-mem-item">
            <span>{String(m.text || '').slice(0, 90)}{String(m.text || '').length > 90 ? '…' : ''}</span>
            <button type="button" aria-label={`删除记忆 ${m.id}`} title="删除" onClick={() => forgetAiMemory(m.id)}>×</button>
          </div>)}
          {memList.length > 12 && <p className="ai-mem-empty">只显示最近 12 条 · 共 {memList.length} 条，都会注入对话（总长超限时优先保留最新）</p>}
          {!memList.length && <p className="ai-mem-empty">还没有记忆。AI 对话中让它「记住这个」会自动存入；也可在下面手动添加，或导入 .md。</p>}
          <div className="ai-mem-add">
            <input value={memDraft} placeholder="手动添加一条记忆…" aria-label="手动添加记忆"
              onChange={e => setMemDraft(e.target.value)}
              onKeyDown={e => { if (e.key === 'Enter' && !e.isComposing && memDraft.trim()) { saveAiMemory(memDraft); setMemDraft(''); } }}/>
            <button type="button" className="send" disabled={!memDraft.trim()} aria-label="添加记忆"
              onClick={() => { if (memDraft.trim()) { saveAiMemory(memDraft); setMemDraft(''); } }}>＋</button>
          </div>
        </div>}
      </section>

      <p className={`ai-note is-${noteKind}`} role="status">
        {!net ? '顶栏联网开关未打开，AI 不会发起任何请求 · Network switch is off'
          : secureWarn ? '本机安全存储不可用，密钥本次只留在内存、没有保存，重启后需重填 · Secure storage unavailable'
          : p.needKey !== false && !cfg.apiKey ? '还没有填 API Key · API key missing'
          : p.note || 'OpenAI 兼容协议 · OpenAI-compatible API'}
      </p>
    </div>}
  </span>;
}

// —— 消息流：dock 与浮动面板共用。助手回复按 Markdown 渲染（加粗 / 列表 / 代码块），
// 新消息自动滚动到底；onJump 用于把回复里的 [[双链]] 解析成节点跳转（工作台 dock 传入） ——
// 单条助手消息 memo 化：busy 状态翻转（「思考中」出现/消失）时不再重渲染全部历史消息的 Markdown
const AiMsgItem = React.memo(function AiMsgItem({m}) {
  return <div className={`ai-msg ${m.role}`}>
    <span className="ai-who">{m.role === 'user' ? '我' : 'AI'}</span>
    {m.role === 'assistant'
      ? <div className="ai-body md" dangerouslySetInnerHTML={{__html: renderMarkdown(m.content)}}/>
      : <p>{m.content}</p>}
  </div>;
});

export function AiMsgs({empty, onJump}) {
  const msgs = useAiChat();
  const busy = useAiBusy();
  const err = useAiErr();
  const streamText = useAiStream(); // 流式期间模型逐字输出（纯文本上屏，结束后才整条 Markdown 渲染）
  const box = useRef(null);
  useEffect(() => { const el = box.current; if (el) el.scrollTop = el.scrollHeight; }, [msgs, busy, streamText]);
  const jump = e => {
    const a = e.target.closest('a[data-target]');
    if (a) onJump(a.dataset.target);
  };
  return <>
    <div className="ai-msgs" ref={box} aria-live="polite" onClick={onJump ? jump : undefined}>
      {!msgs.length && <p className="ai-empty">{empty || '向 AI 提问，或让它直接帮你读写文章、草稿与笔记。'}</p>}
      {msgs.map((m, i) => m.role === 'op'
        ? <p key={i} className="ai-op"><Icon name="check" size={11}/>{m.text}</p>
        : <AiMsgItem key={i} m={m}/>)}
      {busy && (streamText
        ? <div className="ai-msg assistant streaming"><span className="ai-who">AI</span><p className="ai-stream-text">{streamText}<i className="ai-stream-caret" aria-hidden="true"/></p></div>
        : <div className="ai-msg assistant pending"><span className="ai-who">AI</span><p>思考中… <em>thinking</em></p></div>)}
    </div>
    {err && <p className="ai-err" role="alert">{err}</p>}
  </>;
}

export function AiInput({placeholder}) {
  const [q, setQ] = useState('');
  const busy = useAiBusy();
  const inp = useRef(null);
  // 「选中 AI 菜单」：编辑器发来的预填草稿写入输入框并聚焦，消费后清空；auto 标记的立即发送
  const draft = useAiDraft();
  useEffect(() => {
    if (!draft) return;
    const auto = aiDraftAuto;
    setQ(draft);
    setAiDraft('');
    if (auto) aiSend(draft);
    else inp.current?.focus();
  }, [draft]);
  const submit = e => { e.preventDefault(); if (!q.trim() || busy) return; aiSend(q); setQ(''); };
  return <form className="ai-input" onSubmit={submit}>
    <input ref={inp} value={q} onChange={e => setQ(e.target.value)} placeholder={placeholder || '让 AI 帮你写、改、查… Ask AI to write, edit or look up'} aria-label="向 AI 提问"/>
    <button className="send" disabled={busy || !q.trim()} aria-label="发送给 AI"><Icon name="send" size={15}/></button>
  </form>;
}

// —— 工作台 dock 内嵌的 AI 对话（插件启用时替换本地检索卡片区） ——
export function AiDockChat({onClose, graph, onGo}) {
  const [cfg] = useAiConfig();
  const p = providerOf(cfg);
  const byName = useMemo(() => (graph ? nameIndex(graph.nodes) : null), [graph]);
  const jump = name => {
    const id = byName && byName.get(String(name).toLowerCase());
    if (id && onGo) onGo(id);
  };
  return <section className="ask-results glass ai-dock-chat" aria-live="polite">
    <header>
      <span><Icon name="agent" size={14}/>AI 助手 <em>AI assistant</em></span>
      <small>{p.name} · {effectiveModel(cfg)}</small>
      <button type="button" className="ai-clear" title="清空对话 Clear chat" onClick={clearAiChat}>清空 <em>Clear</em></button>
      {onClose && <button className="icon-btn" aria-label="关闭对话" onClick={onClose}><Icon name="close" size={14}/></button>}
    </header>
    <AiMsgs onJump={byName && onGo ? jump : undefined}/>
    <AiInput/>
  </section>;
}

// —— 其他页面的浮动按钮 + 面板：任意界面都能唤起同一个 AI 对话 ——
export function AiFab() {
  const {on} = usePlugins();
  const [open, setOpen] = useState(false);
  const [cfg] = useAiConfig();
  const p = providerOf(cfg);
  // 「选中即问」等场景经 dn-ai-open 事件唤起面板
  useEffect(() => {
    const f = () => setOpen(true);
    window.addEventListener('dn-ai-open', f);
    return () => window.removeEventListener('dn-ai-open', f);
  }, []);
  if (!on('ai')) return null;
  return <>
    <button className={`ai-fab ${open ? 'open' : ''}`} aria-label={open ? '关闭 AI 助手 Close AI assistant' : '打开 AI 助手 Open AI assistant'}
      title="AI 助手 · AI assistant" aria-expanded={open} onClick={() => setOpen(o => !o)}>
      <Icon name={open ? 'close' : 'agent'} size={17}/>
    </button>
    {open && <section className="ai-panel glass" role="dialog" aria-label="AI 助手 AI assistant">
      <header>
        <span><Icon name="agent" size={14}/>AI 助手 <em>AI assistant</em></span>
        <small>{p.name} · {effectiveModel(cfg)}</small>
        <button type="button" className="ai-clear" title="清空对话 Clear chat" onClick={clearAiChat}>清空 <em>Clear</em></button>
      </header>
      <AiMsgs/>
      <AiInput/>
    </section>}
  </>;
}

// 供 dock 判断：AI 会话是否接管输入框提交
export const aiEnabled = on => on('ai') && isNetworkOn();
