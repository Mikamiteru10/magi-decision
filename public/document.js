// MAGI page logic. Forked from itorr/magi (MIT): the WebAudio beeps, status attributes and
// config toggles are kept; the random vote is replaced by real results from /api/deliberate.
import { decide, PERSONAS, VOLUMES, PRIORITIES, RULE_LABEL } from './engine.js';

// ---------------------------------------------------------------- device quirks (original)
let device = String(navigator.userAgent.match(/steam|macos/i)).toLowerCase();
if (/iPhone|iPad|iPod/i.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1)) device = 'ios';
document.documentElement.setAttribute('data-device', device);

const $ = s => document.querySelector(s);
const bodyEl = document.body;
const finalEl = $('.final-vote-status');
const items = { melchior: $('.melchior'), balthasar: $('.malthasar'), casper: $('.casper') };
const noticeEl = $('.notice');
const panelEl = $('.case-panel');
const proposalEl = $('#proposal');
const contextEl = $('#context');

const MIN_DELIBERATION_MS = 2000;   // the API answers in ~0.4 s; the flashing needs time to read as a vote

const state = {
  volume: 50,
  priority: 'AA',
  exMode: false,
  sound: true,
  caseData: null,      // { proposal, context }
  result: null,        // last normalised API result
  busy: false,
  ageOk: false,
};

// ---------------------------------------------------------------- sound (original, lightly tidied)
let audioCtx, carrierVolume, osc, lfo, vco;
const AudioCtor = window.AudioContext || window.webkitAudioContext;
const soundEl = $('.sound');
if (!AudioCtor) soundEl.setAttribute('data-text', 'ERR');

function ensureAudio() {
  if (!audioCtx) {
    audioCtx = new AudioCtor();
    carrierVolume = audioCtx.createGain();
    carrierVolume.gain.linearRampToValueAtTime(.5, 0);
    carrierVolume.connect(audioCtx.destination);
  }
}
function playVoting() {
  if (!state.sound || !AudioCtor) return;
  ensureAudio();
  osc = audioCtx.createOscillator();
  osc.type = 'sine';
  osc.frequency.value = 2080;
  lfo = audioCtx.createOscillator();
  lfo.type = 'square';
  lfo.frequency.value = state.exMode ? 30 : 10;
  lfo.connect(carrierVolume.gain);
  osc.connect(carrierVolume);
  lfo.start(0);
  osc.start(0);
}
function playResult(hz) {
  if (!state.sound || !AudioCtor) return;
  ensureAudio();
  vco = audioCtx.createOscillator();
  vco.frequency.value = hz;
  vco.connect(carrierVolume);
  vco.start(0);
  vco.stop(audioCtx.currentTime + .8);
}
function stopAll() {
  try { osc.stop(0); lfo.stop(0); } catch (e) {}
  try { vco.stop(audioCtx.currentTime); } catch (e) {}
}
document.addEventListener('visibilitychange', () => {
  if (document.hidden) {
    stopAll();
    try { audioCtx.close(); } catch (e) {}
    audioCtx = null;
  }
});

// ---------------------------------------------------------------- case panel
function openPanel() {
  if (state.busy) return;
  if (!state.ageOk) { showAgeGate(); return; }
  panelEl.hidden = false;
  proposalEl.value = state.caseData?.proposal || '';
  contextEl.value = state.caseData?.context || '';
  proposalEl.focus();
}
function closePanel() { panelEl.hidden = true; }

$('.case-form').addEventListener('submit', e => {
  e.preventDefault();
  const proposal = proposalEl.value.trim();
  if (proposal.length < 2) { proposalEl.focus(); return; }
  state.caseData = { proposal, context: contextEl.value.trim() };
  closePanel();
  setFileLabel(proposal);
  deliberate();
});
$('.case-cancel').addEventListener('click', closePanel);
panelEl.addEventListener('click', e => { if (e.target === panelEl) closePanel(); });
panelEl.addEventListener('keydown', e => {
  if (e.key === 'Escape') closePanel();
  if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) $('.case-form').requestSubmit();
  e.stopPropagation();
});

function setFileLabel(text) {
  const short = [...text].slice(0, 14).join('') + ([...text].length > 14 ? '…' : '');
  $('.file').textContent = short;
  $('.code').textContent = codeFor(text);
}
function codeFor(text) {
  let h = 0;
  for (const ch of text) h = (h * 31 + ch.codePointAt(0)) >>> 0;
  return 100 + (h % 600);
}

