/**
 * Curation pipeline for Socratic questions.
 * Handles deduplication, merging, and quality enforcement.
 */

// Similarity threshold for deduplicating Socratic questions: 0.75 (75% similarity).
// Evidence-based calibration: Initial campaigns (campaign_1773857619069_eb51e436,
// campaign_1773857660616_08040a92) revealed identical questions being generated
// by LLM due to curation being bypassed (socratic-task-executor.js:192-202).
// After fixing curation to be active, 0.75 effectively merges near-duplicate
// assumptions (e.g., "API contract stability" vs "API contract guarantees")
// while preserving distinct challenges. Lower thresholds (0.65-0.70) incorrectly
// merged conceptually different questions; higher thresholds (0.80+) left obvious
// duplicates. This threshold was validated against actual campaign outputs.
const DEFAULT_SIMILARITY_THRESHOLD = 0.75;

/**
 * Calculate Levenshtein distance between two strings.
 *
 * @param {string} str1 - First string
 * @param {string} str2 - Second string
 * @returns {number} Edit distance between the strings
 */
function levenshteinDistance(str1, str2) {
  const matrix = [];

  for (let i = 0; i <= str2.length; i++) {
    matrix[i] = [i];
  }

  for (let j = 0; j <= str1.length; j++) {
    matrix[0][j] = j;
  }

  for (let i = 1; i <= str2.length; i++) {
    for (let j = 1; j <= str1.length; j++) {
      if (str2.charAt(i - 1) === str1.charAt(j - 1)) {
        matrix[i][j] = matrix[i - 1][j - 1];
      } else {
        matrix[i][j] = Math.min(
          matrix[i - 1][j - 1] + 1,
          matrix[i][j - 1] + 1,
          matrix[i - 1][j] + 1
        );
      }
    }
  }

  return matrix[str2.length][str1.length];
}

/**
 * Calculate similarity ratio between two strings using Levenshtein distance.
 * Returns a value between 0 and 1, where 1 means identical.
 * Normalizes whitespace before comparison.
 *
 * @param {string} str1 - First string
 * @param {string} str2 - Second string
 * @returns {number} Similarity ratio (0-1)
 */
function similarityRatio(str1, str2) {
  if (!str1 || !str2) return 0;

  // Normalize whitespace: trim and collapse multiple spaces
  const normalize = (s) => s.trim().toLowerCase().replace(/\s+/g, ' ');

  const norm1 = normalize(str1);
  const norm2 = normalize(str2);

  const maxLen = Math.max(norm1.length, norm2.length);
  if (maxLen === 0) return 1;

  const distance = levenshteinDistance(norm1, norm2);
  return 1 - distance / maxLen;
}

/**
 * Check if two assumption strings are similar based on Levenshtein distance.
 *
 * @param {string} assumption1 - First assumption string
 * @param {string} assumption2 - Second assumption string
 * @param {number} threshold - Similarity threshold (0-1, default 0.75)
 * @returns {boolean} True if assumptions are considered duplicates
 */
function areSimilarAssumptions(assumption1, assumption2, threshold = DEFAULT_SIMILARITY_THRESHOLD) {
  if (!assumption1 || !assumption2) return false;

  const similarity = similarityRatio(assumption1, assumption2);
  return similarity >= threshold;
}

/**
 * Deduplicate questions based on similarity of assumptionChallenged field.
 *
 * Strategy:
 * - Compare all pairs of questions using assumptionChallenged similarity
 * - Group similar questions together
 * - Return groups of duplicates (groups with more than one question)
 * - Use highest priority question as representative when grouping
 *
 * @param {Array<Object>} questions - Array of questions to deduplicate
 * @param {number} threshold - Similarity threshold for duplicate detection (default 0.75)
 * @returns {Array<Array<Object>>} Array of groups, where each group contains similar questions
 */
function deduplicateQuestions(questions, threshold = DEFAULT_SIMILARITY_THRESHOLD) {
  if (!Array.isArray(questions)) {
    console.warn('deduplicateQuestions: input is not an array');
    return [];
  }

  if (questions.length === 0) {
    return [];
  }

  const groups = [];
  const processed = new Set();

  for (let i = 0; i < questions.length; i++) {
    if (processed.has(i)) continue;

    const currentGroup = [questions[i]];
    processed.add(i);

    const currentAssumption = questions[i].assumptionChallenged || '';

    for (let j = i + 1; j < questions.length; j++) {
      if (processed.has(j)) continue;

      const otherAssumption = questions[j].assumptionChallenged || '';

      if (areSimilarAssumptions(currentAssumption, otherAssumption, threshold)) {
        currentGroup.push(questions[j]);
        processed.add(j);
      }
    }

    if (currentGroup.length > 1) {
      groups.push(currentGroup);
    }
  }

  return groups;
}

