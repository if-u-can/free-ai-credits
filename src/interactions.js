import catalogue from '../data/eggs.json' with { type: 'json' };

const eggs = new Map(catalogue.eggs.map(egg => [egg.id, egg]));
const MAX_BODY_BYTES = 4096;
const MAX_UPSTREAM_BYTES = 65536;

function json(value, status = 200, headers = {}) {
  return new Response(JSON.stringify(value), { status, headers: {
    'content-type': 'application/json;charset=utf-8', 'cache-control': 'no-store',
    'x-content-type-options': 'nosniff', ...headers
  } });
}
function error(code, message, status, headers) { return json({ available: false, code, message }, status, headers); }
function googleURL(value) {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && url.hostname === 'script.google.com' && !url.port
      && !url.username && !url.password && !url.search && !url.hash
      && /^\/macros\/s\/[A-Za-z0-9_-]+\/exec$/.test(url.pathname);
  } catch { return false; }
}
function configured(env) {
  return !!(googleURL(env.INTERACTIONS_GOOGLE_URL)
    && typeof env.INTERACTIONS_GOOGLE_SECRET === 'string' && env.INTERACTIONS_GOOGLE_SECRET.length >= 32
    && typeof env.INTERACTIONS_ID_SECRET === 'string' && env.INTERACTIONS_ID_SECRET.length >= 32
    && ((!env.INTERACTIONS_TURNSTILE_SITE_KEY && !env.INTERACTIONS_TURNSTILE_SECRET)
      || (env.INTERACTIONS_TURNSTILE_SITE_KEY && env.INTERACTIONS_TURNSTILE_SECRET)));
}
const unavailable = () => error('unavailable', '社区反馈暂未开通或服务不可用，请稍后再试。', 503);

async function hmac(value, secret) {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(value)));
}
async function identity(request, env) {
  // Cloudflare overwrites this at its edge. Never trust X-Forwarded-For or client IDs.
  const ip = request.headers.get('CF-Connecting-IP');
  if (!ip || ip.length > 64 || !/^[a-fA-F0-9:.]+$/.test(ip)) return null;
  const hash = await hmac('egg-voter-v1:' + ip.toLowerCase(), env.INTERACTIONS_ID_SECRET);
  return Array.from(hash, b => b.toString(16).padStart(2, '0')).join('');
}

async function bodyJSON(request, limit = MAX_BODY_BYTES) {
  if (Number(request.headers.get('content-length') || 0) > limit) return { tooLarge: true };
  if (!request.body) return { invalid: true };
  const reader = request.body.getReader();
  const chunks = []; let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > limit) { await reader.cancel(); return { tooLarge: true }; }
      chunks.push(value);
    }
    const bytes = new Uint8Array(size); let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
    return { value: JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)) };
  } catch { return { invalid: true }; }
}

function state(value) {
  if (!value || !Number.isSafeInteger(value.good) || value.good < 0 || !Number.isSafeInteger(value.bad) || value.bad < 0
    || ![null, 'good', 'bad'].includes(value.myVote) || typeof value.reviewPending !== 'boolean'
    || !(value.reviewRequestedAt === null || (typeof value.reviewRequestedAt === 'string'
      && /^\d{4}-\d{2}-\d{2}T/.test(value.reviewRequestedAt) && Number.isFinite(Date.parse(value.reviewRequestedAt))))
    || !(value.lastVerified === null || (typeof value.lastVerified === 'string'
      && /^\d{4}-\d{2}-\d{2}$/.test(value.lastVerified) && Number.isFinite(Date.parse(value.lastVerified))))
    || (value.reviewPending && value.reviewRequestedAt === null)
    || (value.myVote === 'good' && value.good === 0) || (value.myVote === 'bad' && value.bad === 0)) throw Error('Invalid storage state');
  return { good: value.good, bad: value.bad, myVote: value.myVote, reviewPending: value.reviewPending,
    reviewRequestedAt: value.reviewRequestedAt, lastVerified: value.lastVerified };
}

async function google(env, action, ids = [], voterHash = null, voteData = {}) {
  const payload = JSON.stringify({ version: 1, action, timestamp: Date.now(), requestId: crypto.randomUUID(), voterHash,
    ids, dates: Object.fromEntries(ids.map(id => [id, eggs.get(id).verified_at ?? null])), ...voteData });
  const signature = btoa(String.fromCharCode(...await hmac(payload, env.INTERACTIONS_GOOGLE_SECRET)));
  const response = await fetch(env.INTERACTIONS_GOOGLE_URL, { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ payload, signature }), redirect: 'follow', signal: AbortSignal.timeout(12000) });
  if (!response.ok || (response.headers.get('content-type') || '').split(';')[0].trim().toLowerCase() !== 'application/json') throw Error('Storage unavailable');
  const parsed = await bodyJSON(response, MAX_UPSTREAM_BYTES);
  if (parsed.invalid || parsed.tooLarge || !parsed.value || typeof parsed.value.available !== 'boolean') throw Error('Invalid storage response');
  return parsed.value;
}

