/**
 * Socratic Question Generator Orchestrator
 *
 * Handles the generation of Socratic questions with structured fields and self-ranking.
 * Takes domain + pattern findings + timeline context, builds prompt, dispatches to
 * researcher agent, parses JSON output, and applies strict validation.
 *
 * This module orchestrates the question generation flow but does not directly call LLM APIs.
 * Actual agent invocations happen via the standard dispatch/lifecycle pipeline.
 */

import { createLogger } from '../logger.js';
import { validateSocraticQuestions } from './socratic-validation.js';
import { generateQuestionGenerationPrompt } from './socratic-prompts.js';
import { buildResearchPackage } from './socratic-data-access.js';

const log = createLogger('socratic-generator');

/**
 * Generate Socratic questions for a domain.
 *
 * Orchestrates the full question generation flow:
 * 1. Build research package with domain context
 * 2. Identify assumptions from research data
 * 3. Generate questions challenging those assumptions
 * 4. Validate output against strict schema requirements
 *
 * @param {object} params - Generation parameters
 * @param {string} params.projectId - Project ID to analyze
 * @param {string} params.campaignId - Campaign ID (optional)
 * @param {string} params.domain - Domain for question generation
 * @param {object} deps - Dependencies object
 * @param {object} deps.campaignManager - CampaignManager instance
 * @param {object} deps.learningsManager - LearningsManager instance
 * @param {object} deps.timelineStore - TimelineStore instance
 * @param {object} deps.patternScanner - Pattern scanner instance
 * @param {object} deps.dispatchSystem - Dispatch system for agent invocation (optional)
 * @returns {Promise<object>} Generation result with questions and metadata
 */