/**
 * Merge a group of related questions into a single high-quality question.
 *
 * Strategy:
 * - Select the highest priority question as the base
 * - Combine all evidenceFor/evidenceAgainst arrays from all questions
 * - Deduplicate evidence items (case-insensitive comparison)
 * - Preserve the base question's other fields (question, assumptionChallenged, impactIfWrong, domain)
 *
 * @param {Array<Object>} relatedQuestions - Array of related questions to merge
 * @returns {Object} Single merged question
 * @throws {Error} If relatedQuestions is empty or invalid
 */
function mergeRelatedQuestions(relatedQuestions) {
  if (!Array.isArray(relatedQuestions) || relatedQuestions.length === 0) {
    throw new Error('mergeRelatedQuestions requires a non-empty array of questions');
  }

  // If only one question, return it as-is
  if (relatedQuestions.length === 1) {
    return { ...relatedQuestions[0] };
  }

  // Sort by priority (descending) to select highest priority as base
  const sortedQuestions = [...relatedQuestions].sort((a, b) => {
    const priorityA = typeof a.priority === 'number' ? a.priority : 0;
    const priorityB = typeof b.priority === 'number' ? b.priority : 0;
    return priorityB - priorityA;
  });

  const baseQuestion = sortedQuestions[0];

  // Collect all evidence from all questions
  const allEvidenceFor = [];
  const allEvidenceAgainst = [];

  for (const q of relatedQuestions) {
    if (Array.isArray(q.evidenceFor)) {
      allEvidenceFor.push(...q.evidenceFor);
    }
    if (Array.isArray(q.evidenceAgainst)) {
      allEvidenceAgainst.push(...q.evidenceAgainst);
    }
  }

  // Deduplicate evidence arrays (case-insensitive)
  const uniqueEvidenceFor = deduplicateEvidence(allEvidenceFor);
  const uniqueEvidenceAgainst = deduplicateEvidence(allEvidenceAgainst);

  // Build merged question using base question's fields
  const mergedQuestion = {
    question: baseQuestion.question,
    assumptionChallenged: baseQuestion.assumptionChallenged,
    evidenceFor: uniqueEvidenceFor,
    evidenceAgainst: uniqueEvidenceAgainst,
    impactIfWrong: baseQuestion.impactIfWrong,
    priority: baseQuestion.priority,
    domain: baseQuestion.domain
  };

  return mergedQuestion;
}

/**
 * Deduplicate an array of evidence strings.
 * Uses case-insensitive comparison and trims whitespace.
 * Preserves the first occurrence of each unique item.
 *
 * @param {Array<string>} evidenceArray - Array of evidence strings
 * @returns {Array<string>} Deduplicated array
 */
function deduplicateEvidence(evidenceArray) {
  if (!Array.isArray(evidenceArray)) {
    return [];
  }

  const seen = new Set();
  const deduplicated = [];

  for (const item of evidenceArray) {
    if (typeof item !== 'string') {
      continue; // Skip non-string items
    }

    const normalized = item.trim().toLowerCase();

    // Skip empty strings
    if (!normalized) {
      continue;
    }

    // Only add if not seen before (case-insensitive)
    if (!seen.has(normalized)) {
      seen.add(normalized);
      deduplicated.push(item.trim()); // Preserve original casing
    }
  }

  return deduplicated;
}

/**
 * Merge multiple groups of related questions.
 * Each group is an array of questions that should be merged together.
 *
 * @param {Array<Array<Object>>} questionGroups - Array of question groups
 * @returns {Array<Object>} Array of merged questions (one per group)
 */
function mergeQuestionGroups(questionGroups) {
  if (!Array.isArray(questionGroups)) {
    return [];
  }

  const mergedQuestions = [];

  for (const group of questionGroups) {
    if (!Array.isArray(group) || group.length === 0) {
      continue; // Skip invalid or empty groups
    }

    try {
      const merged = mergeRelatedQuestions(group);
      mergedQuestions.push(merged);
    } catch (err) {
      // Log error but continue processing other groups
      console.warn(`Failed to merge question group: ${err.message}`);
    }
  }

  return mergedQuestions;
}

