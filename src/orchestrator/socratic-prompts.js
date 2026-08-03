/**
 * Socratic Campaign Prompt Templates
 *
 * Provides prompt templates for LLM agent invocations in the Socratic research flow.
 * Organized by phase: assumption identification and question generation.
 */

/**
 * Assumption Identification Prompt
 *
 * Instructs the LLM to analyze research data and extract implicit/explicit assumptions.
 * Focuses on uncovering stated and unstated premises underlying system decisions.
 *
 * @param {object} researchPackage - Research context with learnings, timeline, patterns
 * @param {string} domain - Domain context
 * @returns {string} Prompt template for assumption identification
 */
export function generateAssumptionIdentificationPrompt(researchPackage, domain) {
  const learningsSummary = formatLearningsSummary(researchPackage?.data?.learnings);
  const timelineSummary = formatTimelineSummary(researchPackage?.data?.timelineEvents);
  const patternsSummary = formatPatternsSummary(researchPackage?.data?.patternFindings);

  return `You are a critical thinking analyst specializing in ${domain}. Your task is to identify assumptions embedded in the system's history and decision-making.

## Context Overview

### Domain: ${domain}

### Recorded Learnings (${learningsSummary.count} items)
${learningsSummary.summary || 'No recorded learnings available.'}

### Timeline Events (${timelineSummary.count} events)
${timelineSummary.summary || 'No timeline events available.'}

### Pattern Findings (${patternsSummary.count} patterns detected)
${patternsSummary.summary || 'No pattern findings available.'}

## Your Task

Analyze the above information and identify ALL assumptions (both explicit and implicit) that underlie decisions, behaviors, or system design in the ${domain} domain.

### Types of Assumptions to Identify:

1. **Explicit Assumptions**: Clearly stated premises in documentation, decisions, or recorded learnings
   - Example: "We assume the API will remain backward compatible"
   
2. **Implicit Assumptions**: Unstated but necessary premises that drive behavior
   - Example: "The system assumes user input will always be sanitized"

3. **Architectural Assumptions**: Design decisions that encode beliefs about the world
   - Example: "Microservices assume network latency is acceptable trade-off"

4. **Operational Assumptions**: Beliefs about how the system behaves in production
   - Example: "Monitoring alerts are sufficient to detect all critical failures"

## Output Requirements

Return a JSON array of assumption objects with this exact structure:

[
  {
    "type": "explicit|implicit|architectural|operational",
    "statement": "Clear, complete sentence stating the assumption",
    "source": "learnings_analysis|pattern_detection|timeline_analysis|domain_knowledge",
    "confidence": "high|medium|low",
    "evidence": "Brief explanation of what evidence supports this assumption"
  }
]

## Guidelines:

- Extract ALL assumptions you can identify, not just the obvious ones
- Be specific in statements - avoid vague generalities
- Assign confidence based on how directly supported by available data
- If data is sparse, note that in confidence level
- Prioritize assumptions that, if wrong, would significantly impact system behavior
- Include at least 3-5 assumptions even with limited data

## Important:

Return ONLY the JSON array. Do not include explanations, markdown formatting, or any text outside the array.`;
}

/**
 * Question Generation Prompt
 *
 * Instructs the LLM to generate Socratic questions that challenge identified assumptions.
 * Requires evidence-citing questions with balanced analysis (for and against).
 *
 * @param {Array<object>} assumptions - Identified assumptions
 * @param {object} researchPackage - Research context
 * @param {string} domain - Domain context
 * @returns {string} Prompt template for question generation
 */
