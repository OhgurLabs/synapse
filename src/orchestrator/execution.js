/**
 * Execution mode ÃÂÃÂ¢ÃÂÃÂÃÂÃÂ prompt builders and dispatch logic.
 *
 * When directed segments contain execution keywords, agents get an
 * execution-focused prompt with higher tool budgets. After execution,
 * a non-executing agent audits and another summarizes.
 */

import { existsSync } from 'fs';
import { createLogger } from '../logger.js';
import { setAgentThinking, setAgentIdle } from './health-aggregator.js';
import { CATEGORIES } from '../utils/error-registry.js';
import { startSpan, endSpan, setSpanStatus, addSpanEvent } from '../tracing.js';
import { classifyFailure } from '../failure-classification.js';

const log = createLogger('execution');

function getTraceId(span) {
  const traceId = span?.spanContext?.().traceId;
  if (!traceId || /^0+$/.test(traceId)) return null;
  return traceId;
}

/**
 * Create the execution system. Returns dispatchExecution.
 *
 * @param {Object} deps - Injected dependencies
 * @param {Function} deps.getAgents      - () => agents registry object
 * @param {Object}  deps.stateManager    - StateManager instance
 * @param {Object}  deps.config          - Config object
 * @param {Function} deps.addMessage     - (projectId, channelId, speaker, content, type, meta) => void
 * @param {Function} deps.broadcastToChannel - (projectId, channelId, msg) => void
 * @param {Set}      deps.thinkingAgents - Set of agentIds currently thinking
 * @param {Function} deps.getAgentTimeout - (agentId) => number
 * @param {Function} deps.withTimeout    - (Promise, timeout) => Promise
 * @param {Function} deps.isNoiseResponse - (content) => boolean
 * @param {string}  deps.PROJECT_DIR     - Default project directory
 * @param {string[]} deps.EXECUTION_CAPABLE - List of agentIds capable of execution
 * @param {Function} deps.canBypassPermissions - (agentId) => boolean
 * @param {Function} deps.auditDispatch  - Audit log function
 * @param {Function} deps.isAgentCoolingDown - (agentId) => boolean
 * @param {Object}  deps.errorRegistry   - ErrorRegistry instance
 * @param {Object}  deps.CATEGORIES      - Error categories constants
 * @param {Object}  deps.guardrailChain  - GuardrailChain instance
 * @param {Object}  deps.operatorAuditStore - OperatorAuditStore instance
 * @param {Object}  deps.dispatchLog     - DispatchLog instance
 * @param {Object}  deps.events          - EventBus instance
 * @param {Object}  deps.toolDistributionService - ToolDistributionService instance
 * @param {Object}  deps.taskManager     - TaskManager instance (optional, for subtask error handling)
 * @param {Object}  deps.timelineStore   - TimelineStore instance (optional, for tool invocation events)
 */