function googleFailure(result) {
  const retry = Number.isSafeInteger(result.retryAfter) && result.retryAfter > 0 && result.retryAfter <= 3600
    ? { 'retry-after': String(result.retryAfter) } : {};
  if (result.code === 'rate_limited' && result.status === 429) return error('rate_limited', '反馈过于频繁，请稍后再试。', 429, retry);
  if (result.code === 'busy' && result.status === 503) return error('busy', '社区计票服务正在处理其他任务，请稍后重试。', 503, retry);
  return unavailable();
}

async function turnstile(request, env, token, url) {
  if (!env.INTERACTIONS_TURNSTILE_SITE_KEY) return true;
  const params = new URLSearchParams({ secret: env.INTERACTIONS_TURNSTILE_SECRET, response: token });
  params.set('remoteip', request.headers.get('CF-Connecting-IP'));
  try {
    const response = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', {
      method: 'POST', body: params, signal: AbortSignal.timeout(8000)
    });
    if (!response.ok) return false;
    const result = await response.json();
    return result.success === true && result.hostname === url.hostname && result.action === 'egg-vote';
  } catch { return false; }
}

export async function handleInteractions(request, env) {
  const url = new URL(request.url), path = url.pathname;
  const isVote = path === '/api/interactions/vote';
  if (!['/api/interactions', '/api/interactions/config', '/api/interactions/vote'].includes(path)) return error('not_found', '接口不存在。', 404);
  if (request.method !== (isVote ? 'POST' : 'GET')) return error('method_not_allowed', '请求方法不支持。', 405, { allow: isVote ? 'POST' : 'GET' });
  if (path === '/api/interactions/config') {
    let available = configured(env);
    if (available) {
      try { available = (await google(env, 'health')).available === true; }
      catch { available = false; }
    }
    return json({ available, ...(available && env.INTERACTIONS_TURNSTILE_SITE_KEY ? { turnstileSiteKey: env.INTERACTIONS_TURNSTILE_SITE_KEY } : {}) });
  }
  if (!configured(env)) return unavailable();
  try {
    if (!isVote) {
      const ids = url.searchParams.get('ids')?.split(',') ?? [];
      if (!ids.length || ids.length > 60 || ids.some(id => !eggs.has(id))) return error('invalid_ids', '请提供 1–60 个目录中真实存在的鸡蛋 ID。', 400);
      const unique = [...new Set(ids)], voter = await identity(request, env);
      const result = await google(env, 'stats', unique, voter);
      if (!result.available) return googleFailure(result);
      if (!result.eggs || typeof result.eggs !== 'object' || Array.isArray(result.eggs)) return unavailable();
      return json({ available: true, eggs: Object.fromEntries(unique.map(id => [id, state(result.eggs[id])])) });
    }
    if (request.headers.get('origin') !== url.origin || request.headers.get('sec-fetch-site') === 'cross-site') return error('invalid_origin', '请从本站提交反馈。', 403);
    if ((request.headers.get('content-type') || '').split(';')[0].trim().toLowerCase() !== 'application/json') return error('unsupported_media_type', '请使用 JSON 格式。', 415);
    const parsed = await bodyJSON(request);
    if (parsed.tooLarge) return error('payload_too_large', '请求内容太长。', 413);
    const form = parsed.value;
    if (parsed.invalid || !form || typeof form !== 'object' || Array.isArray(form) || !eggs.has(form.eggId) || !['good', 'bad'].includes(form.vote)) return error('invalid_vote', '鸡蛋 ID 或反馈选项不正确。', 400);
    if (env.INTERACTIONS_TURNSTILE_SITE_KEY && (typeof form.turnstileToken !== 'string' || !form.turnstileToken || form.turnstileToken.length > 2048)) return error('challenge_required', '请先完成人机验证。', 400);
    const voter = await identity(request, env);
    if (!voter) return error('identity_unavailable', '无法确认匿名网络身份，请稍后再试。', 503);
    if (!await turnstile(request, env, form.turnstileToken, url)) return error('challenge_failed', '人机验证失败或过期，请重新验证。', 403);
    const result = await google(env, 'vote', [form.eggId], voter, { eggId: form.eggId, vote: form.vote });
    if (!result.available) return googleFailure(result);
    if (result.egg?.id !== form.eggId || result.egg?.myVote !== form.vote) return unavailable();
    return json({ available: true, egg: { id: form.eggId, ...state(result.egg) } });
  } catch { return unavailable(); }
}
