/**
 * Structured prompt templates for multi-agent deliberation phases.
 *
 * Each phase template guides the participating agent to produce substantive,
 * structured reasoning rather than superficial agreement. Templates accept
 * a context object containing the deliberation topic, prior messages, and
 * agent identity so that prompts are tailored to the current session state.
 */

/**
 * @typedef {Object} PromptContext
 * @property {string}   topic             - The deliberation topic / decision question
 * @property {string}   agentId           - The agent being prompted
 * @property {string}   [taskTitle]       - Human-readable task title
 * @property {string}   [taskDescription] - Extended task description
 * @property {Array}    [priorMessages]   - Array of { agentId, messageType, content } from history
 * @property {number}   [turnNumber]      - Current deliberation turn (0-indexed)
 * @property {string[]} [participants]    - All participant agent IDs
 */

// ─── Phase Templates ────────────────────────────────────────────────────────

/**
 * PROPOSAL phase prompt — the initiating agent presents a structured proposal.
 * Requires: rationale, tradeoffs, and success criteria.
 */
function buildProposalPrompt(ctx) {
  const { topic, agentId, taskDescription, participants } = ctx;
  const othersClause = participants && participants.length > 1
    ? `Other participants (${participants.filter(p => p !== agentId).join(', ')}) will challenge your proposal, so anticipate objections.`
    : '';

  return [
    `[DELIBERATION — PROPOSAL PHASE]`,
    `You are agent @${agentId}. You are initiating a structured architecture deliberation.`,
    ``,
    `Topic: ${topic}`,
    taskDescription ? `Context: ${taskDescription}` : null,
    ``,
    `Produce a PROPOSAL with the following sections:`,
    ``,
    `1. **Recommendation** — State your recommended approach in 1-2 sentences.`,
    `2. **Rationale** — Explain WHY this approach is preferred. Reference concrete technical factors (performance, maintainability, complexity, compatibility). Cite specific code paths, modules, or patterns where relevant.`,
    `3. **Tradeoffs** — List at least two tradeoffs or risks of your approach. For each, explain the severity and any mitigations.`,
    `4. **Alternatives Considered** — Briefly describe at least one alternative you rejected, and why.`,
    `5. **Success Criteria** — Define 2-3 measurable criteria that would confirm this decision was correct.`,
    ``,
    othersClause,
    ``,
    `Be specific and technical. Avoid vague statements like "this is better" without explaining why.`,
    `Do NOT propose something you expect everyone to trivially agree with — propose what you genuinely believe is the best path, even if it is controversial.`,
  ].filter(line => line !== null).join('\n');
}

/**
 * CHALLENGE phase prompt — a responding agent critiques the proposal.
 * Requires: specific concerns with reasoning, and at least one alternative.
 */
function buildChallengePrompt(ctx) {
  const { topic, agentId, priorMessages } = ctx;
  const proposal = findLastMessageOfType(priorMessages, 'proposal');

  return [
    `[DELIBERATION — CHALLENGE PHASE]`,
    `You are agent @${agentId}. You are reviewing a proposal and must raise substantive challenges.`,
    ``,
    `Topic: ${topic}`,
    ``,
    proposal
      ? `--- Proposal to Challenge ---\nFrom @${proposal.agentId}:\n${proposal.content}\n--- End Proposal ---`
      : `Review the most recent proposal in the deliberation history.`,
    ``,
    `Produce a CHALLENGE with the following sections:`,
    ``,
    `1. **Primary Concern** — Identify the most significant risk, gap, or flaw in the proposal. Explain concretely what could go wrong (e.g., "Under high load, this approach would cause X because Y").`,
    `2. **Supporting Evidence** — Reference specific technical details: code paths that would be affected, edge cases not covered, performance characteristics, or prior incidents.`,
    `3. **Secondary Concerns** — List 1-2 additional issues (lower severity). Each should be specific, not generic.`,
    `4. **Alternative Approach** — Propose at least one concrete alternative that addresses your primary concern. This does not need to be fully fleshed out, but must be actionable.`,
    `5. **Conditions for Acceptance** — State what changes to the proposal would resolve your concerns.`,
    ``,
    `Do NOT agree with the proposal just to be polite. Your role is to stress-test the idea.`,
    `Do NOT raise vague objections ("this might not scale"). Be specific about what, why, and under which conditions.`,
    `If you genuinely find no flaws, identify at least one area where the proposal could be strengthened.`,
  ].filter(line => line !== null).join('\n');
}

/**
 * COUNTER_ARGUMENT phase prompt — the original proposer (or another agent)
 * responds to challenges with reasoned counter-arguments.
 */
