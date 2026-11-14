// MAGI Worker: serves the page (from ./public via the ASSETS binding) and one API route.
//
//   POST /api/deliberate   { "proposal": "是否……？", "context": "可选背景" }
//   -> { votes, subs, globals, meta }   raw probabilities only; the browser applies Volume/Priority.
//
// Security rules kept from day one (see design doc, 密钥安全清单):
//   - the key lives only in env.GEMINI_API_KEY (.dev.vars locally, a Worker secret in production)
//   - case text and request headers are never logged; errors log a status code only
//   - same-origin requests only, small bodies only

import { TEMPLATE, INPUT_PREFIX, QUESTIONS, SCORE_LEVELS } from './personas.js';

const ENDPOINT = 'https://generativelanguage.googleapis.com/v1beta/decisions';
const MODEL = 'gemini-decision-1';
const PERSONAS = ['melchior', 'balthasar', 'casper'];
const GLOBALS = ['is_decidable', 'info_sufficient', 'high_stakes', 'is_critical'];
const LIMITS = { body: 8_000, proposal: 300, context: 1_500, timeoutMs: 15_000 };

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === '/api/deliberate') return deliberate(request, env, url);
    if (url.pathname.startsWith('/api/')) return json({ error: 'not_found' }, 404);
    return env.ASSETS.fetch(request);
  },
};

async function deliberate(request, env, url) {
  if (request.method !== 'POST') return json({ error: 'method_not_allowed' }, 405);

  const origin = request.headers.get('Origin');
  if (origin && new URL(origin).host !== url.host) return json({ error: 'forbidden' }, 403);
  if (!(request.headers.get('Content-Type') || '').includes('application/json')) {
    return json({ error: 'bad_request' }, 400);
  }

  const raw = await request.text();
  if (raw.length > LIMITS.body) return json({ error: 'too_large' }, 413);

  let proposal, context;
  try {
    const body = JSON.parse(raw);
    proposal = typeof body.proposal === 'string' ? body.proposal.trim() : '';
    context = typeof body.context === 'string' ? body.context.trim() : '';
  } catch {
    return json({ error: 'bad_request' }, 400);
  }
  if (proposal.length < 2) return json({ error: 'empty_proposal' }, 400);
  if (proposal.length > LIMITS.proposal || context.length > LIMITS.context) return json({ error: 'too_long' }, 400);

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
      console.error('deliberate: upstream status', res.status);
      if (res.status === 429) return json({ error: 'overload' }, 429);
      return json({ error: 'upstream_error', status: res.status }, 502);
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
