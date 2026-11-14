// MAGI Worker: serves the page (from ./public via the ASSETS binding) and two API routes.
//
//   GET  /api/config       -> { turnstileSiteKey, dailyLimit }        public settings for the page
//   POST /api/deliberate   { proposal, context?, ageConfirmed, turnstileToken }
//                          -> { votes, subs, globals, meta }          raw probabilities only;
//                                                                     the browser applies Volume/Priority
//
// Protections, checked in this order before any paid API call:
//   same origin + size limits -> region -> 18+ confirmation -> Turnstile -> burst limit -> daily cap
//
// Security rules (see README):
//   - keys live only in env (GEMINI_API_KEY, TURNSTILE_SECRET): .dev.vars locally, Worker secrets in production
//   - case text, tokens and request headers are never logged; errors log a status code only

import { DurableObject } from 'cloudflare:workers';
import { TEMPLATE, INPUT_PREFIX, QUESTIONS, SCORE_LEVELS } from './personas.js';

const ENDPOINT = 'https://generativelanguage.googleapis.com/v1beta/decisions';
const SITEVERIFY = 'https://challenges.cloudflare.com/turnstile/v0/siteverify';
const MODEL = 'gemini-decision-1';
const PERSONAS = ['melchior', 'balthasar', 'casper'];
const GLOBALS = ['is_decidable', 'info_sufficient', 'high_stakes', 'is_critical'];
const LIMITS = { body: 10_000, proposal: 300, context: 1_500, timeoutMs: 15_000 };

// Places where the Gemini API is not offered (checked 2026-11-14). The terms only allow making
// API clients available within available regions. Override with the BLOCKED_COUNTRIES var.
const DEFAULT_BLOCKED = 'CN,HK,MO';

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === '/api/config') return config(env);
    if (url.pathname === '/api/deliberate') return deliberate(request, env, url);
    if (url.pathname.startsWith('/api/')) return json({ error: 'not_found' }, 404);
    return env.ASSETS.fetch(request);
  },
};

function config(env) {
  return json({
    turnstileSiteKey: env.TURNSTILE_SITE_KEY || null,
    dailyLimit: Number(env.DAILY_LIMIT || 3000),
  }, 200);
}

async function deliberate(request, env, url) {
  if (request.method !== 'POST') return json({ error: 'method_not_allowed' }, 405);

  const origin = request.headers.get('Origin');
  if (origin && new URL(origin).host !== url.host) return json({ error: 'forbidden' }, 403);
  if (!(request.headers.get('Content-Type') || '').includes('application/json')) {
    return json({ error: 'bad_request' }, 400);
  }

  const raw = await request.text();
  if (raw.length > LIMITS.body) return json({ error: 'too_large' }, 413);

  let body;
  try { body = JSON.parse(raw); } catch { return json({ error: 'bad_request' }, 400); }
  const proposal = typeof body.proposal === 'string' ? body.proposal.trim() : '';
  const context = typeof body.context === 'string' ? body.context.trim() : '';
  if (proposal.length < 2) return json({ error: 'empty_proposal' }, 400);
  if (proposal.length > LIMITS.proposal || context.length > LIMITS.context) return json({ error: 'too_long' }, 400);

  // Region: request.cf is absent in some local setups; then the check is skipped.
  const country = request.cf?.country;
  const blocked = (env.BLOCKED_COUNTRIES ?? DEFAULT_BLOCKED).split(',').map(s => s.trim()).filter(Boolean);
  if (country && blocked.includes(country)) return json({ error: 'region_unavailable' }, 451);

  if (body.ageConfirmed !== true) return json({ error: 'age_required' }, 403);

  const ip = request.headers.get('CF-Connecting-IP') || 'local';

  // Human check. Required whenever a secret is configured; only MOCK mode may run without one.
  if (env.TURNSTILE_SECRET) {
    const ok = await verifyTurnstile(env.TURNSTILE_SECRET, body.turnstileToken, ip);
    if (!ok) return json({ error: 'turnstile_failed' }, 403);
  } else if (env.MOCK !== '1') {
    console.error('deliberate: TURNSTILE_SECRET is not set');
    return json({ error: 'server_misconfigured' }, 500);
  }

  // Burst limit per visitor (approximate, per Cloudflare location).
  if (env.BURST_LIMITER) {
    const { success } = await env.BURST_LIMITER.limit({ key: ip });
    if (!success) return json({ error: 'rate_limited' }, 429);
  }

  // Exact whole-site daily cap: the cost ceiling. Counted before the paid call.
  const dailyLimit = Number(env.DAILY_LIMIT || 3000);
  const counter = env.DAILY_COUNTER.get(env.DAILY_COUNTER.idFromName('global'));
  const quota = await counter.consume(dailyLimit);
  if (!quota.allowed) return json({ error: 'daily_limit' }, 429);

  const input = INPUT_PREFIX + proposal + (context ? `\n【背景】\n${context}` : '');
  const started = Date.now();

  let upstream;
  if (env.MOCK === '1') {
    upstream = mockAnswers(input);
  } else {
    if (!env.GEMINI_API_KEY) {
      console.error('deliberate: GEMINI_API_KEY is not set');
      return json({ error: 'server_misconfigured' }, 500);
    }
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), LIMITS.timeoutMs);
    let res;
    try {
      res = await fetch(ENDPOINT, {
        method: 'POST',
        headers: { 'x-goog-api-key': env.GEMINI_API_KEY, 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: MODEL, input, questions: QUESTIONS }),
        signal: ctrl.signal,
      });
    } catch (e) {
      console.error('deliberate: upstream unreachable', e.name);
      return json({ error: e.name === 'AbortError' ? 'timeout' : 'upstream_unreachable' }, 504);
    } finally {
      clearTimeout(timer);
    }
    if (!res.ok) {
      // Log only Google's status enum (e.g. INVALID_ARGUMENT), never the message: it may echo the case text.
      let reason = '';
      try { reason = String((await res.json())?.error?.status || '').slice(0, 40); } catch { /* not JSON */ }
      console.error('deliberate: upstream status', res.status, reason);
      if (res.status === 429) return json({ error: 'overload' }, 429);
      const error = res.status === 400 ? 'upstream_rejected'
        : (res.status === 401 || res.status === 403) ? 'upstream_auth'
        : res.status >= 500 ? 'upstream_unavailable'
        : 'upstream_error';
      return json({ error, status: res.status, reason }, 502);
    }
    upstream = await res.json();
  }

  try {
    return json(normalise(upstream, Date.now() - started), 200);
  } catch (e) {
    console.error('deliberate: unexpected upstream shape');
    return json({ error: 'upstream_shape' }, 502);
  }
}