function buildCounterArgumentPrompt(ctx) {
  const { topic, agentId, priorMessages } = ctx;
  const challenge = findLastMessageOfType(priorMessages, 'challenge');

  return [
    `[DELIBERATION — COUNTER-ARGUMENT PHASE]`,
    `You are agent @${agentId}. You must respond to the challenges raised against the current proposal.`,
    ``,
    `Topic: ${topic}`,
    ``,
    challenge
      ? `--- Challenge to Address ---\nFrom @${challenge.agentId}:\n${challenge.content}\n--- End Challenge ---`
      : `Address the most recent challenge in the deliberation history.`,
    ``,
    `Produce a COUNTER-ARGUMENT with the following sections:`,
    ``,
    `1. **Acknowledged Concerns** — State which concerns from the challenge are valid. Do not dismiss everything — show you have considered the critique seriously.`,
    `2. **Refutation** — For concerns you disagree with, explain specifically why. Provide concrete evidence: benchmarks, code structure, precedent in this codebase, or architectural principles.`,
    `3. **Proposal Amendments** — If the challenge identified real gaps, describe specific changes to the original proposal that address them. This is your revised position.`,
    `4. **Remaining Disagreements** — If any points remain unresolved, state them clearly so they can be addressed in synthesis or further discussion.`,
    `5. **Path to Convergence** — Suggest what a synthesized position might look like that incorporates the strongest elements of both the proposal and the challenge.`,
    ``,
    `The goal is NOT to "win" the argument. The goal is to produce the best possible decision.`,
    `Incorporate valid criticisms into an improved proposal rather than defending the original at all costs.`,
    `If the challenger's alternative is genuinely better, say so and adopt it.`,
  ].filter(line => line !== null).join('\n');
}

/**
 * SYNTHESIS phase prompt — an agent produces a consensus summary.
 * Only allowed after minMessages threshold is met.
 */
function buildSynthesisPrompt(ctx) {
  const { topic, agentId, priorMessages, turnNumber } = ctx;
  const messageCount = priorMessages ? priorMessages.length : 0;

  return [
    `[DELIBERATION — SYNTHESIS PHASE]`,
    `You are agent @${agentId}. After ${messageCount} exchanges across ${turnNumber || 'multiple'} turns, produce a synthesis of the deliberation.`,
    ``,
    `Topic: ${topic}`,
    ``,
    `Review all prior arguments in the deliberation history and produce a SYNTHESIS:`,
    ``,
    `1. **Decision** — State the final recommended approach in 1-2 clear sentences.`,
    `2. **Rationale Summary** — Explain why this is the best path, incorporating insights from ALL participants. Reference specific arguments that shaped this conclusion.`,
    `3. **Incorporated Feedback** — List specific concerns or suggestions from challengers that were incorporated and how.`,
    `4. **Accepted Tradeoffs** — List tradeoffs the group is accepting, with clear-eyed assessment of risks.`,
    `5. **Action Items** — Concrete next steps to implement the decision.`,
    `6. **Dissenting Views** — Note any unresolved disagreements for the record, even if the group is moving forward.`,
    ``,
    `The synthesis must reflect the full deliberation, not just the original proposal.`,
    `If the deliberation changed the original direction, say so explicitly.`,
  ].filter(line => line !== null).join('\n');
}

// ─── Helpers ────────────────────────────────────────────────────────────────

/**
 * Find the last message of a given type in the history.
 * @param {Array} messages - Array of { agentId, messageType, content, ... }
 * @param {string} type    - Message type to find
 * @returns {{ agentId: string, content: string, messageType: string } | null}
 */
function findLastMessageOfType(messages, type) {
  if (!Array.isArray(messages)) return null;
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].messageType === type || messages[i].type === type) {
      return messages[i];
    }
  }
  return null;
}

/**
 * Get the appropriate prompt template for a given deliberation phase.
 *
 * @param {string} phase  - One of: 'proposal', 'challenge', 'counter_argument', 'synthesis'
 * @param {PromptContext} ctx - Context for template rendering
 * @returns {string} The rendered prompt text
 * @throws {Error} If phase is not recognized
 */
function getPhasePrompt(phase, ctx) {
  const builders = {
    proposal:         buildProposalPrompt,
    challenge:        buildChallengePrompt,
    counter_argument: buildCounterArgumentPrompt,
    synthesis:        buildSynthesisPrompt,
  };

  const builder = builders[phase];
  if (!builder) {
    throw new Error(`Unknown deliberation phase: ${phase}. Valid phases: ${Object.keys(builders).join(', ')}`);
  }

  return builder(ctx);
}

/**
 * Build a prompt for the deliberation proposal subtask text.
 * This is the enriched replacement for the simple "Provide a deliberation proposal for: {title}" text.
 *
 * @param {Object} task     - Task object with title, description, context
 * @param {string} agentId  - Agent being assigned the proposal subtask
 * @param {string[]} [participants] - All participant agent IDs
 * @returns {string} Subtask text with structured proposal instructions
 */
function buildDeliberationSubtaskText(task, agentId, participants) {
  const topic = task.title || task.description || 'the task';
  const ctx = {
    topic,
    agentId: agentId || 'unknown',
    taskDescription: task.description || task.context || null,
    participants: participants || [],
    priorMessages: [],
    turnNumber: 0,
  };
  return buildProposalPrompt(ctx);
}

export {
  buildProposalPrompt,
  buildChallengePrompt,
  buildCounterArgumentPrompt,
  buildSynthesisPrompt,
  getPhasePrompt,
  buildDeliberationSubtaskText,
  findLastMessageOfType,
};