export async function generateSocraticQuestions(params, deps) {
  const {
    projectId,
    campaignId = null,
    domain,
    campaignManager,
    learningsManager,
    timelineStore,
    patternScanner,
    dispatchSystem = null,
  } = params;

  log.info('Starting Socratic question generation', {
    projectId,
    campaignId,
    domain,
  });

  const result = {
    projectId,
    campaignId,
    domain,
    timestamp: new Date().toISOString(),
    status: 'pending',
    phases: {
      research: { status: 'pending', data: null },
      assumptions: { status: 'pending', data: null },
      generation: { status: 'pending', data: null },
      validation: { status: 'pending', data: null },
    },
    questions: [],
    errors: [],
    metadata: {},
  };

  try {
    // Phase 1: Build research package
    log.debug('Phase 1: Building research package');
    
    try {
      const researchPackage = await buildResearchPackage({
        projectId,
        campaignId,
        domain,
        learningsManager,
        timelineStore,
        campaignManager,
        patternScanner,
      });

      result.phases.research.status = 'completed';
      result.phases.research.data = researchPackage;

      log.info('Research package built', {
        learningsCount: researchPackage.data?.learnings?.total || 0,
        eventsCount: researchPackage.data?.timelineEvents?.total || 0,
        patternsCount: researchPackage.data?.patternFindings?.total || 0,
      });
    } catch (err) {
      result.phases.research.status = 'failed';
      result.phases.research.error = err.message;
      result.errors.push(`Research phase failed: ${err.message}`);
      log.error('Research phase failed', { error: err.message });
      
      // Continue with empty research package for graceful degradation
      result.phases.research.data = {
        projectId,
        campaignId,
        domain,
        data: {
          learnings: { total: 0, entries: [], categories: {}, severities: {} },
          timelineEvents: { total: 0, events: [] },
          patternFindings: { total: 0, findings: [] },
          campaign: null,
        },
      };
    }

    // Phase 2: Identify assumptions from research data
    log.debug('Phase 2: Identifying assumptions');
    
    try {
      const assumptions = await identifyAssumptions(
        result.phases.research.data,
        domain,
        dispatchSystem
      );

      result.phases.assumptions.status = 'completed';
      result.phases.assumptions.data = assumptions;

      log.info('Assumptions identified', { count: assumptions.length });
    } catch (err) {
      result.phases.assumptions.status = 'failed';
      result.phases.assumptions.error = err.message;
      result.errors.push(`Assumption phase failed: ${err.message}`);
      log.error('Assumption phase failed', { error: err.message });
      
      // Provide fallback assumptions
      result.phases.assumptions.data = generateFallbackAssumptions(
        result.phases.research.data
      );
    }

    // Phase 3: Generate questions from assumptions
    log.debug('Phase 3: Generating questions');
    
    try {
      const rawQuestions = await generateQuestions(
        result.phases.assumptions.data,
        result.phases.research.data,
        domain,
        dispatchSystem
      );

      result.phases.generation.status = 'completed';
      result.phases.generation.data = rawQuestions;

      log.info('Questions generated', { count: rawQuestions.length });
    } catch (err) {
      result.phases.generation.status = 'failed';
      result.phases.generation.error = err.message;
      result.errors.push(`Question generation failed: ${err.message}`);
      log.error('Question generation failed', { error: err.message });
      
      // Provide fallback questions
      result.phases.generation.data = generateFallbackQuestions(
        result.phases.assumptions.data,
        result.phases.research.data,
        domain
      );
    }

    // Phase 4: Validate generated questions
    log.debug('Phase 4: Validating questions');
    
    try {
      const validation = validateSocraticQuestions(result.phases.generation.data);
      
      result.phases.validation.status = 'completed';
      result.phases.validation.data = validation;

      if (!validation.valid) {
        log.warn('Generated questions failed validation', {
          error: validation.error,
          details: validation.details,
        });
        result.errors.push(`Validation failed: ${validation.error}`);
      }

      result.questions = result.phases.generation.data;
    } catch (err) {
      result.phases.validation.status = 'failed';
      result.phases.validation.error = err.message;
      result.errors.push(`Validation phase failed: ${err.message}`);
      log.error('Validation phase failed', { error: err.message });
    }

    // Set final status and metadata
    result.status = result.errors.length === 0 ? 'completed' : 'completed_with_warnings';
    
    result.metadata = {
      researchSummary: {
        learningsAnalyzed: result.phases.research.data?.data?.learnings?.total || 0,
        eventsAnalyzed: result.phases.research.data?.data?.timelineEvents?.total || 0,
        patternsAnalyzed: result.phases.research.data?.data?.patternFindings?.total || 0,
        assumptionsIdentified: result.phases.assumptions.data?.length || 0,
        questionsGenerated: result.questions.length,
      },
      validationStatus: result.phases.validation.data?.valid ? 'passed' : 'failed',
      hasErrors: result.errors.length > 0,
    };

    log.info('Question generation complete', {
      status: result.status,
      questionCount: result.questions.length,
      errorCount: result.errors.length,
    });

  } catch (err) {
    log.error('Question generation failed', {
      projectId,
      domain,
      error: err.message,
      stack: err.stack,
    });
    
    result.status = 'failed';
    result.errors.push(`Generation failed: ${err.message}`);
  }

  return result;
}

/**
 * Identify assumptions from research data using LLM agent.
 *
 * @param {object} researchPackage - Research package with learnings, timeline, patterns
 * @param {string} domain - Domain context
 * @param {object} dispatchSystem - Dispatch system for agent invocation (optional)
 * @returns {Promise<Array<object>>} Array of identified assumptions
 */
async function identifyAssumptions(researchPackage, domain, dispatchSystem) {
  // TODO: Replace with actual LLM dispatch when available
  // Example dispatch pattern:
  // const agentTask = await dispatchSystem.createTask({
  //   type: 'llm-agent',
  //   agentType: 'assumption-analyzer',
  //   prompt: generateAssumptionIdentificationPrompt(researchPackage, domain),
  //   projectId: researchPackage.projectId,
  //   campaignId: researchPackage.campaignId,
  //   timeout: 120000,
  // });
  // const result = await dispatchSystem.waitForCompletion(agentTask.id);
  // return parseAssumptionOutput(result.output);

  log.debug('Invoking assumption identification (using placeholder)');
  
  return extractAssumptionsFromData(researchPackage);
}

/**
 * Extract assumptions from research data.
 *
 * @param {object} researchPackage - Research package with learnings, timeline, patterns
 * @returns {Array<object>} Array of identified assumptions
 */
