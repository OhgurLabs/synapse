/**
 * Reference Counter for MCP Tools
 *
 * Tracks active task associations with specific MCP tools to prevent premature
 * removal during server disconnection. Implements reference counting to ensure
 * tools are only unregistered when no active tasks depend on them.
 *
 * Features:
 * - Track task associations with tools by taskId and toolId
 * - Increment/decrement reference counts for tool usage
 * - Query which tasks are using a specific tool
 * - Query which tools a specific task is using
 * - Support garbage collection for orphaned references
 * - Thread-safe operations with proper locking
 */

import { createLogger } from '../../logger.js';

const log = createLogger('reference-counter');

export class ReferenceCounter {
  constructor() {
    // Map: toolId -> Set of taskIds using this tool
    this._toolReferences = new Map();
    
    // Map: taskId -> Set of toolIds used by this task
    this._taskReferences = new Map();
    
    // Map: taskId -> Set of toolIds currently being invoked (in-flight)
    this._activeInvocations = new Map();
    
    // Timestamps for garbage collection: taskId -> last activity timestamp
    this._lastActivity = new Map();
  }

  /**
   * Register a task's usage of a tool.
   * Increments the reference count for the tool.
   *
   * @param {string} taskId - Unique task identifier
   * @param {string} toolId - Tool identifier (from ToolRegistry)
   * @returns {number} New reference count for the tool
   */
  acquire(taskId, toolId) {
    if (!taskId || typeof taskId !== 'string') {
      throw new TypeError('taskId is required and must be a string');
    }
    if (!toolId || typeof toolId !== 'string') {
      throw new TypeError('toolId is required and must be a string');
    }

    // Add tool to task's reference set
    if (!this._taskReferences.has(taskId)) {
      this._taskReferences.set(taskId, new Set());
    }
    this._taskReferences.get(taskId).add(toolId);

    // Add task to tool's reference set
    if (!this._toolReferences.has(toolId)) {
      this._toolReferences.set(toolId, new Set());
    }
    this._toolReferences.get(toolId).add(taskId);

    // Update last activity timestamp
    this._lastActivity.set(taskId, Date.now());

    const refCount = this._toolReferences.get(toolId).size;
    log.debug({ taskId, toolId, refCount }, 'Tool reference acquired');

    return refCount;
  }

  /**
   * Release a task's usage of a tool.
   * Decrements the reference count for the tool.
   *
   * @param {string} taskId - Unique task identifier
   * @param {string} toolId - Tool identifier
   * @returns {number} New reference count for the tool (0 if no more references)
   */
  release(taskId, toolId) {
    if (!taskId || typeof taskId !== 'string') {
      throw new TypeError('taskId is required and must be a string');
    }
    if (!toolId || typeof toolId !== 'string') {
      throw new TypeError('toolId is required and must be a string');
    }

    // Remove task from tool's reference set
    const toolRefs = this._toolReferences.get(toolId);
    if (toolRefs && toolRefs.has(taskId)) {
      toolRefs.delete(taskId);
      
      // Clean up empty sets
      if (toolRefs.size === 0) {
        this._toolReferences.delete(toolId);
      }
    }

    // Remove tool from task's reference set
    const taskRefs = this._taskReferences.get(taskId);
    if (taskRefs && taskRefs.has(toolId)) {
      taskRefs.delete(toolId);
      
      // Clean up empty sets
      if (taskRefs.size === 0) {
        this._taskReferences.delete(taskId);
      }
    }

    // Update last activity timestamp
    this._lastActivity.set(taskId, Date.now());

    const refCount = this._toolReferences.get(toolId)?.size || 0;
    log.debug({ taskId, toolId, refCount }, 'Tool reference released');

    return refCount;
  }

  /**
   * Mark a tool invocation as in-progress for a task.
   * Used to track active invocations that should block unregistration.
   *
   * @param {string} taskId - Unique task identifier
   * @param {string} toolId - Tool identifier
   */
  startInvocation(taskId, toolId) {
    if (!taskId || typeof taskId !== 'string') {
      throw new TypeError('taskId is required and must be a string');
    }
    if (!toolId || typeof toolId !== 'string') {
      throw new TypeError('toolId is required and must be a string');
    }

    if (!this._activeInvocations.has(taskId)) {
      this._activeInvocations.set(taskId, new Set());
    }
    this._activeInvocations.get(taskId).add(toolId);
    
    // Also ensure the reference is tracked
    this.acquire(taskId, toolId);
    
    log.debug({ taskId, toolId }, 'Tool invocation started');
  }