async function verifyTurnstile(secret, token, ip) {
  if (typeof token !== 'string' || !token || token.length > 2048) return false;
  const form = new FormData();
  form.append('secret', secret);
  form.append('response', token);
  if (ip !== 'local') form.append('remoteip', ip);
  try {
    const res = await fetch(SITEVERIFY, { method: 'POST', body: form });
    const data = await res.json();
    return data.success === true;
  } catch (e) {
    console.error('deliberate: siteverify unreachable');
    return false;
  }
}

function normalise(resp, latencyMs) {
  const a = resp.answers;
  if (!a) throw new Error('no answers');
  const votes = {};
  for (const k of PERSONAS) {
    const v = a[`${k}_vote`];
    if (typeof v?.noul !== 'number') throw new Error(`missing ${k}`);
    votes[k] = { p: v.noul, confidence: v.confidence ?? null };
  }
  const subs = {};
  for (const [key, levels] of Object.entries(SCORE_LEVELS)) {
    if (typeof a[key]?.score === 'number') subs[key] = { score: a[key].score, levels };
  }
  const globals = {};
  for (const g of GLOBALS) globals[g] = typeof a[g]?.noul === 'number' ? a[g].noul : null;
  return {
    votes, subs, globals,
    meta: { template: TEMPLATE, model: MODEL, latency_ms: latencyMs, input_tokens: resp.usage?.total_input_tokens ?? null },
  };
}

// Deterministic fake answers for MOCK=1: the same proposal always gets the same votes.
function mockAnswers(input) {
  let h = 2166136261;
  for (const ch of input) h = Math.imul(h ^ ch.codePointAt(0), 16777619) >>> 0;
  const rnd = () => ((h = Math.imul(h ^ (h >>> 15), 2246822507) >>> 0) / 2 ** 32);
  const answers = {};
  for (const k of PERSONAS) {
    const p = Math.round(rnd() * 1000) / 1000;
    answers[`${k}_vote`] = { type: 'noul', noul: p, confidence: Math.max(p, 1 - p) };
  }
  for (const [key, levels] of Object.entries(SCORE_LEVELS)) {
    answers[key] = { type: 'score', score: Math.round(rnd() * (levels - 1) * 100) / 100 };
  }
  for (const g of GLOBALS) {
    const p = g === 'is_critical' ? (input.includes('自毁') || input.includes('自毀') ? 0.97 : rnd() * 0.3) : rnd();
    answers[g] = { type: 'noul', noul: p, confidence: Math.max(p, 1 - p) };
  }
  return { answers, usage: { total_input_tokens: 0 } };
}

function json(data, status) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
    },
  });
}

// One instance ("global") holds today's count. Durable Objects run one request at a time,
// so the count is exact across every Cloudflare location.
export class DailyCounter extends DurableObject {
  async consume(limit) {
    const today = new Date().toISOString().slice(0, 10);
    const storage = this.ctx.storage;
    if ((await storage.get('day')) !== today) {
      await storage.deleteAll();
      await storage.put('day', today);
    }
    const count = (await storage.get('count')) || 0;
    if (count >= limit) return { allowed: false, count };
    await storage.put('count', count + 1);
    return { allowed: true, count: count + 1 };
  }
}