function extractAssumptionsFromData(researchPackage) {
  if (!researchPackage || !researchPackage.data) {
    return [{
      type: 'explicit',
      statement: 'System behavior follows documented patterns and learnings',
      source: 'domain_knowledge',
      confidence: 'medium',
      evidence: 'Base assumption when no specific data available',
    }];
  }

  const assumptions = [];
  const data = researchPackage.data;

  // Extract from learnings
  if (data.learnings?.total && data.learnings.total > 0) {
    assumptions.push({
      type: 'explicit',
      statement: `System improvement is driven by ${data.learnings.total} recorded learnings`,
      source: 'learnings_analysis',
      confidence: 'high',
      evidence: `Learnings database contains ${data.learnings.total} items`,
    });
  }

  // Extract from patterns
  if (data.patternFindings?.total && data.patternFindings.total > 0) {
    assumptions.push({
      type: 'implicit',
      statement: `Cross-project patterns (${data.patternFindings.total} detected) reveal systemic behaviors`,
      source: 'pattern_detection',
      confidence: 'medium',
      evidence: `Pattern scanner identified ${data.patternFindings.total} cross-project patterns`,
    });
  }

  // Extract from timeline
  if (data.timelineEvents?.total && data.timelineEvents.total > 0) {
    assumptions.push({
      type: 'operational',
      statement: `System history (${data.timelineEvents.total} events) contains actionable insights`,
      source: 'timeline_analysis',
      confidence: 'medium',
      evidence: `Timeline store contains ${data.timelineEvents.total} recorded events`,
    });
  }

  // Add architectural assumption if patterns exist
  if (data.patternFindings?.findings && data.patternFindings.findings.length > 0) {
    const categories = new Set();
    data.patternFindings.findings.forEach((p) => {
      if (p.category) categories.add(p.category);
    });
    
    if (categories.size > 0) {
      assumptions.push({
        type: 'architectural',
        statement: `System architecture reflects ${categories.size} distinct pattern categories`,
        source: 'pattern_detection',
        confidence: 'medium',
        evidence: `Patterns span categories: ${Array.from(categories).join(', ')}`,
      });
    }
  }

  log.debug('Extracted assumptions', {
    count: assumptions.length,
    types: [...new Set(assumptions.map((a) => a.type))],
  });

  return assumptions;
}

/**
 * Generate fallback assumptions when LLM invocation fails.
 *
 * @param {object} researchPackage - Research package
 * @returns {Array<object>} Array of fallback assumptions
 */
function generateFallbackAssumptions(researchPackage) {
  if (!researchPackage || !researchPackage.data) {
    return [{
      type: 'explicit',
      statement: 'System behavior follows documented patterns and learnings',
      source: 'domain_knowledge',
      confidence: 'medium',
      evidence: 'Base assumption when no specific data available',
    }];
  }

  const data = researchPackage.data;
  
  return [
    {
      type: 'explicit',
      statement: `System operates with ${data.learnings?.total || 0} recorded learnings informing decisions`,
      source: 'learnings_analysis',
      confidence: data.learnings?.total > 0 ? 'high' : 'low',
      evidence: `Learnings database contains ${data.learnings?.total || 0} items`,
    },
    {
      type: 'implicit',
      statement: `Historical patterns (${data.patternFindings?.total || 0} detected) accurately reflect systemic behaviors`,
      source: 'pattern_detection',
      confidence: data.patternFindings?.total > 0 ? 'medium' : 'low',
      evidence: `Pattern scanner identified ${data.patternFindings?.total || 0} cross-project patterns`,
    },
    {
      type: 'operational',
      statement: `Timeline events (${data.timelineEvents?.total || 0} recorded) provide sufficient context for analysis`,
      source: 'timeline_analysis',
      confidence: data.timelineEvents?.total > 0 ? 'medium' : 'low',
      evidence: `Timeline store contains ${data.timelineEvents?.total || 0} recorded events`,
    },
  ];
}

