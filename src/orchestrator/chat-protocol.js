const MODES = new Set(['discussion', 'roundtable', 'debate']);
const AGENT_ID = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const TURN_STATUSES = new Set(['answered', 'passed', 'timed_out', 'unavailable', 'error']);

function requireObject(value, label, keys) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label} must be an object.`);
  for (const key of Object.keys(value)) {
    if (!keys.includes(key)) throw new Error(`Unsupported ${label} field: ${key}.`);
  }
}

function integerInRange(value, field, min, max) {
  if (!Number.isSafeInteger(value) || value < min || value > max) {
    throw new Error(`${field} must be an integer from ${min} to ${max}.`);
  }
  return value;
}

function requireAgentId(id) {
  if (typeof id !== 'string' || !AGENT_ID.test(id)) throw new Error('Use a valid lowercase agent ID.');
  return id;
}

function requireUnique(values, label) {
  if (new Set(values).size !== values.length) throw new Error(`${label} must be unique.`);
}

export function parseConversationOptions(raw) {
  if (raw == null) return null;
  const common = ['mode', 'turnTimeoutMs', 'localTurnTimeoutMs'];
  const extras = {
    roundtable: ['order', 'rounds'],
    debate: ['sides', 'missingOpening'],
  };
  const mode = raw.mode;
  if (!MODES.has(mode)) throw new Error('Conversation mode must be discussion, roundtable, or debate.');
  requireObject(raw, 'conversation', [...common, ...(extras[mode] || [])]);

  const options = { mode };
  for (const field of common.slice(1)) {
    if (Object.hasOwn(raw, field)) options[field] = integerInRange(raw[field], field, 1000, 1800000);
  }

  if (mode === 'roundtable') {
    options.rounds = Object.hasOwn(raw, 'rounds') ? integerInRange(raw.rounds, 'rounds', 1, 4) : 1;
    if (Object.hasOwn(raw, 'order')) {
      if (!Array.isArray(raw.order) || raw.order.length < 1 || raw.order.length > 12) {
        throw new Error('Roundtable order must contain 1 to 12 agent IDs.');
      }
      options.order = raw.order.map(requireAgentId);
      requireUnique(options.order, 'Roundtable agent IDs');
    }
  } else if (mode === 'debate') {
    if (!Array.isArray(raw.sides) || raw.sides.length < 2 || raw.sides.length > 8) {
      throw new Error('Debate requires 2 to 8 sides.');
    }
    options.sides = raw.sides.map(side => {
      requireObject(side, 'debate side', ['label', 'opener']);
      const label = typeof side.label === 'string' ? side.label.trim() : '';
      if (!label || label.length > 80 || /[\r\n]/.test(label)) {
        throw new Error('Debate side labels must contain 1 to 80 characters on one line.');
      }
      return { label, opener: requireAgentId(side.opener) };
    });
    requireUnique(options.sides.map(side => side.label.toLowerCase()), 'Debate side labels');
    requireUnique(options.sides.map(side => side.opener), 'Debate openers');
    options.missingOpening = Object.hasOwn(raw, 'missingOpening') ? raw.missingOpening : 'stop';
    if (options.missingOpening !== 'stop' && options.missingOpening !== 'continue') {
      throw new Error('Missing-opening policy must be stop or continue.');
    }
  }

  return options;
}

export async function runChatProtocol({ options, participants, respond, publish, announce }) {
  const transcript = [];

  async function ask(agentId, phase, round, history, side) {
    const turn = { phase, round, ...(side ? { side } : {}), transcript: history.map(entry => ({ ...entry })) };
    let result;
    try {
      result = await respond(agentId, turn);
    } catch {
      result = { status: 'error' };
    }
    if (!TURN_STATUSES.has(result?.status)
        || (result.status === 'answered' && (typeof result.content !== 'string' || !result.content.trim()))) {
      result = { status: 'error' };
    }
    announce({ type: 'turn', phase, round, agentId, status: result.status });
    return { agentId, result, turn };
  }

  async function release({ agentId, result, turn }) {
    if (result.status !== 'answered') return;
    await publish(agentId, result, turn);
    transcript.push({ agentId, ...(turn.side ? { side: turn.side } : {}), content: result.content });
  }

  if (options.mode === 'discussion') {
    announce({ type: 'phase', phase: 'discussion', round: 1 });
    await Promise.all(participants.map(async agentId => {
      await release(await ask(agentId, 'discussion', 1, []));
    }));
  } else if (options.mode === 'roundtable') {
    for (let round = 1; round <= options.rounds; round++) {
      announce({ type: 'phase', phase: 'roundtable', round });
      for (const agentId of participants) {
        await release(await ask(agentId, 'roundtable', round, transcript));
      }
    }
  } else {
    announce({ type: 'phase', phase: 'opening', round: 1 });
    const openings = await Promise.all(options.sides.map(({ opener, label }) => ask(opener, 'opening', 1, [], label)));
    for (const opening of openings) await release(opening);
    const accepted = openings.filter(({ result }) => result.status === 'answered');
    const missing = openings.filter(({ result }) => result.status !== 'answered').map(({ agentId }) => agentId);
    if (missing.length && (options.missingOpening === 'stop' || accepted.length < 2)) {
      announce({ type: 'outcome', phase: 'opening', status: 'incomplete', missing });
      return;
    }

    announce({ type: 'phase', phase: 'rebuttal', round: 2 });
    const rebuttals = await Promise.all(accepted.map(({ agentId, turn }) =>
      ask(agentId, 'rebuttal', 2, transcript, turn.side)));
    for (const rebuttal of rebuttals) await release(rebuttal);
    announce({ type: 'outcome', phase: 'rebuttal', status: 'complete', missing });
    return;
  }

  announce({ type: 'outcome', status: 'complete' });
}