export function createExecutionSystem(deps) {
  const {
    getAgents, stateManager, config, addMessage, broadcastToChannel,
    thinkingAgents, getAgentTimeout, withTimeout, isNoiseResponse,
    PROJECT_DIR, EXECUTION_CAPABLE,
    canBypassPermissions, auditDispatch, isAgentCoolingDown,
    errorRegistry, CATEGORIES,
    guardrailChain, operatorAuditStore, dispatchLog, events,
    toolDistributionService,
    taskManager,
    timelineStore,
    prStore,                          // BYOH PR workflow Phase 1.4 — chat-execute auto-PR (optional)
  } = deps;

  const EXECUTION_MAX_TURNS = config.orchestrator.executionMaxTurns;
  const EXECUTION_TIMEOUT_MULTIPLIER = config.orchestrator.executionTimeoutMultiplier;

  function createToolInvocationCapture(agentId, executionContext = null) {
    const invocations = [];

    return {
      capture: (toolName, args, result) => {
        // Detect if this is a fallback result from ToolFallbackService
        const isFallback = result.context?.isFallback === true || 
                          result.isFallback === true ||
                          result.code === 'ALL_FALLBACKS_FAILED' ||
                          result.code === 'NO_FALLBACK_CANDIDATES' ||
                          result.code === 'NO_COMPATIBLE_FALLBACK_TOOLS';
        
        const fallbackContext = result.context || null;
        
        const invocation = {
          toolName,
          args,
          result,
          status: result.status || (result.error ? 'error' : 'success'),
          elapsedMs: result.elapsedMs || 0,
          timestamp: result.timestamp || new Date().toISOString(),
          agentId,
          code: result.code || null,
          error: result.error || null,
          taskId: executionContext?.taskId || null,
          subtaskId: executionContext?.subtaskId || null,
          campaignId: executionContext?.campaignId || null,
          provider: executionContext?.agentProvider || null,
          source: result.source || null,
          serverSource: result.serverSource || null,
          // Fallback metadata
          isFallback: isFallback,
          fallbackToolName: fallbackContext?.fallbackToolName || null,
          fallbackServerId: fallbackContext?.fallbackServerId || null,
          attemptIndex: fallbackContext?.attemptIndex || null,
          attemptedFallbacks: fallbackContext?.attemptedFallbacks || null,
          fallbackErrors: fallbackContext?.fallbackErrors || null,
          correlationId: fallbackContext?.correlationId || null,
        };
        invocations.push(invocation);

        if (timelineStore) {
          timelineStore.ingestToolInvocation(invocation);
        }

        return invocation;
      },
      getInvocations: () => [...invocations],
      clear: () => invocations.length = 0,
    };
  }

  function handleMcpToolError(projectId, taskId, subtaskId, agentId, toolInvocation, agentProvider) {
    if (!taskManager) return false;

    const { toolName, args, result, code, error, context } = toolInvocation;
    const isError = result?.status === 'error' || error !== null;

    if (!isError) return false;

    // Check if this is a fallback result from ToolFallbackService
    const isFallbackResult = context?.isFallback === true || 
                            result?.context?.isFallback === true ||
                            code === 'ALL_FALLBACKS_FAILED' ||
                            code === 'NO_FALLBACK_CANDIDATES' ||
                            code === 'NO_COMPATIBLE_FALLBACK_TOOLS' ||
                            code === 'FALLBACK_WORKFLOW_ERROR';
    
    const fallbackContext = context || result?.context || null;
    
    const errorDetails = {
      code,
      message: error || result?.error || 'Unknown MCP tool error',
      toolName,
      args,
      timestamp: new Date().toISOString(),
      isFallback: isFallbackResult,
    };

    // Add fallback-specific metadata if available
    if (isFallbackResult) {
      if (fallbackContext?.fallbackToolName) {
        errorDetails.fallbackToolName = fallbackContext.fallbackToolName;
        errorDetails.fallbackServerId = fallbackContext.fallbackServerId;
        errorDetails.attemptIndex = fallbackContext.attemptIndex;
        errorDetails.attemptedFallbacks = fallbackContext.attemptedFallbacks;
        errorDetails.fallbackErrors = fallbackContext.fallbackErrors;
        errorDetails.correlationId = fallbackContext.correlationId;
      }
      
      // Determine fallback failure reason for task state
      if (code === 'NO_FALLBACK_CANDIDATES') {
        errorDetails.fallbackFailureReason = 'no_candidates';
        errorDetails.fallbackMessage = 'No alternative tools available in operation category';
      } else if (code === 'NO_COMPATIBLE_FALLBACK_TOOLS') {
        errorDetails.fallbackFailureReason = 'no_compatible';
        errorDetails.fallbackMessage = 'Alternative tools found but none compatible with parameters';
      } else if (code === 'ALL_FALLBACKS_FAILED') {
        errorDetails.fallbackFailureReason = 'all_failed';
        errorDetails.fallbackMessage = `All ${fallbackContext?.attemptedFallbacks?.length || 0} fallback attempts failed`;
      } else if (code === 'FALLBACK_WORKFLOW_ERROR') {
        errorDetails.fallbackFailureReason = 'workflow_error';
        errorDetails.fallbackMessage = 'Fallback workflow execution failed';
      }
    }

    try {
      const classified = classifyFailure(errorDetails.message);

      const metaUpdate = {
        mcpToolError: errorDetails,
        mcpFailureType: classified,
      };
      
      // Add fallback metadata to task state if this is a fallback scenario
      if (isFallbackResult) {
        metaUpdate.mcpFallbackAttempted = true;
        metaUpdate.mcpFallbackStatus = code;
        metaUpdate.mcpFallbackReason = errorDetails.fallbackFailureReason || 'unknown';
        
        if (errorDetails.fallbackToolName) {
          metaUpdate.mcpFallbackTool = errorDetails.fallbackToolName;
          metaUpdate.mcpFallbackServer = errorDetails.fallbackServerId;
        }
        
        if (errorDetails.attemptedFallbacks && errorDetails.attemptedFallbacks.length > 0) {
          metaUpdate.mcpAttemptedFallbacks = errorDetails.attemptedFallbacks;
        }
      }

      // Construct appropriate error message based on fallback status
      let errorMessage = `MCP tool error: ${toolName} - ${errorDetails.message}`;
      if (isFallbackResult && errorDetails.fallbackFailureReason) {
        if (errorDetails.fallbackFailureReason === 'no_candidates') {
          errorMessage = `MCP tool unavailable: ${toolName} - no fallback tools available in operation category`;
        } else if (errorDetails.fallbackFailureReason === 'no_compatible') {
          errorMessage = `MCP tool unavailable: ${toolName} - no compatible fallback tools found`;
        } else if (errorDetails.fallbackFailureReason === 'all_failed') {
          errorMessage = `MCP tool unavailable: ${toolName} - all fallback attempts exhausted`; 
        }
      }

      taskManager.updateSubtask(projectId, taskId, subtaskId, {
        error: errorMessage,
        meta: metaUpdate,
      }, agentId);

      // Log structured error for complete fallback failure
      if (isFallbackResult && (code === 'NO_FALLBACK_CANDIDATES' || code === 'NO_COMPATIBLE_FALLBACK_TOOLS' || code === 'ALL_FALLBACKS_FAILED')) {
        log.error('MCP tool fallback failed completely', {
          projectId,
          taskId, 
          subtaskId,
          agentId,
          primaryTool: toolName,
          fallbackStatus: code,
          fallbackReason: errorDetails.fallbackFailureReason,
          attemptedFallbacks: errorDetails.attemptedFallbacks?.length || 0,
          correlationId: errorDetails.correlationId,
          message: errorDetails.fallbackMessage || errorDetails.message,
        });
      }

      // Escalate on circuit open or server not connected (including fallback scenarios)
      if (code === 'CIRCUIT_OPEN' || code === 'SERVER_NOT_CONNECTED' || 
          (isFallbackResult && (code === 'ALL_FALLBACKS_FAILED' || code === 'NO_FALLBACK_CANDIDATES'))) {
        // Pin claim generation for ABA protection (#108 / audit 2026-08-11).
        const claimedAt = taskManager.getTask?.(projectId, taskId)
          ?.subtasks?.find(s => s.id === subtaskId)?.claimedAt;
        const escalated = taskManager.escalateSubtask(
          projectId, taskId, subtaskId, agentProvider,
          { agentId, claimedAt: claimedAt || undefined },
        );
        if (escalated === 'stale') return escalated; // claim changed hands — outcome superseded
        if (escalated) {
          log.info('MCP tool error escalated', {
            projectId, taskId, subtaskId, agentId, toolName, code,
            isFallback: isFallbackResult,
            fallbackReason: errorDetails.fallbackFailureReason,
          });
        }
        return escalated;
      }
    } catch (err) {
      log.warn('Failed to handle MCP tool error in subtask', {
        projectId, taskId, subtaskId, agentId, error: err.message,
      });
    }

    return false;
  }

  function wrapToolDistributionService(originalService, capture, executionContext = null) {
    if (!originalService) return null;

    const streamingState = new Map();

    function updateStreamingSubtask(projectId, taskId, subtaskId, agentId, toolName, chunkData, isFinal = false) {
      if (!taskManager || !subtaskId) return;

      try {
        const stateKey = `${taskId}:${subtaskId}:${toolName}`;
        let existingState = streamingState.get(stateKey);

        if (!existingState) {
          existingState = {
            args: {},
            chunks: [],
            chunkCount: 0,
            startedAt: new Date().toISOString(),
          };
          streamingState.set(stateKey, existingState);
        }

        if (!isFinal) {
          existingState.chunks.push({
            data: chunkData,
            timestamp: new Date().toISOString(),
            index: existingState.chunkCount++,
          });

          taskManager.updateSubtask(projectId, taskId, subtaskId, {
            meta: {
              streamingChunks: existingState.chunks,
              streamingStatus: {
                toolName,
                status: 'streaming',
                chunkCount: existingState.chunkCount,
                startedAt: existingState.startedAt,
                lastChunkAt: new Date().toISOString(),
              },
            },
          }, agentId);
        } else {
          const finalStreamingStatus = {
            toolName,
            status: 'complete',
            totalChunks: existingState.chunkCount,
            startedAt: existingState.startedAt,
            completedAt: new Date().toISOString(),
          };

          const startedTime = existingState.startedAt ? new Date(existingState.startedAt).getTime() : Date.now();
          const elapsedMs = Date.now() - startedTime;

          const toolResult = {
            toolName,
            args: existingState.args || {},
            result: chunkData,
            status: 'success',
            elapsedMs,
            timestamp: new Date().toISOString(),
            streaming: true,
            chunkCount: existingState.chunkCount,
          };

          taskManager.updateSubtask(projectId, taskId, subtaskId, {
            meta: {
              streamingStatus: finalStreamingStatus,
            },
            toolResults: [toolResult],
          }, agentId);

          streamingState.delete(stateKey);
        }
      } catch (err) {
        log.warn('Failed to update streaming subtask state', {
          projectId: executionContext?.projectId,
          taskId: executionContext?.taskId,
          subtaskId: executionContext?.subtaskId,
          toolName,
          error: err.message,
        });
      }
    }

    return new Proxy(originalService, {
      get(target, prop, receiver) {
        if (prop === 'invokeTool') {
          return async function (agentId, toolName, toolArgs = {}) {
            const startTime = Date.now();

            try {
              // Build context object from executionContext
              const invocationContext = executionContext ? {
                taskId: executionContext.taskId,
                subtaskId: executionContext.subtaskId,
                campaignId: executionContext.campaignId,
                dispatchId: executionContext.dispatchId,
                traceId: executionContext.traceId,
              } : {};

              const result = await Reflect.apply(target.invokeTool, target, [agentId, toolName, toolArgs, invocationContext]);
              const elapsedMs = Date.now() - startTime;

              const capturedResult = {
                ...result,
                elapsedMs,
                timestamp: new Date().toISOString(),
              };

              const invocation = capture.capture(toolName, toolArgs, capturedResult);

              if (executionContext && (result?.status === 'error' || result?.error)) {
                handleMcpToolError(
                  executionContext.projectId,
                  executionContext.taskId,
                  executionContext.subtaskId,
                  agentId,
                  invocation,
                  executionContext.agentProvider
                );
              } else if (executionContext && taskManager && result?.status === 'success') {
                const toolResult = {
                  toolName,
                  args: toolArgs,
                  result: result.result || result.data || result,
                  status: 'success',
                  elapsedMs,
                  timestamp: capturedResult.timestamp,
                };

                taskManager.updateSubtask(
                  executionContext.projectId,
                  executionContext.taskId,
                  executionContext.subtaskId,
                  {
                    toolResults: [toolResult],
                  },
                  agentId
                );
              }

              return result;
            } catch (err) {
              const elapsedMs = Date.now() - startTime;

              const errorResult = {
                status: 'error',
                error: err.message,
                code: err.code || 'INVOCATION_FAILED',
                elapsedMs,
                timestamp: new Date().toISOString(),
              };

              const invocation = capture.capture(toolName, toolArgs, errorResult);

              if (executionContext) {
                handleMcpToolError(
                  executionContext.projectId,
                  executionContext.taskId,
                  executionContext.subtaskId,
                  agentId,
                  invocation,
                  executionContext.agentProvider
                );
              }

              throw err;
            }
          };
        }

        if (prop === 'invokeToolWithStreaming') {
          return async function (agentId, toolName, toolArgs = {}, options = {}) {
            const { onChunk, onTimeout, timeoutMs } = options;
            const startTime = Date.now();
            const chunks = [];

            const stateKey = `${executionContext?.taskId}:${executionContext?.subtaskId}:${toolName}`;
            streamingState.set(stateKey, {
              args: toolArgs,
              chunks: [],
              chunkCount: 0,
              startedAt: new Date().toISOString(),
            });

            const wrappedOnChunk = (chunk) => {
              chunks.push(chunk);

              if (executionContext && taskManager) {
                updateStreamingSubtask(
                  executionContext.projectId,
                  executionContext.taskId,
                  executionContext.subtaskId,
                  agentId,
                  toolName,
                  chunk.data,
                  chunk.final || false
                );
              }

              if (typeof onChunk === 'function') {
                onChunk(chunk);
              }
            };

            try {
              // Build context object from executionContext
              const invocationContext = executionContext ? {
                taskId: executionContext.taskId,
                subtaskId: executionContext.subtaskId,
                campaignId: executionContext.campaignId,
                dispatchId: executionContext.dispatchId,
                traceId: executionContext.traceId,
              } : {};

              const streamingOptions = {
                ...options,
                onChunk: wrappedOnChunk,
                timeoutMs: timeoutMs ?? config.mcp.toolInvocationTimeoutMs,
              };

              if (onTimeout) {
                streamingOptions.onTimeout = (timeoutInfo) => {
                  if (executionContext && taskManager) {
                    taskManager.updateSubtask(
                      executionContext.projectId,
                      executionContext.taskId,
                      executionContext.subtaskId,
                      {
                        meta: {
                          streamingStatus: {
                            toolName,
                            status: 'timeout',
                            chunkCount: chunks.length,
                            timeoutMs: timeoutInfo.timeoutMs,
                            elapsedMs: timeoutInfo.elapsedMs,
                          },
                        },
                      },
                      agentId
                    );
                  }
                  onTimeout(timeoutInfo);
                };
              }

              const result = await Reflect.apply(
                target.invokeToolWithStreaming,
                target,
                [agentId, toolName, toolArgs, invocationContext, streamingOptions]
              );

              const elapsedMs = Date.now() - startTime;

              if (result.status === 'success' && executionContext && taskManager) {
                const finalChunk = chunks[chunks.length - 1];
                if (finalChunk && finalChunk.final) {
                  streamingState.delete(stateKey);
                }
              }

              const capturedResult = {
                ...result,
                elapsedMs,
                timestamp: new Date().toISOString(),
                streaming: true,
                chunkCount: chunks.length,
              };

              const invocation = capture.capture(toolName, toolArgs, capturedResult);

              if (executionContext && result?.status === 'error') {
                taskManager.updateSubtask(
                  executionContext.projectId,
                  executionContext.taskId,
                  executionContext.subtaskId,
                  {
                    meta: {
                      streamingStatus: {
                        toolName,
                        status: 'error',
                        error: result.error,
                        code: result.code,
                        chunkCount: chunks.length,
                      },
                    },
                  },
                  agentId
                );

                handleMcpToolError(
                  executionContext.projectId,
                  executionContext.taskId,
                  executionContext.subtaskId,
                  agentId,
                  invocation,
                  executionContext.agentProvider
                );
              }

              return result;
            } catch (err) {
              const elapsedMs = Date.now() - startTime;

              const errorResult = {
                status: 'error',
                error: err.message,
                code: err.code || 'INVOCATION_FAILED',
                elapsedMs,
                timestamp: new Date().toISOString(),
                streaming: true,
                chunkCount: chunks.length,
              };

              if (executionContext && taskManager) {
                taskManager.updateSubtask(
                  executionContext.projectId,
                  executionContext.taskId,
                  executionContext.subtaskId,
                  {
                    meta: {
                      streamingStatus: {
                        toolName,
                        status: 'error',
                        error: err.message,
                        code: err.code || 'INVOCATION_FAILED',
                        chunkCount: chunks.length,
                      },
                    },
                  },
                  agentId
                );
              }

              streamingState.delete(stateKey);

              const invocation = capture.capture(toolName, toolArgs, errorResult);

              if (executionContext) {
                handleMcpToolError(
                  executionContext.projectId,
                  executionContext.taskId,
                  executionContext.subtaskId,
                  agentId,
                  invocation,
                  executionContext.agentProvider
                );
              }

              throw err;
            }
          };
        }

        return Reflect.get(target, prop, receiver);
      },
    });
  }

  function buildExecutionPrompt(agentName, projectId, channelId, task, threadId = null, threadLabel = null, toolService = toolDistributionService) {
    const agents = getAgents();
    const agentId = agentName.toLowerCase();
    const agent = agents[agentId];
    const projectDir = stateManager.getProject(projectId)?.projectDir || PROJECT_DIR;
    const threadPart = threadLabel ? ` Thread: "${threadLabel}".` : '';

    const lines = [];
    if (agent?.persona) { lines.push(agent.persona, '\n---'); }
    lines.push('MODE: EXECUTION');
    lines.push(`Project: "${projectId}", Channel: #${channelId}.${threadPart}`);
    lines.push(`Working directory: ${projectDir}`);
    lines.push('', 'You are in EXECUTION MODE - answer the task below directly and concretely.');
    lines.push('Use your tools as appropriate: read files, edit code, run commands, or fetch information - whatever the task requires.');
    lines.push('If the task asks a question, answer it. If it asks for a change, make it. Do not defer or discuss the approach instead of doing it.');
    lines.push('When done, give a concise summary of what you found or changed.');
    lines.push('', `TASK: ${task}`);

    // Inject MCP tool catalog if available
    if (toolService) {
      const toolCatalog = toolService.getToolSummaryForAgent(agentId);
      if (toolCatalog) {
        lines.push('', toolCatalog);
      }
    }

    // Inject architecture context if CLAUDE.md or ARCHITECTURE.md exists in project dir
    const archFiles = ['CLAUDE.md', 'ARCHITECTURE.md']
      .map(f => projectDir + '/' + f)
      .filter(p => existsSync(p));
    if (archFiles.length > 0) {
      lines.push('');
      lines.push('## Architecture Context');
      lines.push(`Before starting, consult: ${archFiles.map(p => '`' + p + '`').join(', ')}`);
      lines.push('These files contain machine topology, file paths, conventions, and working rules. Read them when uncertain about where things live or how the system is structured.');
    }

    if (threadId) {
      const threadMsgs = stateManager.getThreadMessages(projectId, channelId, threadId, 10);
      const historyMsgs = threadMsgs.filter(m => m.type === 'message' && m.content);
      if (historyMsgs.length > 0) {
        lines.push('\n--- Recent discussion context (for reference only ÃÂÃÂ¢ÃÂÃÂÃÂÃÂ focus on EXECUTING) ---');
        for (const m of historyMsgs.slice(-8)) {
          const content = m.content?.length > 200 ? m.content.slice(0, 200) + '...' : m.content;
          lines.push(`[${m.speaker}]: ${content}`);
        }
        lines.push('--- End context ---');
      }
    }
    return lines.join('\n');
  }

  function buildAuditPrompt(auditorName, projectId, channelId, executors, executionResults, threadId = null, threadLabel = null) {
    const agents = getAgents();
    const agent = agents[auditorName.toLowerCase()];
    const threadPart = threadLabel ? ` Thread: "${threadLabel}".` : '';

    const lines = [];
    if (agent?.persona) { lines.push(agent.persona, '\n---'); }
    lines.push('MODE: AUDIT');
    lines.push(`Project: "${projectId}", Channel: #${channelId}.${threadPart}`);
    lines.push('', `The following agent(s) just executed tasks: ${executors.join(', ')}`);
    lines.push('Review their execution results below. Check for:');
    lines.push('- Correctness: Did they implement what was asked?');
    lines.push('- Quality: Any bugs, edge cases, or missing error handling?');
    lines.push('- Completeness: Was anything missed?');
    lines.push('Provide a concise review. Flag issues if found, approve if clean.', '');

    for (const [executor, result] of Object.entries(executionResults)) {
      let content;
      if (typeof result === 'string') {
        content = result?.length > 1500 ? result.slice(0, 1500) + '\n... (truncated)' : result;
      } else if (typeof result === 'object' && result !== null) {
        content = result.response || result.error || '(no output)';
        if (content?.length > 1500) {
          content = content.slice(0, 1500) + '\n... (truncated)';
        }
        if (result.toolInvocations && result.toolInvocations.length > 0) {
          content += '\n\nTool invocations: ' + result.toolInvocations.map(i => `${i.toolName} (${i.status})`).join(', ');
        }
      } else {
        content = '(no output)';
      }
      lines.push(`--- ${executor}'s execution result ---`, content || '(no output)', '---');
    }
    return lines.join('\n');
  }

  function buildSummaryPrompt(summarizerName, projectId, channelId, executors, executionResults, threadId = null, threadLabel = null) {
    const agents = getAgents();
    const agent = agents[summarizerName.toLowerCase()];
    const threadPart = threadLabel ? ` Thread: "${threadLabel}".` : '';

    const lines = [];
    if (agent?.persona) { lines.push(agent.persona, '\n---'); }
    lines.push('MODE: SUMMARY');
    lines.push(`Project: "${projectId}", Channel: #${channelId}.${threadPart}`);
    lines.push('', 'Execution just completed. Provide a concise summary covering:');
    lines.push('1. What was done (changes made)');
    lines.push('2. Why (the motivation/task)');
    lines.push('3. Next steps (what should happen next)', '');

    for (const [executor, result] of Object.entries(executionResults)) {
      let content;
      if (typeof result === 'string') {
        content = result?.length > 1500 ? result.slice(0, 1500) + '\n... (truncated)' : result;
      } else if (typeof result === 'object' && result !== null) {
        content = result.response || result.error || '(no output)';
        if (content?.length > 1500) {
          content = content.slice(0, 1500) + '\n... (truncated)';
        }
        if (result.toolInvocations && result.toolInvocations.length > 0) {
          content += '\n\nTool invocations: ' + result.toolInvocations.map(i => `${i.toolName} (${i.status})`).join(', ');
        }
      } else {
        content = '(no output)';
      }
      lines.push(`--- ${executor}'s result ---`, content || '(no output)', '---');
    }
    return lines.join('\n');
  }

  async function dispatchExecution(executionTasks, forceExecute, projectId, targetChannel, threadId, threadLabel, userMsg, userId = null, parentSpanContext = null) {
    const agents = getAgents();
    const executors = Object.keys(executionTasks);
    log.info('Execution mode dispatching', { agents: executors, force: forceExecute });
    addMessage(projectId, targetChannel, 'System',
      `Execution mode activated for: ${executors.join(', ')}`, 'system', { threadId });

    // ── BYOH PR workflow Phase 1.4 — chat-execute auto-PR ─────────────────
    // When the operator dispatches via chat (vs the campaign subtask flow in
    // lifecycle.js), the same enforcePRForAllWrites contract must hold. If
    // the project has it enabled and the current git branch isn't the target,
    // auto-open ONE PR for this dispatch (with the first executor as author
    // — keeps reviewer≠author invariant possible when a second executor exists).
    //
    // Soft-fail: errors here log warn and continue dispatch. The
    // runtime-guardrails branch-protection check still runs per agent later.
    try {
      const prRepoCfg = stateManager?.getProjectRepoConfig?.(projectId);
      if (prStore && executors.length > 0 && prRepoCfg?.enforcePRForAllWrites === true) {
        const projectDir = stateManager.getProject(projectId)?.projectDir || PROJECT_DIR;
        let currentBranch = null;
        try {
          const { execSync } = await import('child_process');
          currentBranch = execSync('git rev-parse --abbrev-ref HEAD', {
            cwd: projectDir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'],
          }).trim();
        } catch (_) {
          // not a git repo or git unavailable — runtime-guardrails will surface
          // a clearer error per-agent. Don't block chat-execute on git probe.
        }
        if (currentBranch) {
          const existing = prStore.findOpenPRForBranch(projectId, currentBranch);
          if (!existing) {
            const targetBranch = prRepoCfg.defaultBranch || prRepoCfg.branch || 'main';
            if (currentBranch !== targetBranch) {
              const author = executors[0];
              const authorAgent = agents[author];
              try {
                const newPR = prStore.openPR({
                  projectId,
                  sourceBranch: currentBranch,
                  targetBranch,
                  author,
                  authorRole: authorAgent?.role || null,
                  taskIds: userMsg?.taskId ? [userMsg.taskId] : [],
                  campaignId: userMsg?.campaignId || null,
                  title: `chat-execute: ${executors.join(', ')}`,
                  description: `Auto-opened by chat-execute dispatch. Operator: ${userId || 'unknown'}. Executors: ${executors.join(', ')}. Branch: ${currentBranch} → ${targetBranch}.`,
                  repoConfig: prRepoCfg,
                });
                log.info('Auto-opened PR on chat-execute', {
                  prId: newPR.id, projectId, sourceBranch: currentBranch, targetBranch,
                  author, executors, requiresOperatorApproval: newPR.requiresOperatorApproval,
                });
                addMessage(projectId, targetChannel, 'System',
                  `PR opened for chat-execute by @${author}: ${currentBranch} → ${targetBranch}` +
                  (newPR.requiresOperatorApproval ? ' (requires operator approval to merge)' : ''),
                  'system', { threadId });
              } catch (prErr) {
                log.error('Failed to auto-open PR on chat-execute', {
                  projectId, sourceBranch: currentBranch, targetBranch,
                  executors, error: prErr.message,
                });
              }
            }
          }
        }
      }
    } catch (err) {
      log.warn('chat-execute PR auto-open hook errored (non-blocking)', {
        projectId, executors, error: err.message,
      });
    }
    // ──────────────────────────────────────────────────────────────────────

    const executionResults = {};
    const stats = [];
    const toolInvocationCaptures = new Map();

    for (const agentName of executors) {
      const agent = agents[agentName];
      if (!agent) continue;

      let executionContext = userMsg?.taskId || userMsg?.subtaskId
        ? {
            projectId,
            taskId: userMsg?.taskId || null,
            subtaskId: userMsg?.subtaskId || null,
            campaignId: userMsg?.campaignId || null,
            agentProvider: agent.provider || null,
            traceId: null,
            dispatchId: null,
          }
        : null;

      const capture = createToolInvocationCapture(agentName, executionContext);
      toolInvocationCaptures.set(agentName, capture);

      const wrappedToolService = wrapToolDistributionService(toolDistributionService, capture, executionContext);

      const task = executionTasks[agentName];
      const execPrompt = buildExecutionPrompt(agentName, projectId, targetChannel, task, threadId, threadLabel, wrappedToolService);
      const thinkingKey = `${projectId}#${targetChannel}#${agentName}`;
      setAgentThinking(thinkingAgents, thinkingKey);
      broadcastToChannel(projectId, targetChannel, { type: 'status', speaker: agentName, status: 'executing' });

      const baseTimeout = getAgentTimeout(agentName);
      const execTimeout = baseTimeout * EXECUTION_TIMEOUT_MULTIPLIER;

      const canBypass = canBypassPermissions ? canBypassPermissions(agentName) : true;
      if (config.permissions.auditLog && auditDispatch) {
        auditDispatch(stateManager.projectsDir, projectId, {
          action: 'execution', agent: agentName, bypass: canBypass,
        });
      }

      const start = Date.now();

      // Create dispatch.execute span with routing metadata
      const dispatchSpan = startSpan('dispatch.execute', {
        agentId: agentName,
        provider: agent.provider || 'unknown',
        model: agent.model || 'unknown',
        taskCategory: 'execution',
        constraintsApplied: canBypass ? 'bypassed' : 'enforced',
        projectId,
        channelId: targetChannel,
      }, parentSpanContext);
      const traceId = getTraceId(dispatchSpan);
      const selectionReason = forceExecute ? 'forced_execution' : 'directed_execution';
      dispatchSpan.setAttribute('selectionReason', selectionReason);
      let dispatchRecord = null;
      let dispatchId = null;
      if (dispatchLog?.append) {
        dispatchRecord = {
          taskCategory: 'execution',
          campaignId: userMsg?.campaignId || null,
          selectedAgent: agentName,
          selectionReason,
          candidates: [{ agentId: agentName, provider: agent.provider || null, successRate: null, decayedRate: null }],
          constraintsApplied: [],
          weights: [],
          roll: null,
          traceId,
        };
        const savedDispatch = await dispatchLog.append(dispatchRecord);
        dispatchId = savedDispatch?.id || dispatchRecord.id || null;
        dispatchRecord = savedDispatch || { ...dispatchRecord, id: dispatchId };

        if (events?.emit) {
          events.emit('dispatch:decision', {
            ...savedDispatch,
            provider: agent.provider || null,
            projectId,
            channelId: targetChannel,
          }).catch(() => {});
        }

        broadcastToChannel(projectId, targetChannel, {
          type: 'dispatch_decision',
          id: savedDispatch?.id || dispatchRecord.id,
          timestamp: savedDispatch?.timestamp || dispatchRecord.timestamp,
          taskCategory: savedDispatch?.taskCategory || dispatchRecord.taskCategory,
          campaignId: savedDispatch?.campaignId || dispatchRecord.campaignId,
          selectedAgent: savedDispatch?.selectedAgent || dispatchRecord.selectedAgent,
          selectionReason: savedDispatch?.selectionReason || dispatchRecord.selectionReason,
          traceId: savedDispatch?.traceId || dispatchRecord.traceId,
          projectId: projectId,
        });
      }

      if (executionContext) {
        executionContext.traceId = traceId || null;
        executionContext.dispatchId = dispatchId;
      }

      // Pre-dispatch guardrail checks
      let preDispatchResult = { passed: true, violations: [] };
      if (guardrailChain) {
        preDispatchResult = guardrailChain.runPreDispatch({
          prompt: execPrompt,
          agentId: agentName,
          projectId,
          operatorOverride: userMsg?.operatorOverride,
        });

        // Log all violations to operator audit
        if (operatorAuditStore && preDispatchResult.violations.length > 0) {
          for (const violation of preDispatchResult.violations) {
            operatorAuditStore.append(projectId, {
              operatorId: 'system',
              action: 'guardrail_violation',
              campaignId: null,
              resourceType: 'dispatch',
              resourceId: agentName,
              payload: {
                phase: 'pre',
                dispatchId: dispatchRecord?.id || null,
                rule: violation.rule,
                severity: violation.severity,
                enforcementMode: violation.enforcementMode,
                message: violation.message,
                excerpt: violation.payloadExcerpt,
              },
              status: violation.enforcementMode === 'blocking' ? 'blocked' : 'advisory',
            });
          }
        }

        // Emit WebSocket events for violations
        for (const violation of preDispatchResult.violations) {
          const eventType = violation.enforcementMode === 'blocking' ? 'guardrail:blocked' : 'guardrail:advisory';
          broadcastToChannel(projectId, targetChannel, {
            type: eventType,
            agent: agentName,
            rule: violation.rule,
            severity: violation.severity,
            message: violation.message,
            phase: 'pre',
          });

          if (events?.emit) {
            events.emit('guardrail:outcome', {
              id: `guardrail-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
              agentId: agentName,
              outcome: violation.enforcementMode === 'blocking' ? 'blocked' : 'advisory',
              rule: violation.rule,
              ruleName: violation.rule,
              severity: violation.severity,
              enforcementMode: violation.enforcementMode,
              message: violation.message,
              detail: violation.message,
              phase: 'pre',
              timestamp: new Date().toISOString(),
              campaignId: userMsg?.campaignId || null,
              taskId: userMsg?.taskId || null,
              dispatchId: dispatchRecord?.id || null,
              traceId,
              provider: agent.provider || null,
              projectId,
              channelId: targetChannel,
            }).catch(() => {});
          }
        }

        // If blocked, skip agent execution
        if (!preDispatchResult.passed) {
          const duration = Date.now() - start;
          setAgentIdle(thinkingAgents, thinkingKey);
          // Field name fix: violations are pushed with `ruleName` (guardrail-chain.js)
          // but were being read as `v.rule` here — producing empty log messages
          // for every block since this code path's inception. Now formats each
          // violation as "<rule>: <message>" so operators see what tripped + why
          // without grepping the orchestrator source. Codex R1 deliberation
          // (2026-05-31 guardrail-placeholder-bug.md) endorsed this richer format.
          const blockMsg = `Agent ${agent.name} blocked by guardrail: ${preDispatchResult.violations.map(v => `${v.ruleName || v.rule || 'unknown'}${v.message ? `: ${v.message}` : ''}`).join('; ')}`;
          executionResults[agent.name] = `BLOCKED: ${blockMsg}`;
          log.warn(blockMsg);
          addMessage(projectId, targetChannel, 'System', blockMsg, 'system', { threadId });

          // Record guardrail block in span
          setSpanStatus(dispatchSpan, { code: 'blocked', message: blockMsg });
          for (const violation of preDispatchResult.violations) {
            addSpanEvent(dispatchSpan, 'guardrail.violation', {
              phase: 'pre',
              rule: violation.rule,
              severity: violation.severity,
              enforcementMode: violation.enforcementMode,
              message: violation.message,
            });
          }
          dispatchSpan.setAttribute('durationMs', duration);
          dispatchSpan.setAttribute('success', false);
          dispatchSpan.setAttribute('blocked', true);
          endSpan(dispatchSpan, { success: false });

          stats.push({ agentId: agentName, dispatchId: dispatchRecord?.id || null, success: false, durationMs: duration, category: 'execution', status: 'guardrail_blocked' });
          broadcastToChannel(projectId, targetChannel, { type: 'status', speaker: agentName, status: 'idle' });
          continue; // Skip to next agent
        }
      }

      // Track executeRunSpan in outer scope so it can be ended in catch block if needed
      let executeRunSpan = null;

      try {
        // Create child span for actual execution
        executeRunSpan = startSpan('dispatch.execute.run', {
          agentId: agentName,
          maxTurns: EXECUTION_MAX_TURNS,
          timeout: execTimeout,
        }, parentSpanContext ? dispatchSpan.spanContext() : null);

        const rawResponse = await withTimeout(
          agent.send(execPrompt, stateManager.getProject(projectId)?.projectDir || PROJECT_DIR, { maxTurns: EXECUTION_MAX_TURNS, bypassPermissions: canBypass }),
          execTimeout, `${agent.name} execution`
        );
        // Normalize: descriptor-backed agents (and historical bespoke classes)
        // return a ResponseObject ({ text, inputTokens, outputTokens, model,
        // provider, confidence }) — NOT a plain string. Without this extraction
        // the addMessage() call below stuffs the object into chat and the UI
        // renders it via JS implicit toString → '[object Object]'. The lifecycle
        // path applies the same normalization at lifecycle.js:2046; that
        // normalization was previously missing from this chat-execution path.
        const response = typeof rawResponse === 'string' ? rawResponse
          : (rawResponse?.text != null ? String(rawResponse.text) : String(rawResponse ?? ''));
        const duration = Date.now() - start;
        setAgentIdle(thinkingAgents, thinkingKey);

        // End execute.run span
        executeRunSpan.setAttribute('durationMs', duration);
        executeRunSpan.setAttribute('success', true);
        endSpan(executeRunSpan, { success: true });

        // Post-dispatch guardrail checks
        let postDispatchResult = { passed: true, violations: [] };
        if (guardrailChain && response) {
          postDispatchResult = guardrailChain.runPostDispatch({
            prompt: execPrompt,
            response,
            agentName,
            projectId,
            channelId: targetChannel,
            operatorOverride: userMsg?.operatorOverride,
          });

          // Log post-dispatch violations
          if (operatorAuditStore && postDispatchResult.violations.length > 0) {
            for (const violation of postDispatchResult.violations) {
              operatorAuditStore.append(projectId, {
                operatorId: 'system',
                action: 'guardrail_violation',
                campaignId: null,
                resourceType: 'dispatch',
                resourceId: agentName,
                payload: {
                  phase: 'post',
                  dispatchId: dispatchRecord?.id || null,
                  rule: violation.rule,
                  severity: violation.severity,
                  enforcementMode: violation.enforcementMode,
                  message: violation.message,
                  excerpt: violation.payloadExcerpt,
                },
                status: violation.enforcementMode === 'blocking' ? 'blocked' : 'advisory',
              });
            }
          }

          // Emit WebSocket events for post-dispatch violations
          for (const violation of postDispatchResult.violations) {
            const eventType = violation.enforcementMode === 'blocking' ? 'guardrail:blocked' : 'guardrail:advisory';
            broadcastToChannel(projectId, targetChannel, {
              type: eventType,
              agent: agentName,
              rule: violation.rule,
              severity: violation.severity,
              message: violation.message,
              phase: 'post',
            });

            if (events?.emit) {
              events.emit('guardrail:outcome', {
                id: `guardrail-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
                agentId: agentName,
                outcome: violation.enforcementMode === 'blocking' ? 'blocked' : 'advisory',
                rule: violation.rule,
                ruleName: violation.rule,
                severity: violation.severity,
                enforcementMode: violation.enforcementMode,
                message: violation.message,
                detail: violation.message,
                phase: 'post',
                timestamp: new Date().toISOString(),
                campaignId: userMsg?.campaignId || null,
                taskId: userMsg?.taskId || null,
                dispatchId: dispatchRecord?.id || null,
                traceId,
                provider: agent.provider || null,
                projectId,
                channelId: targetChannel,
              }).catch(() => {});
            }
          }

          // If post-dispatch blocked, mark as guardrail failure
          if (!postDispatchResult.passed) {
            const blockMsg = `Agent ${agent.name} response blocked by guardrail: ${postDispatchResult.violations.map(v => `${v.ruleName || v.rule || 'unknown'}${v.message ? `: ${v.message}` : ''}`).join('; ')}`;
            log.warn(blockMsg);
            executionResults[agent.name] = `BLOCKED: ${blockMsg}`;
            addMessage(projectId, targetChannel, 'System', blockMsg, 'system', { threadId });

            // Record post-dispatch guardrail block in span
            setSpanStatus(dispatchSpan, { code: 'blocked', message: blockMsg });
            for (const violation of postDispatchResult.violations) {
              addSpanEvent(dispatchSpan, 'guardrail.violation', {
                phase: 'post',
                rule: violation.rule,
                severity: violation.severity,
                enforcementMode: violation.enforcementMode,
                message: violation.message,
              });
            }
            dispatchSpan.setAttribute('durationMs', duration);
            dispatchSpan.setAttribute('success', false);
            dispatchSpan.setAttribute('blocked', true);
            endSpan(dispatchSpan, { success: false });

            stats.push({ agentId: agentName, dispatchId: dispatchRecord?.id || null, success: false, durationMs: duration, category: 'execution', status: 'guardrail_blocked' });
            broadcastToChannel(projectId, targetChannel, { type: 'status', speaker: agentName, status: 'idle' });
            continue; // Skip to next agent
          }
        }

        if (response) {
          const toolInvocations = capture.getInvocations();
          executionResults[agent.name] = {
            response,
            toolInvocations,
          };
          addMessage(projectId, targetChannel, agent.name, response, 'message', {
            model: agent.model, threadId, replyTo: userMsg.id,
          });
          stats.push({
            agentId: agentName,
            dispatchId: dispatchRecord?.id || null,
            success: true,
            durationMs: duration,
            category: 'execution',
            toolInvocations,
          });

          // Record success in dispatch span
          dispatchSpan.setAttribute('durationMs', duration);
          dispatchSpan.setAttribute('success', true);
          dispatchSpan.setAttribute('responseLength', response.length);
          dispatchSpan.setAttribute('toolInvocationCount', toolInvocations.length);
          endSpan(dispatchSpan, { success: true });
        }
      } catch (err) {
        const duration = Date.now() - start;
        setAgentIdle(thinkingAgents, thinkingKey);
        const toolInvocations = capture.getInvocations();
        executionResults[agent.name] = {
          error: err.message,
          toolInvocations,
        };
        log.error('Execution failed', { agent: agent.name, error: err.message, toolInvocationCount: toolInvocations.length });

        // End execute.run span if it was created
        if (executeRunSpan) {
          executeRunSpan.setAttribute('durationMs', duration);
          executeRunSpan.setAttribute('success', false);
          executeRunSpan.setAttribute('errorMessage', err.message);
          executeRunSpan.recordException(err);
          endSpan(executeRunSpan, { error: err });
        }

        // Record error in dispatch span
        dispatchSpan.setAttribute('durationMs', duration);
        dispatchSpan.setAttribute('success', false);
        dispatchSpan.setAttribute('errorMessage', err.message);
        dispatchSpan.recordException(err);
        endSpan(dispatchSpan, { error: err });
        if (errorRegistry && CATEGORIES) {
          const classified = (function() {
            const msg = err.message || '';
            if (/permission denied|not permitted|unauthorized|forbidden/i.test(msg)) {
              return { category: CATEGORIES.PERMISSION_DENIED, message: `Agent ${agent.name} lacks permissions`, suggestedFix: 'Grant agent necessary permissions in config/permissions.json or enable bypass mode' };
            }
            if (/ENOENT|command not found|cannot find|executable not found/i.test(msg)) {
              return { category: CATEGORIES.CLI_NOT_FOUND, message: `CLI tool not found`, suggestedFix: 'Install the required CLI tool and ensure it is in PATH' };
            }
            if (/spawn.*failed|process exited|exit code|EACCES/i.test(msg) && !msg.includes('ENOENT')) {
              return { category: CATEGORIES.SPAWN_FAILURE, message: `Failed to spawn process: ${msg.slice(0, 100)}`, suggestedFix: 'Check CLI permissions and PATH configuration' };
            }
            if (/timed out|timeout|deadline exceeded/i.test(msg)) {
              return { category: CATEGORIES.TIMEOUT, message: `Execution timed out`, suggestedFix: 'Increase execution timeout or reduce task complexity' };
            }
            return null;
          })();
          if (classified) {
            errorRegistry.record({
              category: classified.category,
              agentId: agentName,
              timestamp: Date.now(),
              message: classified.message,
              suggestedFix: classified.suggestedFix,
              context: { projectId, channelId: targetChannel, threadId, originalError: err.message },
            });
          }
        }
        addMessage(projectId, targetChannel, 'System', `${agent.name} execution failed: ${err.message}`, 'system', { threadId });
        const failureType = classifyFailure(err.message, err);
        stats.push({
          agentId: agentName,
          dispatchId: dispatchRecord?.id || null,
          success: false,
          durationMs: duration,
          category: 'execution',
          failureType,
          toolInvocations,
        });
      }
      broadcastToChannel(projectId, targetChannel, { type: 'status', speaker: agentName, status: 'idle' });
    }

    // Audit phase
    const auditors = Object.keys(agents).filter(a => !executors.includes(a) && !(isAgentCoolingDown && isAgentCoolingDown(a)));
    if (auditors.length > 0 && Object.values(executionResults).some(r => {
      if (typeof r === 'string') return !r.startsWith('ERROR:');
      if (typeof r === 'object' && r !== null) return !r.error;
      return false;
    })) {
      // Auditor order: Codex -> Claude -> local (then generic fallbacks).
      const auditor = auditors.find(a => agents[a]?.role === 'reviewer' && agents[a]?.provider === 'codex')
        || auditors.find(a => agents[a]?.role === 'reviewer' && agents[a]?.provider === 'claude')
        || auditors.find(a => agents[a]?.provider === 'codex')
        || auditors.find(a => agents[a]?.provider === 'claude')
        || auditors.find(a => agents[a]?.provider === 'ollama')
        || auditors.find(a => agents[a]?.role === 'developer')
        || auditors[0];
      const auditAgent = agents[auditor];

      if (auditAgent) {
        // Create audit phase span
        const auditSpan = startSpan('dispatch.audit', {
          agentId: auditor,
          provider: auditAgent.provider || 'unknown',
          model: auditAgent.model || 'unknown',
          taskCategory: 'audit',
          executorsAudited: executors.join(','),
          projectId,
          channelId: targetChannel,
        }, parentSpanContext);

        const auditPrompt = buildAuditPrompt(auditor, projectId, targetChannel, executors, executionResults, threadId, threadLabel);
        const thinkingKey = `${projectId}#${targetChannel}#${auditor}`;
        setAgentThinking(thinkingAgents, thinkingKey);
        broadcastToChannel(projectId, targetChannel, { type: 'status', speaker: auditor, status: 'thinking' });
        const start = Date.now();
        try {
          const rawResponse = await withTimeout(
            auditAgent.send(auditPrompt, stateManager.getProject(projectId)?.projectDir || PROJECT_DIR),
            getAgentTimeout(auditor), `${auditAgent.name} audit`
          );
          // Same normalization as the execute-phase site above — agent.send()
          // returns a ResponseObject for descriptor-backed agents.
          const response = typeof rawResponse === 'string' ? rawResponse
            : (rawResponse?.text != null ? String(rawResponse.text) : String(rawResponse ?? ''));
          const duration = Date.now() - start;
          setAgentIdle(thinkingAgents, thinkingKey);
          if (response && !isNoiseResponse(response)) {
            addMessage(projectId, targetChannel, auditAgent.name, response, 'message', {
              model: auditAgent.model, threadId, replyTo: userMsg.id,
            });
            stats.push({ agentId: auditor, success: true, durationMs: duration, category: 'audit' });

            // Record audit success
            auditSpan.setAttribute('durationMs', duration);
            auditSpan.setAttribute('success', true);
            auditSpan.setAttribute('responseLength', response.length);
            endSpan(auditSpan, { success: true });
          } else {
            // No response or noise response
            const duration = Date.now() - start;
            auditSpan.setAttribute('durationMs', duration);
            auditSpan.setAttribute('success', false);
            auditSpan.setAttribute('noiseResponse', true);
            endSpan(auditSpan, { success: false });
          }
        } catch (err) {
          const duration = Date.now() - start;
          setAgentIdle(thinkingAgents, thinkingKey);
          log.error('Audit error', { agent: auditor, error: err.message });

          // Record audit error
          auditSpan.setAttribute('durationMs', duration);
          auditSpan.setAttribute('success', false);
          auditSpan.setAttribute('errorMessage', err.message);
          auditSpan.recordException(err);
          endSpan(auditSpan, { error: err });
          if (errorRegistry && CATEGORIES) {
            const classified = (function() {
              const msg = err.message || '';
              if (/permission denied|not permitted|unauthorized|forbidden/i.test(msg)) {
                return { category: CATEGORIES.PERMISSION_DENIED, message: `Audit agent lacks permissions`, suggestedFix: 'Grant audit agent necessary permissions' };
              }
              if (/timed out|timeout|deadline exceeded/i.test(msg)) {
                return { category: CATEGORIES.TIMEOUT, message: `Audit timed out`, suggestedFix: 'Increase audit timeout' };
              }
              return null;
            })();
            if (classified) {
              errorRegistry.record({
                category: classified.category,
                agentId: auditor,
                timestamp: Date.now(),
                message: classified.message,
                suggestedFix: classified.suggestedFix,
                context: { projectId, channelId: targetChannel, threadId, originalError: err.message },
              });
            }
          }
          stats.push({ agentId: auditor, success: false, durationMs: duration, category: 'audit' });
        }
        broadcastToChannel(projectId, targetChannel, { type: 'status', speaker: auditor, status: 'idle' });
      }
    }

    // Summary phase
    const summarizer = auditors.find(a => agents[a]?.role === 'researcher')
      || auditors.find(a => agents[a]?.provider === 'gemini')
      || auditors[auditors.length - 1];
    if (summarizer) {
      const summaryAgent = agents[summarizer];
      if (summaryAgent) {
        // Create summary phase span
        const summarySpan = startSpan('dispatch.summary', {
          agentId: summarizer,
          provider: summaryAgent.provider || 'unknown',
          model: summaryAgent.model || 'unknown',
          taskCategory: 'summary',
          executorsSummarized: executors.join(','),
          projectId,
          channelId: targetChannel,
        }, parentSpanContext);

        const summaryPrompt = buildSummaryPrompt(summarizer, projectId, targetChannel, executors, executionResults, threadId, threadLabel);
        const thinkingKey = `${projectId}#${targetChannel}#${summarizer}`;
        setAgentThinking(thinkingAgents, thinkingKey);
        broadcastToChannel(projectId, targetChannel, { type: 'status', speaker: summarizer, status: 'thinking' });
        const start = Date.now();
        try {
          const rawResponse = await withTimeout(
            summaryAgent.send(summaryPrompt, stateManager.getProject(projectId)?.projectDir || PROJECT_DIR),
            getAgentTimeout(summarizer), `${summaryAgent.name} summary`
          );
          // Same normalization as the execute/audit sites — agent.send()
          // returns a ResponseObject for descriptor-backed agents.
          const response = typeof rawResponse === 'string' ? rawResponse
            : (rawResponse?.text != null ? String(rawResponse.text) : String(rawResponse ?? ''));
          const duration = Date.now() - start;
          setAgentIdle(thinkingAgents, thinkingKey);
          if (response && !isNoiseResponse(response)) {
            addMessage(projectId, targetChannel, summaryAgent.name, response, 'message', {
              model: summaryAgent.model, threadId, replyTo: userMsg.id,
            });
            stats.push({ agentId: summarizer, success: true, durationMs: duration, category: 'summary' });

            // Record summary success
            summarySpan.setAttribute('durationMs', duration);
            summarySpan.setAttribute('success', true);
            summarySpan.setAttribute('responseLength', response.length);
            endSpan(summarySpan, { success: true });
          } else {
            // No response or noise response
            const duration = Date.now() - start;
            summarySpan.setAttribute('durationMs', duration);
            summarySpan.setAttribute('success', false);
            summarySpan.setAttribute('noiseResponse', true);
            endSpan(summarySpan, { success: false });
          }
        } catch (err) {
          const duration = Date.now() - start;
          setAgentIdle(thinkingAgents, thinkingKey);
          log.error('Summary error', { agent: summarizer, error: err.message });

          // Record summary error
          summarySpan.setAttribute('durationMs', duration);
          summarySpan.setAttribute('success', false);
          summarySpan.setAttribute('errorMessage', err.message);
          summarySpan.recordException(err);
          endSpan(summarySpan, { error: err });
          if (errorRegistry && CATEGORIES) {
            const classified = (function() {
              const msg = err.message || '';
              if (/permission denied|not permitted|unauthorized|forbidden/i.test(msg)) {
                return { category: CATEGORIES.PERMISSION_DENIED, message: `Summary agent lacks permissions`, suggestedFix: 'Grant summary agent necessary permissions' };
              }
              if (/timed out|timeout|deadline exceeded/i.test(msg)) {
                return { category: CATEGORIES.TIMEOUT, message: `Summary timed out`, suggestedFix: 'Increase summary timeout' };
              }
              return null;
            })();
            if (classified) {
              errorRegistry.record({
                category: classified.category,
                agentId: summarizer,
                timestamp: Date.now(),
                message: classified.message,
                suggestedFix: classified.suggestedFix,
                context: { projectId, channelId: targetChannel, threadId, originalError: err.message },
              });
            }
          }
          stats.push({ agentId: summarizer, success: false, durationMs: duration, category: 'summary' });
        }
        broadcastToChannel(projectId, targetChannel, { type: 'status', speaker: summarizer, status: 'idle' });
      }
    }
    return stats;
  }

  return { dispatchExecution };
}