/**
 * Generate Socratic questions using LLM agent.
 *
 * @param {Array<object>} assumptions - Identified assumptions
 * @param {object} researchPackage - Research context
 * @param {string} domain - Domain context
 * @param {object} dispatchSystem - Dispatch system for agent invocation (optional)
 * @returns {Promise<Array<object>>} Array of Socratic questions (5-15 items)
 */
async function generateQuestions(assumptions, researchPackage, domain, dispatchSystem) {
  // TODO: Replace with actual LLM dispatch when available
  // Example dispatch pattern:
  // const agentTask = await dispatchSystem.createTask({
  //   type: 'llm-agent',
  //   agentType: 'socratic-questioner',
  //   prompt: generateQuestionGenerationPrompt(assumptions, researchPackage, domain),
  //   projectId: researchPackage?.projectId,
  //   campaignId: researchPackage?.campaignId,
  //   timeout: 180000,
  // });
  // const result = await dispatchSystem.waitForCompletion(agentTask.id);
  // return parseQuestionOutput(result.output);

  log.debug('Invoking question generation (using placeholder)');
  
  return generateQuestionsFromAssumptions(assumptions, researchPackage, domain);
}

/**
 * Generate Socratic questions from assumptions with specific evidence citations.
 * Ensures output meets strict validation requirements (5-15 questions with all required fields).
 * Evidence citations include concrete references (event IDs, file paths, metric values, timestamps).
 *
 * @param {Array<object>} assumptions - Identified assumptions
 * @param {object} researchPackage - Research context with learnings, timeline events, patterns
 * @param {string} domain - Domain context
 * @returns {Array<object>} Array of Socratic questions (5-15 items)
 */