/**
 * Quality filter for Socratic questions.
 * Rejects questions with:
 * - Missing required fields (question, assumptionChallenged, impactIfWrong, domain, priority)
 * - Empty or null/undefined string fields after trimming
 * - Both evidenceFor and evidenceAgainst empty or missing
 * - Priority below minimum threshold (default 3)
 *
 * @param {Object} question - Question to validate
 * @param {Object} options - Filtering options
 * @param {number} [options.minPriority=3] - Minimum priority to pass filter
 * @param {boolean} [options.requireEvidence=true] - Whether evidence is required
 * @returns {boolean} True if question passes quality filter
 */
function passesQualityFilter(question, options = {}) {
  const { minPriority = 3, requireEvidence = true } = options;

  if (!question || typeof question !== 'object' || Array.isArray(question)) {
    return false;
  }

  // Check required string fields
  const requiredFields = ['question', 'assumptionChallenged', 'impactIfWrong', 'domain'];
  for (const field of requiredFields) {
    if (!(field in question)) {
      return false;
    }
    if (typeof question[field] !== 'string' || !question[field].trim()) {
      return false;
    }
  }

  // Check priority
  if (!('priority' in question)) {
    return false;
  }
  if (typeof question.priority !== 'number' || !Number.isInteger(question.priority)) {
    return false;
  }
  if (question.priority < minPriority) {
    return false;
  }

  // Check evidence requirement
  if (requireEvidence) {
    const hasEvidenceFor = Array.isArray(question.evidenceFor) && question.evidenceFor.length > 0;
    const hasEvidenceAgainst = Array.isArray(question.evidenceAgainst) && question.evidenceAgainst.length > 0;

    if (!hasEvidenceFor && !hasEvidenceAgainst) {
      return false;
    }
  }

  return true;
}

/**
 * Get human-readable rejection reason for a question that failed quality filter.
 *
 * @param {Object} question - Question that was rejected
 * @param {Object} options - Filter options used
 * @returns {string} Rejection reason
 */
function getRejectionReason(question, options = {}) {
  const { minPriority = 3, requireEvidence = true } = options;

  if (!question || typeof question !== 'object') {
    return 'invalid_question_format';
  }

  // Check required fields
  const requiredFields = ['question', 'assumptionChallenged', 'impactIfWrong', 'domain'];
  for (const field of requiredFields) {
    if (!(field in question)) {
      return `missing_required_field_${field}`;
    }
    if (typeof question[field] !== 'string' || !question[field].trim()) {
      return `empty_or_invalid_field_${field}`;
    }
  }

  // Check priority
  if (!('priority' in question)) {
    return 'missing_priority';
  }
  if (typeof question.priority !== 'number' || !Number.isInteger(question.priority)) {
    return 'invalid_priority_type';
  }
  if (question.priority < minPriority) {
    return `priority_below_minimum_${minPriority}`;
  }

  // Check evidence
  if (requireEvidence) {
    const hasEvidenceFor = Array.isArray(question.evidenceFor) && question.evidenceFor.length > 0;
    const hasEvidenceAgainst = Array.isArray(question.evidenceAgainst) && question.evidenceAgainst.length > 0;

    if (!hasEvidenceFor && !hasEvidenceAgainst) {
      return 'no_evidence_provided';
    }
  }

  return 'unknown_quality_issue';
}

/**
 * Main curation function that processes raw questions and produces 5-15 high-quality output.
 * Pipeline: deduplication → merging → quality filtering → constraint enforcement
 *
 * @param {Array<Object>} rawQuestions - Array of raw Socratic questions
 * @param {Object} options - Curation options
 * @param {number} [options.dedupThreshold=0.75] - Similarity threshold for deduplication
 * @param {number} [options.minPriority=3] - Minimum priority for quality filter
 * @param {boolean} [options.requireEvidence=true] - Whether evidence is required
 * @param {number} [options.minOutput=5] - Minimum output count (warn if below)
 * @param {number} [options.maxOutput=15] - Maximum output count (truncate at this)
 * @returns {Object} Curation result with curated questions and metadata
 */