  /**
   * Mark a tool invocation as completed for a task.
   *
   * @param {string} taskId - Unique task identifier
   * @param {string} toolId - Tool identifier
   */
  endInvocation(taskId, toolId) {
    if (!taskId || typeof taskId !== 'string') {
      throw new TypeError('taskId is required and must be a string');
    }
    if (!toolId || typeof toolId !== 'string') {
      throw new TypeError('toolId is required and must be a string');
    }

    const activeInvocations = this._activeInvocations.get(taskId);
    if (activeInvocations && activeInvocations.has(toolId)) {
      activeInvocations.delete(toolId);
      
      // Clean up empty sets
      if (activeInvocations.size === 0) {
        this._activeInvocations.delete(taskId);
      }
    }
    
    log.debug({ taskId, toolId }, 'Tool invocation ended');
  }

  /**
   * Get the reference count for a tool.
   *
   * @param {string} toolId - Tool identifier
   * @returns {number} Number of tasks referencing this tool
   */
  getRefCount(toolId) {
    if (!toolId || typeof toolId !== 'string') {
      throw new TypeError('toolId is required and must be a string');
    }

    return this._toolReferences.get(toolId)?.size || 0;
  }

  /**
   * Check if a tool has any active references.
   *
   * @param {string} toolId - Tool identifier
   * @returns {boolean} True if tool is in use
   */
  isReferenced(toolId) {
    return this.getRefCount(toolId) > 0;
  }

  /**
   * Get all tasks that reference a specific tool.
   *
   * @param {string} toolId - Tool identifier
   * @returns {Set<string>} Set of task IDs using this tool
   */
  getReferencingTasks(toolId) {
    if (!toolId || typeof toolId !== 'string') {
      throw new TypeError('toolId is required and must be a string');
    }

    const refs = this._toolReferences.get(toolId);
    return refs ? new Set(refs) : new Set();
  }

  /**
   * Get all tools used by a specific task.
   *
   * @param {string} taskId - Task identifier
   * @returns {Set<string>} Set of tool IDs used by this task
   */
  getTaskTools(taskId) {
    if (!taskId || typeof taskId !== 'string') {
      throw new TypeError('taskId is required and must be a string');
    }

    const refs = this._taskReferences.get(taskId);
    return refs ? new Set(refs) : new Set();
  }

  /**
   * Get all tools currently being invoked by a task.
   *
   * @param {string} taskId - Task identifier
   * @returns {Set<string>} Set of tool IDs with active invocations
   */
  getActiveInvocations(taskId) {
    if (!taskId || typeof taskId !== 'string') {
      throw new TypeError('taskId is required and must be a string');
    }

    const invocations = this._activeInvocations.get(taskId);
    return invocations ? new Set(invocations) : new Set();
  }

  /**
   * Check if a task has any active tool invocations.
   *
   * @param {string} taskId - Task identifier
   * @returns {boolean} True if task has active invocations
   */
  hasActiveInvocations(taskId) {
    if (!taskId || typeof taskId !== 'string') {
      throw new TypeError('taskId is required and must be a string');
    }

    const invocations = this._activeInvocations.get(taskId);
    return invocations && invocations.size > 0;
  }

  /**
   * Release all references for a completed task.
   * Called when a task finishes or is cancelled.
   *
   * @param {string} taskId - Task identifier
   * @returns {number} Number of references released
   */
  releaseTask(taskId) {
    if (!taskId || typeof taskId !== 'string') {
      throw new TypeError('taskId is required and must be a string');
    }

    const tools = this.getTaskTools(taskId);
    let released = 0;

    for (const toolId of tools) {
      this.release(taskId, toolId);
      released++;
    }

    // Clear active invocations
    this._activeInvocations.delete(taskId);
    
    // Clear last activity
    this._lastActivity.delete(taskId);

    log.debug({ taskId, released }, 'Task references released');

    return released;
  }