export function generateQuestionGenerationPrompt(assumptions, researchPackage, domain) {
  const assumptionList = assumptions
    .map((a, i) => `${i + 1}. [${a.type}] ${a.statement}`)
    .join('\n');

  const learningsContext = formatLearningsSummary(researchPackage?.data?.learnings);
  const timelineContext = formatTimelineSummary(researchPackage?.data?.timelineEvents);
  const patternsContext = formatPatternsSummary(researchPackage?.data?.patternFindings);

  return `You are a Socratic questioner specializing in critical analysis of ${domain} systems. Your task is to generate probing questions that challenge assumptions and expose hidden premises.

## Context Overview

### Domain: ${domain}

### Identified Assumptions to Challenge:
${assumptionList || 'No assumptions identified. Generate general domain questions.'}

### Supporting Data:
- Learnings analyzed: ${learningsContext.count} items
- Timeline events reviewed: ${timelineContext.count} events  
- Patterns detected: ${patternsContext.count} findings

## Your Task

Generate Socratic questions that challenge the assumptions above. Each question must:

1. **Directly challenge a specific assumption** - not just ask about it, but probe its validity
2. **Cite evidence** - reference concrete data from learnings, events, or patterns
3. **Consider multiple perspectives** - show both supporting and contradictory evidence
4. **Assess impact** - explain consequences if the assumption is wrong

## Output Requirements

Return a JSON array of question objects with this EXACT structure:

[
  {
    "question": "The actual Socratic question being asked",
    "assumptionChallenged": "Full text of the assumption being challenged",
    "evidenceFor": [
      "Evidence or reasoning that supports the assumption",
      "Another piece of supporting evidence"
    ],
    "evidenceAgainst": [
      "Evidence or reasoning that challenges the assumption",
      "Another piece of contradictory evidence"
    ],
    "impactIfWrong": "What would happen if this assumption is incorrect?",
    "priority": 7,
    "domain": "${domain}"
  }
]

## Question Types to Generate:

1. **Evidence Questions**: "What evidence supports/challenges X?"
2. **Condition Questions**: "Under what conditions would X be false?"
3. **Alternative Questions**: "What alternative assumptions could explain the same data?"
4. **Consequence Questions**: "If X is wrong, what fails?"
5. **Origin Questions**: "Where did this assumption come from and is that source still valid?"

## Quality Requirements:

- Generate between 5-15 questions total (strict requirement)
- Each question must challenge at least one assumption
- Evidence arrays must have 1-3 concrete items each
- Priority must be an integer between 1-10
- Questions must vary in focus and approach - do NOT generate duplicate questions
- Each question must challenge a DIFFERENT assumption or aspect of an assumption
- Questions with identical or near-identical assumptionChallenged fields will be rejected
- Avoid generic questions - tie to specific data points when possible
- If generating multiple questions about the same assumption, ensure each challenges a DISTINCT aspect

## Example Questions (showing diversity about same assumption):

### Example Set 1 - Challenging "Monitoring alerts are sufficient":
\`\`\`json
{
  "question": "What specific incidents demonstrate that our monitoring alerts are insufficient to detect critical failures?",
  "assumptionChallenged": "Monitoring alerts are sufficient to detect all critical failures",
  "evidenceFor": [
    "No undetected outages recorded in timeline over past 90 days",
    "Alert coverage analysis shows 95% of known failure modes are monitored"
  ],
  "evidenceAgainst": [
    "Learning LE-2847 documents 3-hour delay in detecting database degradation",
    "Pattern PF-192 shows alert fatigue causing 12% of alerts to be dismissed without review"
  ],
  "impactIfWrong": "System may experience prolonged outages before detection, increasing MTTR and user impact",
  "priority": 8,
  "domain": "reliability"
}
\`\`\`

### Example Set 2 - Different aspect of same assumption:
\`\`\`json
{
  "question": "Which failure modes lack dedicated monitoring despite having documented incident history?",
  "assumptionChallenged": "Monitoring alerts are sufficient to detect all critical failures",
  "evidenceFor": [
    "Alert routing ensures all critical alerts reach on-call engineers"
  ],
  "evidenceAgainst": [
    "Timeline shows 5 incidents in past year triggered by unmonitored database connection pool exhaustion",
    "Learning LE-3102 recommends adding connection pool metrics that were never implemented"
  ],
  "impactIfWrong": "Specific failure modes may go undetected until they cascade into larger outages",
  "priority": 7,
  "domain": "reliability"
}
\`\`\`

**CRITICAL: Do not generate identical questions. Each question must challenge a distinct aspect or have different evidence.**

## Important:

Return ONLY the JSON array. Do not include explanations, markdown formatting (no code blocks with json tags), or any text outside the array.`;
}

