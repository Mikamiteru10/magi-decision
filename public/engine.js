// MAGI voting rules. Pure functions: the same API result can be re-judged instantly
// when the user changes Volume or Priority, without a new API call.
//
// Values below come from the P0 experiment (template v3, 2026-11-14):
//   HOLD_BAND: per-persona band around the threshold in which a vote counts as 保留 (about 10% of cases each)
//   CRITICAL_THRESHOLD: is_critical at or above this makes the case a 特別議案 (one-vote veto)

export const PERSONAS = ['melchior', 'balthasar', 'casper'];
export const HOLD_BAND = { melchior: 0.05, balthasar: 0.12, casper: 0.04 };
export const CRITICAL_THRESHOLD = 0.9;
export const HIGH_STAKES_THRESHOLD = 0.8;

export const VOLUMES = [1, 10, 33, 50, 66, 90, 65535];
export const PRIORITIES = ['E', '+++', 'A', 'AA', 'AAA'];

// Volume is the system's leniency: a higher Volume makes each persona approve more easily.
//   50 -> threshold 0.5 (neutral). 65535 -> threshold 0 (forced approval, an easter egg from the original).
export function thresholdFromVolume(volume) {
  if (volume >= 100) return 0;
  return Math.min(0.99, Math.max(0.01, 1 - volume / 100));
}

// Priority picks the voting rule.
//   AA  (default) automatic: majority, but one-vote veto when the case is judged a special agenda
//   A   always majority
//   AAA always one-vote veto (unanimous approval required)
//   E   any single approval is enough
//   +++ soft vote: mean probability against the threshold
export function ruleFor(priority, critical) {
  switch (priority) {
    case 'AAA': return 'unanimous';
    case 'A': return 'majority';
    case 'E': return 'any';
    case '+++': return 'soft';
    default: return critical ? 'unanimous' : 'majority';
  }
}

export function personaVote(p, persona, threshold) {
  if (threshold > 0 && Math.abs(p - threshold) <= HOLD_BAND[persona]) return 'hold';
  return p >= threshold ? 'resolve' : 'reject';
}

export function decide(result, { volume = 50, priority = 'AA' } = {}) {
  const threshold = thresholdFromVolume(volume);
  const critical = (result.globals?.is_critical ?? 0) >= CRITICAL_THRESHOLD;
  const rule = ruleFor(priority, critical);

  const votes = {};
  for (const k of PERSONAS) votes[k] = personaVote(result.votes[k].p, k, threshold);
  const list = Object.values(votes);
  const n = s => list.filter(v => v === s).length;
  const yes = n('resolve'), no = n('reject'), hold = n('hold');

  let final;
  if (rule === 'unanimous') {
    final = no > 0 ? 'reject' : hold > 0 ? 'hold' : 'resolve';
  } else if (rule === 'any') {
    final = yes > 0 ? 'resolve' : no === 3 ? 'reject' : 'hold';
  } else if (rule === 'soft') {
    const mean = PERSONAS.reduce((s, k) => s + result.votes[k].p, 0) / PERSONAS.length;
    final = mean >= threshold ? 'resolve' : 'reject';
  } else {
    final = yes >= 2 ? 'resolve' : no >= 2 ? 'reject' : 'hold';
  }

  // Who used the veto: personas whose rejection overturned what a majority would have approved.
  const vetoBy = rule === 'unanimous' && final === 'reject' && yes >= 2
    ? PERSONAS.filter(k => votes[k] === 'reject') : [];

  return {
    votes, final, rule, critical, threshold, vetoBy,
    highStakes: (result.globals?.high_stakes ?? 0) >= HIGH_STAKES_THRESHOLD,
  };
}

export const RULE_LABEL = {
  majority: '多数決',
  unanimous: '全会一致',
  any: '一票承認',
  soft: '加重平均',
};