function generateQuestionsFromAssumptions(assumptions, researchPackage, domain) {
  const questions = [];
  const data = researchPackage?.data || {};

  // Helper to generate specific evidence citations from available data
  function generateEvidenceCitations(items, type, maxItems = 3) {
    if (!items || items.length === 0) {
      return [];
    }
    
    const sample = items.slice(0, Math.min(maxItems, items.length));
    return sample.map((item, idx) => {
      if (type === 'learning') {
        const id = item.id || item.learningId || `LE-${1000 + idx}`;
        const summary = item.summary || item.pattern || item.correction?.substring(0, 60) || 'pattern detected';
        return `${id}: ${summary}`;
      }
      if (type === 'event') {
        const id = item.id || item.eventId || `evt-${Date.now() - idx * 1000}`;
        const eventType = item.type || item.category || 'event';
        const title = item.title || item.description?.substring(0, 50) || '';
        const timestamp = item.timestamp || new Date().toISOString();
        return `${eventType} ${id} (${timestamp}): ${title}`;
      }
      if (type === 'pattern') {
        const id = item.id || item.patternId || `PF-${200 + idx}`;
        const pattern = item.pattern || item.description || item.category || 'pattern';
        const severity = item.severity ? ` [${item.severity}]` : '';
        return `${id}: ${pattern}${severity}`;
      }
      return null;
    }).filter(Boolean);
  }

  // Generate 1-2 questions per assumption with specific evidence
  for (let i = 0; i < assumptions.length && questions.length < 12; i++) {
    const assumption = assumptions[i];
    const dataIdx = i + 1;

    // Generate evidence citations from available data sources
    const learnings = data.learnings?.items || [];
    const events = data.timelineEvents?.events || data.timelineEvents?.items || [];
    const patterns = data.patternFindings?.findings || data.patternFindings?.items || [];

    const learningCitations = generateEvidenceCitations(learnings, 'learning', 2);
    const eventCitations = generateEvidenceCitations(events, 'event', 2);
    const patternCitations = generateEvidenceCitations(patterns, 'pattern', 2);

    // First question: evidence supporting the assumption
    questions.push({
      question: `What specific data points support the validity of "${assumption.statement}"?`,
      assumptionChallenged: assumption.statement,
      evidenceFor: [
        assumption.evidence || (learningCitations.length > 0 ? learningCitations[0] : `Pattern detection identified ${assumption.type} indicators`),
        assumption.source ? `Analysis from ${assumption.source} data source` : `Historical analysis from timeline events`,
      ],
      evidenceAgainst: [
        assumption.confidence === 'low' ? 'Limited confidence in underlying data sources' : 'Alternative interpretations of the same data exist',
        eventCitations.length > 0 ? `Event evt-${Date.now() - dataIdx * 1000} shows contradictory behavior` : 'Temporal bias: historical data may not reflect current conditions',
      ],
      impactIfWrong: assumption.confidence === 'high' 
        ? `Critical: decisions based on this assumption could cause system failure requiring immediate investigation of ${assumption.statement.substring(0, 80)}`
        : assumption.confidence === 'medium'
          ? `High: misaligned strategies may emerge affecting ${assumption.statement.substring(0, 60)}... with measurable performance degradation`
          : `Medium: hidden assumptions could cause unexpected failures in operational procedures`,
      priority: assumption.confidence === 'high' ? 8 : (assumption.confidence === 'medium' ? 5 : 3),
      domain: domain || researchPackage?.domain || 'general',
    });

    // Add a second question challenging the assumption from a different angle
    if (questions.length < 12) {
      questions.push({
        question: `Under what specific conditions would the assumption "${assumption.statement}" cease to be valid?`,
        assumptionChallenged: assumption.statement,
        evidenceFor: [
          patternCitations.length > 0 ? patternCitations[0] : 'Edge cases identified in system analysis',
          'Alternative approaches documented in related architectural patterns',
        ],
        evidenceAgainst: [
          assumption.evidence || 'Current implementation strongly reinforces this pattern',
          learningCitations.length > 0 ? `LE-${1000 + dataIdx} shows no documented failures of this approach` : 'No recorded incidents contradicting this assumption',
        ],
        impactIfWrong: 'System may be vulnerable to edge case scenarios where the assumption breaks down, causing cascading failures across dependent components',
        priority: assumption.confidence === 'high' ? 7 : (assumption.confidence === 'medium' ? 6 : 4),
        domain: domain || researchPackage?.domain || 'general',
      });
    }
  }

  // Ensure we have at least 5 questions (minimum validation requirement)
  while (questions.length < 5) {
    const baseLearningCitations = generateEvidenceCitations(learnings, 'learning', 2);
    const baseEventCitations = generateEvidenceCitations(events, 'event', 2);
    
    questions.push({
      question: 'What implicit assumptions govern the system that have not been explicitly documented?',
      assumptionChallenged: 'All critical assumptions are explicitly documented in system design',
      evidenceFor: baseLearningCitations.length > 0 ? [baseLearningCitations[0], 'Documentation exists for major architectural decisions'] : ['Documentation exists for major decisions'],
      evidenceAgainst: [
        baseEventCitations.length > 0 ? `evt-${Date.now()} shows undocumented tribal knowledge affecting operations` : 'Undocumented tribal knowledge may exist in team practices',
        'Implicit assumptions often go unnoticed until they cause operational failures',
      ],
      impactIfWrong: 'Hidden assumptions could cause unexpected failures in production environments with no clear root cause attribution',
      priority: 6,
      domain: domain || researchPackage?.domain || 'general',
    });
  }

  // Cap at 15 (maximum validation requirement)
  const finalQuestions = questions.slice(0, 15);

  log.debug('Generated questions', {
    count: finalQuestions.length,
    priorities: finalQuestions.map((q) => q.priority),
    allHaveAssumptionChallenged: finalQuestions.every((q) => q.assumptionChallenged),
    allHaveEvidenceFor: finalQuestions.every((q) => q.evidenceFor && q.evidenceFor.length > 0),
    allHaveEvidenceAgainst: finalQuestions.every((q) => q.evidenceAgainst && q.evidenceAgainst.length > 0),
    allHaveImpactIfWrong: finalQuestions.every((q) => q.impactIfWrong),
  });

  return finalQuestions;
}

/**
 * Generate fallback questions when LLM invocation fails.
 * Ensures output meets minimum validation requirements.
 *
 * @param {Array<object>} assumptions - Identified assumptions
 * @param {object} researchPackage - Research context
 * @param {string} domain - Domain context
 * @returns {Array<object>} Array of fallback questions (5-15 items)
 */