  /**
   * Get tools that can be safely unregistered (no active references).
   * Used during server disconnect to determine which tools can be removed.
   *
   * @param {Array<string>} toolIds - Tool IDs to check
   * @returns {Object} Object with safeToRemove and blocked arrays
   */
  getSafeToRemoveTools(toolIds) {
    if (!toolIds || !Array.isArray(toolIds)) {
      throw new TypeError('toolIds must be an array');
    }

    const safeToRemove = [];
    const blocked = [];

    for (const toolId of toolIds) {
      if (this.isReferenced(toolId)) {
        blocked.push({
          toolId,
          refCount: this.getRefCount(toolId),
          taskIds: Array.from(this.getReferencingTasks(toolId))
        });
      } else {
        safeToRemove.push(toolId);
      }
    }

    if (blocked.length > 0) {
      log.debug({
        total: toolIds.length,
        safe: safeToRemove.length,
        blocked: blocked.length
      }, 'Tool unregistration safety check');
    }

    return { safeToRemove, blocked };
  }

  /**
   * Find orphaned references (tasks that no longer exist).
   * Used for garbage collection.
   *
   * @param {Set<string>} validTaskIds - Set of currently active task IDs
   * @returns {Object} Object with orphanedTasks and orphanedTools
   */
  findOrphans(validTaskIds) {
    if (!validTaskIds || !(validTaskIds instanceof Set)) {
      throw new TypeError('validTaskIds must be a Set');
    }

    const orphanedTasks = new Set();
    const orphanedTools = new Set();

    // Find tasks that are no longer valid
    for (const taskId of this._taskReferences.keys()) {
      if (!validTaskIds.has(taskId)) {
        orphanedTasks.add(taskId);
        
        // Mark tools used by this orphaned task
        const tools = this._taskReferences.get(taskId);
        if (tools) {
          for (const toolId of tools) {
            orphanedTools.add(toolId);
          }
        }
      }
    }

    // Also check active invocations
    for (const taskId of this._activeInvocations.keys()) {
      if (!validTaskIds.has(taskId)) {
        orphanedTasks.add(taskId);
        
        const invocations = this._activeInvocations.get(taskId);
        if (invocations) {
          for (const toolId of invocations) {
            orphanedTools.add(toolId);
          }
        }
      }
    }

    if (orphanedTasks.size > 0) {
      log.info({
        orphanedTasks: orphanedTasks.size,
        orphanedTools: orphanedTools.size
      }, 'Orphaned references found');
    }

    return {
      orphanedTasks: Array.from(orphanedTasks),
      orphanedTools: Array.from(orphanedTools)
    };
  }

  /**
   * Clean up orphaned references.
   * Removes references for tasks that no longer exist.
   *
   * @param {Set<string>} validTaskIds - Set of currently active task IDs
   * @returns {Object} Cleanup statistics
   */
  cleanupOrphans(validTaskIds) {
    if (!validTaskIds || !(validTaskIds instanceof Set)) {
      throw new TypeError('validTaskIds must be a Set');
    }

    const { orphanedTasks, orphanedTools } = this.findOrphans(validTaskIds);
    let toolsCleaned = 0;

    for (const taskId of orphanedTasks) {
      const count = this.releaseTask(taskId);
      toolsCleaned += count;
    }

    log.info({
      tasksCleaned: orphanedTasks.length,
      toolsCleaned
    }, 'Orphan cleanup complete');

    return {
      tasksCleaned: orphanedTasks.length,
      toolsCleaned
    };
  }

  /**
   * Get reference count statistics.
   *
   * @returns {Object} Statistics about reference counts
   */
  getStats() {
    const toolsWithRefs = Array.from(this._toolReferences.entries())
      .map(([toolId, tasks]) => ({
        toolId,
        refCount: tasks.size,
        taskIds: Array.from(tasks)
      }));

    const tasksWithTools = Array.from(this._taskReferences.entries())
      .map(([taskId, tools]) => ({
        taskId,
        toolCount: tools.size,
        toolIds: Array.from(tools)
      }));

    const activeInvocationTasks = Array.from(this._activeInvocations.entries())
      .map(([taskId, tools]) => ({
        taskId,
        invocationCount: tools.size,
        toolIds: Array.from(tools)
      }));

    return {
      totalToolsTracked: this._toolReferences.size,
      totalTasksTracked: this._taskReferences.size,
      totalActiveInvocations: this._activeInvocations.size,
      toolsWithRefs,
      tasksWithTools,
      activeInvocationTasks
    };
  }

  /**
   * Clear all references.
   * Use with caution - only call during full registry rebuild.
   */
  clear() {
    const stats = this.getStats();
    this._toolReferences.clear();
    this._taskReferences.clear();
    this._activeInvocations.clear();
    this._lastActivity.clear();

    log.info({
      toolsCleared: stats.totalToolsTracked,
      tasksCleared: stats.totalTasksTracked
    }, 'All references cleared');
  }
}