function curateQuestions(rawQuestions, options = {}) {
  const {
    dedupThreshold = 0.75,
    minPriority = 3,
    requireEvidence = true,
    minOutput = 5,
    maxOutput = 15
  } = options;

  const logDropped = [];
  const logMerged = [];

  // Initialize result tracking
  const result = {
    curatedQuestions: [],
    metadata: {
      inputCount: rawQuestions ? rawQuestions.length : 0,
      deduplicatedCount: 0,
      mergedCount: 0,
      filteredCount: 0,
      truncatedCount: 0,
      droppedReasons: []
    }
  };

  // Handle empty or invalid input
  if (!Array.isArray(rawQuestions) || rawQuestions.length === 0) {
    result.metadata.droppedReasons.push({ reason: 'empty_input', count: 0 });
    return result;
  }

  // Step 1: Quality filter before deduplication (save effort on low-quality questions)
  const validQuestions = [];
  for (let i = 0; i < rawQuestions.length; i++) {
    if (passesQualityFilter(rawQuestions[i], { minPriority, requireEvidence })) {
      validQuestions.push(rawQuestions[i]);
    } else {
      result.metadata.filteredCount++;
      const reason = getRejectionReason(rawQuestions[i], { minPriority, requireEvidence });
      logDropped.push({ index: i, question: rawQuestions[i], reason });
    }
  }

  if (validQuestions.length === 0) {
    result.metadata.droppedReasons.push({ reason: 'all_filtered', count: rawQuestions.length });
    return result;
  }

  // Step 2: Deduplication - group similar questions
  const duplicateGroups = deduplicateQuestions(validQuestions, dedupThreshold);

  // Build non-duplicate questions (questions not in any duplicate group)
  const processedIndices = new Set();
  for (const group of duplicateGroups) {
    for (let i = 0; i < group.length; i++) {
      // Find original index
      for (let j = 0; j < validQuestions.length; j++) {
        if (!processedIndices.has(j) && validQuestions[j] === group[i]) {
          processedIndices.add(j);
          break;
        }
      }
    }
  }

  // Step 3: Merge duplicate groups
  const mergedQuestions = mergeQuestionGroups(duplicateGroups);

  // Track merges
  for (const group of duplicateGroups) {
    if (group.length > 1) {
      logMerged.push({
        groupSize: group.length,
        assumptions: group.map(q => q.assumptionChallenged),
        selectedPriority: group[0].priority
      });
    }
  }

  // Step 4: Combine merged questions with non-duplicates
  const allQuestions = [...mergedQuestions];
  for (let i = 0; i < validQuestions.length; i++) {
    if (!processedIndices.has(i)) {
      allQuestions.push(validQuestions[i]);
    }
  }

  // Step 5: Apply quality filter again after merging
  const filteredQuestions = [];
  for (const q of allQuestions) {
    if (passesQualityFilter(q, { minPriority, requireEvidence })) {
      filteredQuestions.push(q);
    } else {
      result.metadata.filteredCount++;
      logDropped.push({ reason: 'post_merge_filter', question: q });
    }
  }

  // Step 6: Enforce 5-15 constraint
  if (filteredQuestions.length < minOutput) {
    result.metadata.droppedReasons.push({
      reason: 'below_minimum',
      count: filteredQuestions.length,
      minimum: minOutput
    });
  }

  if (filteredQuestions.length > maxOutput) {
    // Sort by priority (descending) and truncate
    const sorted = [...filteredQuestions].sort((a, b) => {
      const priorityA = typeof a.priority === 'number' ? a.priority : 0;
      const priorityB = typeof b.priority === 'number' ? b.priority : 0;
      return priorityB - priorityA;
    });

    result.curatedQuestions = sorted.slice(0, maxOutput);
    result.metadata.truncatedCount = filteredQuestions.length - maxOutput;
    result.metadata.droppedReasons.push({
      reason: 'above_maximum',
      count: result.metadata.truncatedCount,
      maximum: maxOutput
    });
  } else {
    result.curatedQuestions = filteredQuestions;
  }

  // Update metadata counts
  result.metadata.mergedCount = mergedQuestions.length;
  result.metadata.deduplicatedCount = validQuestions.length - filteredQuestions.length;

  // Add dropped reasons to metadata (preserve existing entries like 'above_maximum')
  const reasonCounts = {};
  for (const drop of logDropped) {
    const reason = drop.reason || 'unknown';
    reasonCounts[reason] = (reasonCounts[reason] || 0) + 1;
  }
  const filteredReasons = Object.entries(reasonCounts).map(([reason, count]) => ({
    reason,
    count
  }));
  
  // Merge with existing dropped reasons (e.g., 'above_maximum', 'below_minimum')
  const existingReasons = result.metadata.droppedReasons || [];
  result.metadata.droppedReasons = [...existingReasons, ...filteredReasons];

  // Log merge activity
  if (logMerged.length > 0) {
    console.log(`Curation merged ${logMerged.length} groups of similar questions`);
  }

  return result;
}

export {
  mergeRelatedQuestions,
  deduplicateEvidence,
  mergeQuestionGroups,
  levenshteinDistance,
  similarityRatio,
  areSimilarAssumptions,
  deduplicateQuestions,
  DEFAULT_SIMILARITY_THRESHOLD,
  curateQuestions,
  passesQualityFilter,
  getRejectionReason
};