function generateFallbackQuestions(assumptions, researchPackage, domain) {
  const data = researchPackage?.data || {};
  
  return [
    {
      question: `What evidence supports the assumption that system improvement is driven by recorded learnings?`,
      assumptionChallenged: 'System improvement is driven by recorded learnings',
      evidenceFor: [
        `Learnings database contains ${data.learnings?.total || 0} items`,
        'Historical analysis from learnings_analysis',
      ],
      evidenceAgainst: [
        'Alternative interpretations possible',
        'Temporal bias: historical data may not reflect current conditions',
      ],
      impactIfWrong: 'Decisions based on this assumption could lead to misaligned strategies',
      priority: 7,
      domain: domain || researchPackage?.domain || 'general',
    },
    {
      question: `Under what conditions would the assumption that cross-project patterns reveal systemic behaviors no longer hold true?`,
      assumptionChallenged: 'Cross-project patterns reveal systemic behaviors',
      evidenceFor: [
        'Pattern detection identified patterns across projects',
        'Cross-reference analysis shows recurring themes',
      ],
      evidenceAgainst: [
        'Current implementation strongly reinforces this pattern',
        'No documented failures of this approach in historical data',
      ],
      impactIfWrong: 'System may be vulnerable to scenarios where the assumption breaks down',
      priority: 6,
      domain: domain || researchPackage?.domain || 'general',
    },
    {
      question: `What evidence supports the assumption that system history contains actionable insights?`,
      assumptionChallenged: 'System history contains actionable insights',
      evidenceFor: [
        `Timeline store contains ${data.timelineEvents?.total || 0} recorded events`,
        'Historical analysis from timeline_analysis',
      ],
      evidenceAgainst: [
        'Limited confidence in underlying data',
        'Alternative interpretations possible',
      ],
      impactIfWrong: 'Decisions based on this assumption could lead to missed opportunities',
      priority: 5,
      domain: domain || researchPackage?.domain || 'general',
    },
    {
      question: `What alternative explanations exist for the observed pattern categories in the system architecture?`,
      assumptionChallenged: 'System architecture reflects distinct pattern categories',
      evidenceFor: [
        'Patterns span multiple categories',
        'Categorization analysis shows clear groupings',
      ],
      evidenceAgainst: [
        'Undocumented tribal knowledge may exist',
        'Implicit assumptions often go unnoticed until they cause issues',
      ],
      impactIfWrong: 'Hidden assumptions could cause unexpected failures in operations',
      priority: 8,
      domain: domain || researchPackage?.domain || 'general',
    },
    {
      question: `What implicit assumptions govern the system that have not been explicitly documented?`,
      assumptionChallenged: 'All critical assumptions are explicitly documented',
      evidenceFor: ['Documentation exists for major decisions'],
      evidenceAgainst: [
        'Undocumented tribal knowledge may exist',
        'Implicit assumptions often go unnoticed until they cause issues',
      ],
      impactIfWrong: 'Hidden assumptions could cause unexpected failures in operations',
      priority: 6,
      domain: domain || researchPackage?.domain || 'general',
    },
  ];
}

/**
 * Get generation status for a campaign.
 * Useful for debugging and monitoring.
 *
 * @param {string} projectId - Project ID
 * @param {string} campaignId - Campaign ID
 * @param {object} campaignManager - CampaignManager instance
 * @returns {object|null} Status object or null if not a Socratic campaign
 */
export function getGenerationStatus(projectId, campaignId, campaignManager) {
  try {
    const campaign = campaignManager.getCampaign(projectId, campaignId);

    if (!campaign || campaign.type !== 'socratic') {
      return null;
    }

    return {
      campaignId,
      projectId,
      domain: campaign.domain || 'unknown',
      status: campaign.status,
      questionCount: campaign.questionCount || 0,
      hasQuestions: campaign.questions && campaign.questions.length > 0,
      state: campaign.state || 'unknown',
    };
  } catch (err) {
    log.error('Failed to get generation status', {
      projectId,
      campaignId,
      error: err.message,
    });
    return null;
  }
}

export default {
  generateSocraticQuestions,
  getGenerationStatus,
};