// ---------------------------------------------------------------- deliberation
async function deliberate() {
  if (state.busy || !state.caseData) return;
  state.busy = true;
  noticeEl.hidden = true;
  bodyEl.setAttribute('data-status', 'voting');
  bodyEl.removeAttribute('data-vote-status');
  stopAll();
  playVoting();

  const started = performance.now();
  let result = null, error = null;
  try {
    const turnstileToken = await turnstile.token();
    const res = await fetch('/api/deliberate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...state.caseData, ageConfirmed: state.ageOk, turnstileToken }),
    });
    const data = await res.json().catch(() => ({}));
    if (res.ok) result = data; else error = data.error || `http_${res.status}`;
  } catch (e) {
    error = 'network';
  }
  turnstile.renew();   // tokens are single-use: prepare the next one
  const wait = MIN_DELIBERATION_MS - (performance.now() - started);
  if (wait > 0) await new Promise(r => setTimeout(r, wait));

  state.busy = false;
  stopAll();
  if (error) { state.result = null; renderError(error); return; }
  state.result = result;
  render(true);
}

const ERROR_TEXT = {
  overload: 'MAGI 過負荷：请求太频繁，请稍后再试。',
  rate_limited: 'MAGI 過負荷：审议太频繁，请一分钟后再试。',
  daily_limit: 'MAGI 過負荷：今日审议次数已达上限，请明天（UTC 0 点后）再来。',
  turnstile_failed: '人机验证未通过：请刷新页面后重试。',
  age_required: '需要先确认已年满 18 岁。',
  region_unavailable: '你所在的地区无法使用 Gemini API，审议功能不可用。',
  timeout: '回線途絶：模型响应超时，请重试。',
  network: '回線途絶：网络连接失败。',
  empty_proposal: '提案为空。',
  too_long: '提案或背景过长（提案 ≤ 300 字，背景 ≤ 1500 字）。',
  server_misconfigured: '服务端未配置 API Key（检查 .dev.vars）。',
};
function renderError(code) {
  bodyEl.setAttribute('data-status', 'voted');
  bodyEl.setAttribute('data-vote-status', 'error');
  finalEl.setAttribute('data-status', 'error');
  bodyEl.setAttribute('data-critical', 'false');
  $('.rule').setAttribute('data-text', '—');
  for (const k of PERSONAS) {
    items[k].setAttribute('data-status', 'error');
    items[k].querySelector('.detail').textContent = '';
  }
  showNotice(ERROR_TEXT[code] || `ERROR：${code}`);
  playResult(3400);
}

function render(withSound) {
  const r = state.result;
  if (!r) return;
  const d = decide(r, { volume: state.volume, priority: state.priority });

  for (const k of PERSONAS) {
    items[k].setAttribute('data-status', d.votes[k]);
    const p = r.votes[k].p;
    items[k].querySelector('.detail').textContent = `P ${p.toFixed(2)}`;
  }
  finalEl.setAttribute('data-status', d.final);
  bodyEl.setAttribute('data-status', 'voted');
  bodyEl.setAttribute('data-vote-status', d.final);
  bodyEl.setAttribute('data-critical', String(d.critical));
  $('.rule').setAttribute('data-text', RULE_LABEL[d.rule] + (d.critical ? '·特別議案' : ''));

  const notes = [];
  if (d.vetoBy.length) notes.push(`特別議案：${d.vetoBy.map(k => k.toUpperCase()).join('、')} 行使否決権。`);
  if (d.highStakes) notes.push('高风险议题：请同时咨询专业人士。');
  if (state.exMode && (r.globals.info_sufficient ?? 1) < 0.3) notes.push('情報不足：补充背景可提高可靠性。');
  if (notes.length) showNotice(notes.join(' ')); else noticeEl.hidden = true;

  if (withSound) playResult(d.final === 'resolve' ? 2000 : 3400);
}

function rerender() {
  if (state.result && !state.busy && bodyEl.getAttribute('data-status') === 'voted') render(false);
}

function showNotice(text) {
  noticeEl.textContent = text;
  noticeEl.hidden = false;
}

function reset() {
  stopAll();
  bodyEl.removeAttribute('data-status');
  bodyEl.removeAttribute('data-vote-status');
  noticeEl.hidden = true;
  $('.rule').setAttribute('data-text', 'AUTO');
}

// ---------------------------------------------------------------- main trigger: click or space
function trigger() {
  if (state.busy || !panelEl.hidden) return;
  if (!state.ageOk) { showAgeGate(); return; }
  if (bodyEl.getAttribute('data-status') === 'voted') { reset(); return; }
  if (!state.caseData) { openPanel(); return; }
  deliberate();
}
$('.magi-box').addEventListener('click', trigger);
window.addEventListener('keydown', e => {
  if (!panelEl.hidden || !ageEl.hidden) return;
  if (e.code === 'Space') { e.preventDefault(); trigger(); }
  if (e.key === 'Enter') { e.preventDefault(); openPanel(); }
});