/**
 * Format learnings summary for prompt inclusion
 */
function formatLearningsSummary(learnings) {
  if (!learnings || !learnings.items) {
    return { count: 0, summary: '' };
  }

  const count = learnings.total || learnings.items.length;
  
  if (count === 0) {
    return { count: 0, summary: 'No recorded learnings available.' };
  }

  // Generate brief summary of learning themes
  const themes = extractLearningThemes(learnings.items);
  const summary = themes.length > 0 
    ? `Key themes: ${themes.join(', ')}`
    : `${count} learning items recorded.`;

  return { count, summary };
}

/**
 * Format timeline summary for prompt inclusion
 */
function formatTimelineSummary(timelineEvents) {
  if (!timelineEvents || !timelineEvents.items) {
    return { count: 0, summary: '' };
  }

  const count = timelineEvents.total || timelineEvents.items.length;
  
  if (count === 0) {
    return { count: 0, summary: 'No timeline events available.' };
  }

  // Extract date range and key events
  const dateRange = extractDateRange(timelineEvents.items);
  const keyEvents = extractKeyEvents(timelineEvents.items, 3);
  
  const summary = dateRange 
    ? `${count} events from ${dateRange}. Notable: ${keyEvents}`
    : `${count} timeline events recorded.`;

  return { count, summary };
}

/**
 * Format pattern findings summary for prompt inclusion
 */
function formatPatternsSummary(patternFindings) {
  if (!patternFindings || !patternFindings.items) {
    return { count: 0, summary: '' };
  }

  const count = patternFindings.total || patternFindings.items.length;
  
  if (count === 0) {
    return { count: 0, summary: 'No pattern findings available.' };
  }

  // Extract pattern categories
  const categories = extractPatternCategories(patternFindings.items);
  const summary = categories.length > 0
    ? `Patterns span: ${categories.join(', ')}`
    : `${count} cross-project patterns detected.`;

  return { count, summary };
}

/**
 * Extract learning themes from items
 */
function extractLearningThemes(learnings) {
  const themes = new Set();
  
  learnings.slice(0, 10).forEach(learning => {
    if (learning.category) themes.add(learning.category);
    if (learning.tags) learning.tags.forEach(t => themes.add(t));
  });

  return Array.from(themes).slice(0, 5);
}

/**
 * Extract date range from timeline items
 */
function extractDateRange(items) {
  if (!items || items.length === 0) return null;
  
  const dates = items
    .map(item => item.timestamp || item.date)
    .filter(Boolean)
    .sort();

  if (dates.length < 2) return null;
  
  return `${formatDate(dates[0])} to ${formatDate(dates[dates.length - 1])}`;
}

/**
 * Extract key events from timeline
 */
function extractKeyEvents(items, count) {
  const keyTypes = ['incident', 'deployment', 'rollback', 'outage', 'release'];
  
  return items
    .filter(item => {
      const type = item.type?.toLowerCase() || item.category?.toLowerCase() || '';
      return keyTypes.some(k => type.includes(k));
    })
    .slice(0, count)
    .map(item => item.title || item.description?.substring(0, 50) + '...')
    .join('; ');
}

/**
 * Extract pattern categories
 */
function extractPatternCategories(patterns) {
  const categories = new Set();
  
  patterns.slice(0, 10).forEach(pattern => {
    if (pattern.category) categories.add(pattern.category);
    if (pattern.type) categories.add(pattern.type);
  });

  return Array.from(categories).slice(0, 5);
}

/**
 * Format date for display
 */
function formatDate(dateString) {
  if (!dateString) return 'unknown date';
  
  try {
    const date = new Date(dateString);
    return date.toLocaleDateString();
  } catch {
    return String(dateString).substring(0, 10);
  }
}

export default {
  generateAssumptionIdentificationPrompt,
  generateQuestionGenerationPrompt,
};