// ---------------------------------------------------------------- config toggles
const stop = fn => e => { e.stopPropagation(); fn(e); };

$('.file').addEventListener('click', stop(openPanel));
$('.reset').addEventListener('click', stop(reset));
$('footer').addEventListener('click', e => e.stopPropagation());
noticeEl.addEventListener('click', e => e.stopPropagation());

soundEl.setAttribute('data-text', AudioCtor ? 'ON' : 'ERR');
soundEl.addEventListener('click', stop(() => {
  state.sound = !state.sound;
  soundEl.setAttribute('data-text', state.sound ? 'ON' : 'OFF');
  if (!state.sound) stopAll();
}));

const exEl = $('.ex-mode');
exEl.setAttribute('data-text', 'OFF');
exEl.addEventListener('click', stop(() => {
  state.exMode = !state.exMode;
  bodyEl.setAttribute('data-ex-mode', String(state.exMode));
  exEl.setAttribute('data-text', state.exMode ? 'ON' : 'OFF');
  rerender();
}));

const cycle = (list, cur) => list[(list.indexOf(cur) + 1) % list.length];

const volumeEl = $('.volume');
volumeEl.addEventListener('click', stop(() => {
  state.volume = cycle(VOLUMES, state.volume);
  volumeEl.setAttribute('data-text', state.volume);
  rerender();
}));

const priorityEl = $('.priority');
priorityEl.addEventListener('click', stop(() => {
  state.priority = cycle(PRIORITIES, state.priority);
  priorityEl.setAttribute('data-text', state.priority);
  rerender();
}));

// ---------------------------------------------------------------- 18+ confirmation
// Required by the Gemini API terms. The choice is kept only in this browser.
const ageEl = $('.age-gate');
const AGE_KEY = 'magi-age-ok-v1';
function readAgeOk() { try { return localStorage.getItem(AGE_KEY) === '1'; } catch (e) { return false; } }
function showAgeGate() { ageEl.hidden = false; $('.age-card').focus(); }   // no default button: accepting must be deliberate
$('.age-enter').addEventListener('click', () => {
  state.ageOk = true;
  try { localStorage.setItem(AGE_KEY, '1'); } catch (e) {}
  ageEl.hidden = true;
});
$('.age-leave').addEventListener('click', () => {
  $('.age-left').hidden = false;
  ageEl.querySelectorAll('button').forEach(b => { b.disabled = true; });
});
ageEl.addEventListener('click', e => e.stopPropagation());
state.ageOk = readAgeOk();
if (!state.ageOk) showAgeGate();

// ---------------------------------------------------------------- Cloudflare Turnstile
// Invisible unless Cloudflare needs the visitor to click. Each token is single-use, so the
// widget is reset after every request to prepare the next one.
const turnstile = (() => {
  let widgetId = null, current = null, waiters = [];
  const deliver = t => { current = t; waiters.splice(0).forEach(w => w(t)); };
  return {
    async init(siteKey) {
      if (!siteKey) return;
      await new Promise((resolve, reject) => {
        const s = document.createElement('script');
        s.src = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit';
        s.async = true;
        s.onload = resolve;
        s.onerror = reject;
        document.head.appendChild(s);
      });
      widgetId = window.turnstile.render('.ts-box', {
        sitekey: siteKey,
        theme: 'dark',
        appearance: 'interaction-only',
        callback: deliver,
        'expired-callback': () => { current = null; window.turnstile.reset(widgetId); },
        'error-callback': () => { current = null; },
      });
    },
    // Resolves with a fresh token, or null when Turnstile is not configured (local MOCK mode).
    token(timeoutMs = 20000) {
      if (widgetId === null) return Promise.resolve(null);
      if (current) { const t = current; current = null; return Promise.resolve(t); }
      return new Promise(resolve => {
        const timer = setTimeout(() => resolve(null), timeoutMs);
        waiters.push(t => { clearTimeout(timer); current = null; resolve(t); });
      });
    },
    renew() {
      if (widgetId !== null) { current = null; window.turnstile.reset(widgetId); }
    },
  };
})();

fetch('/api/config')
  .then(r => r.json())
  .then(cfg => turnstile.init(cfg.turnstileSiteKey))
  .catch(() => {});

$('.code').textContent = 100 + Math.floor(Math.random() * 600);
setTimeout(() => bodyEl.removeAttribute('data-loading'), 1000);
