import { createLogger } from '../logger.js';
import { parseAgendaCommand, parseAgenda } from '../agenda.js';
import { parsePrefsCommand } from '../preferences.js';
import { parseTaskCommand } from '../tasks.js';
import { parseCampaignCommand } from '../campaigns.js';
import { parseScheduleCommand } from '../scheduler.js';
import { parseTriggerCommand } from '../triggers.js';
import { parseWorkflowCommand } from '../workflows.js';
import { generateThreadId, updateThreadKeywords, resolveThread, parseThreadCommand } from '../threading.js';

export function createCommandHandlers(deps) {
  const {
    stateManager, agendaManager, prefsManager, taskManager, campaignManager, checkpointManager, scheduleManager, triggerManager, workflowManager,
    addMessage, broadcast, broadcastToChannel,
    strategistDecomposeCampaign, strategistInject, strategistEvaluate,
    reviewTask,
    agents, thinkingAgents, fallbackStates, agentCooldowns,
    getSessionMessageCount, SERVER_START_TIME, PROJECT_DIR, config,
    startSession, resumeSession, sessionStatus, endSession,
    isAgentCoolingDown,
    cliSteeringSubscriber,
    auth,
    operatorAuditStore,
    approvalAuditTrail,
  } = deps;

  const log = createLogger('commands');

  async function _handleSessionCommand(trimmed, text, projectId, channelId, speaker) {
    if (trimmed === '/session end') {
      addMessage(projectId, channelId, speaker, text);
      await endSession(projectId, channelId);
      return true;
    }

    if (trimmed.startsWith('/session start')) {
      addMessage(projectId, channelId, speaker, text);
      const topic = text.trim().slice('/session start'.length).trim() || 'General session';
      startSession(projectId, channelId, topic);
      return true;
    }

    if (trimmed === '/session resume') {
      addMessage(projectId, channelId, speaker, text);
      resumeSession(projectId, channelId);
      return true;
    }

    if (trimmed === '/session status') {
      addMessage(projectId, channelId, speaker, text);
      sessionStatus(projectId, channelId);
      return true;
    }
    return false;
  }

  async function _handleCleanupCommand(trimmed, text, projectId, channelId, speaker) {
    if (trimmed === '/cleanup' || trimmed === '/cleanup test') {
      addMessage(projectId, channelId, speaker, text);
      const proj = stateManager.getProject(projectId);
      if (!proj) return true;
      const testChannels = proj.channels.filter(ch => ch.startsWith('test-'));
      if (testChannels.length === 0) {
        addMessage(projectId, channelId, 'System', 'No test channels to clean up.', 'system');
        return true;
      }
      for (const ch of testChannels) {
        stateManager.deleteChannel(projectId, ch);
      }
      addMessage(projectId, channelId, 'System',
        `Cleaned up ${testChannels.length} test channel${testChannels.length > 1 ? 's' : ''}.`, 'system');
      broadcast({ type: 'channels_updated', project: projectId, channels: stateManager.listChannels(projectId) });
      return true;
    }
    return false;
  }

  async function _handleAgendaCommand(trimmed, text, projectId, channelId, speaker) {
    if (trimmed === '/agenda' || trimmed.startsWith('/agenda ')) {
      const cmd = parseAgendaCommand(text.trim());
      if (cmd) {
        addMessage(projectId, channelId, speaker, text);

        let result;
        switch (cmd.command) {
          case 'show': {
            const display = agendaManager.formatAgenda(projectId);
            addMessage(projectId, channelId, 'System', display, 'system');
            break;
          }
          case 'set': {
            const force = cmd.args?.startsWith('--force');
            const itemText = force ? cmd.args.slice('--force'.length).trim() : cmd.args;
            const items = parseAgenda(itemText || '');
            if (items.length === 0) {
              addMessage(projectId, channelId, 'System',
                'No agenda items found. Use a numbered or bulleted list:\n```\n/agenda set\n1. First item\n2. Second item\n```', 'system');
            } else {
              result = agendaManager.set(projectId, channelId, items, speaker, force);
              if (result.error) {
                addMessage(projectId, channelId, 'System', result.error, 'system');
              } else {
                addMessage(projectId, channelId, 'System',
                  `Agenda set with ${items.length} items.\n${agendaManager.formatAgenda(projectId)}`, 'system');
                broadcastToChannel(projectId, channelId, { type: 'agenda_updated', agenda: result.agenda });
              }
            }
            break;
          }
          case 'add': {
            const itemText = cmd.args?.replace(/^["']|["']$/g, '').trim();
            if (!itemText) {
              addMessage(projectId, channelId, 'System', 'Usage: `/agenda add "item text"`', 'system');
            } else {
              result = agendaManager.add(projectId, channelId, itemText, speaker);
              addMessage(projectId, channelId, 'System',
                `Added item: ${itemText}\n${agendaManager.formatAgenda(projectId)}`, 'system');
              broadcastToChannel(projectId, channelId, { type: 'agenda_updated', agenda: result.agenda });
            }
            break;
          }
          case 'check': {
            result = agendaManager.updateStatus(projectId, cmd.args, 'completed', speaker);
            if (result.error) {
              addMessage(projectId, channelId, 'System', result.error, 'system');
            } else {
              addMessage(projectId, channelId, 'System',
                `Checked off: ${result.item.text}\n${agendaManager.formatAgenda(projectId)}`, 'system');
              broadcastToChannel(projectId, channelId, { type: 'agenda_updated', agenda: result.agenda });
            }
            break;
          }
          case 'uncheck': {
            result = agendaManager.updateStatus(projectId, cmd.args, 'pending', speaker);
            if (result.error) {
              addMessage(projectId, channelId, 'System', result.error, 'system');
            } else {
              addMessage(projectId, channelId, 'System',
                `Unchecked: ${result.item.text}\n${agendaManager.formatAgenda(projectId)}`, 'system');
              broadcastToChannel(projectId, channelId, { type: 'agenda_updated', agenda: result.agenda });
            }
            break;
          }
          case 'defer': {
            result = agendaManager.updateStatus(projectId, cmd.args, 'deferred', speaker);
            if (result.error) {
              addMessage(projectId, channelId, 'System', result.error, 'system');
            } else {
              addMessage(projectId, channelId, 'System',
                `Deferred: ${result.item.text}\n${agendaManager.formatAgenda(projectId)}`, 'system');
              broadcastToChannel(projectId, channelId, { type: 'agenda_updated', agenda: result.agenda });
            }
            break;
          }
          case 'progress': {
            result = agendaManager.updateStatus(projectId, cmd.args, 'in_progress', speaker);
            if (result.error) {
              addMessage(projectId, channelId, 'System', result.error, 'system');
            } else {
              addMessage(projectId, channelId, 'System',
                `In progress: ${result.item.text}\n${agendaManager.formatAgenda(projectId)}`, 'system');
              broadcastToChannel(projectId, channelId, { type: 'agenda_updated', agenda: result.agenda });
            }
            break;
          }
          case 'clear': {
            agendaManager.clear(projectId, speaker);
            addMessage(projectId, channelId, 'System', 'Agenda cleared.', 'system');
            broadcastToChannel(projectId, channelId, { type: 'agenda_updated', agenda: { items: [] } });
            break;
          }
          case 'replace': {
            const items = parseAgenda(cmd.args || '');
            if (items.length === 0) {
              addMessage(projectId, channelId, 'System', 'No items found for replacement.', 'system');
            } else {
              result = agendaManager.replace(projectId, channelId, items, speaker);
              addMessage(projectId, channelId, 'System',
                `Agenda replaced with ${items.length} items.\n${agendaManager.formatAgenda(projectId)}`, 'system');
              broadcastToChannel(projectId, channelId, { type: 'agenda_updated', agenda: result.agenda });
            }
            break;
          }
        }
        return true;
      }
    }
    return false;
  }

  async function _handlePrefsCommand(trimmed, text, projectId, channelId, speaker) {
    if (trimmed === '/prefs' || trimmed.startsWith('/prefs ')) {
      const cmd = parsePrefsCommand(text.trim());
      if (cmd) {
        addMessage(projectId, channelId, speaker, text);

        switch (cmd.command) {
          case 'show': {
            const display = prefsManager.formatPrefs(projectId);
            addMessage(projectId, channelId, 'System', display, 'system');
            break;
          }
          case 'keys': {
            const display = prefsManager.formatKeys();
            addMessage(projectId, channelId, 'System', display, 'system');
            break;
          }
          case 'set': {
            const { key, value } = cmd.args;
            const result = prefsManager.set(key, value);
            if (result.error) {
              addMessage(projectId, channelId, 'System', result.error, 'system');
            } else {
              addMessage(projectId, channelId, 'System',
                `Preference \`${key}\` set to \`${result.value === null ? 'null' : result.value}\``, 'system');
              broadcastToChannel(projectId, channelId, {
                type: 'prefs_updated',
                preferences: prefsManager.getAll(projectId),
              });
            }
            break;
          }
          case 'reset': {
            const { key } = cmd.args;
            const result = prefsManager.reset(key);
            if (result.error) {
              addMessage(projectId, channelId, 'System', result.error, 'system');
            } else {
              addMessage(projectId, channelId, 'System',
                `Preference \`${key}\` reset to default (\`${result.default === null ? 'null' : result.default}\`)`, 'system');
              broadcastToChannel(projectId, channelId, {
                type: 'prefs_updated',
                preferences: prefsManager.getAll(projectId),
              });
            }
            break;
          }
          case 'help':
          default: {
            addMessage(projectId, channelId, 'System',
              'Usage:\n  `/prefs` or `/prefs show` — show current preferences\n  `/prefs keys` — list available keys\n  `/prefs set <key> <value>` — set a preference\n  `/prefs reset <key>` — reset to default', 'system');
            break;
          }
        }
        return true;
      }
    }
    return false;
  }

  async function _handleTaskCommand(trimmed, text, projectId, channelId, speaker) {
    if (trimmed === '/task' || trimmed.startsWith('/task ')) {
      const cmd = parseTaskCommand(text.trim());
      if (cmd) {
        addMessage(projectId, channelId, speaker, text);

        switch (cmd.command) {
          case 'list': {
            const display = taskManager.formatTaskList(projectId);
            addMessage(projectId, channelId, 'System', display, 'system');
            break;
          }
          case 'create': {
            if (!cmd.args) {
              addMessage(projectId, channelId, 'System',
                'Usage: `/task create <title>` — creates a new autonomous task', 'system');
              break;
            }
            let title = cmd.args;
            let doneCriteria = null;
            let taskContext = null;
            const doneMatch = title.match(/--done\s+\"([^\"]+)\"/);
            if (doneMatch) { doneCriteria = doneMatch[1]; title = title.replace(doneMatch[0], '').trim(); }
            const ctxMatch = title.match(/--context\s+\"([^\"]+)\"/);
            if (ctxMatch) { taskContext = ctxMatch[1]; title = title.replace(ctxMatch[0], '').trim(); }
            // Detect unquoted flags — user forgot double quotes
            const unquotedFlag = title.match(/--(done|context)\s+(?!")/);
            if (unquotedFlag) {
              addMessage(projectId, channelId, 'System',
                `Flag \`--${unquotedFlag[1]}\` requires double-quoted value.\nUsage: \`/task create <title> [--done "criteria"] [--context "text"]\``, 'system');
              break;
            }

            const task = taskManager.createTask(projectId, channelId, {
              title, doneCriteria, context: taskContext,
            });
            addMessage(projectId, channelId, 'System',
              `Task created: \`${task.id}\`\n**${task.title}**\nStatus: ${task.status}\n\nThe heartbeat will pick this up and begin planning.`, 'system');
            broadcastToChannel(projectId, channelId, { type: 'task_created', task });
            break;
          }
          case 'show': {
            if (!cmd.args) {
              addMessage(projectId, channelId, 'System', 'Usage: `/task show <task_id>`', 'system');
              break;
            }
            const tasks = taskManager.listTasks(projectId);
            const match = tasks.find(t => t.id === cmd.args || t.id.includes(cmd.args));
            if (match) {
              addMessage(projectId, channelId, 'System',
                taskManager.formatTaskDetail(projectId, match.id), 'system');
            } else {
              addMessage(projectId, channelId, 'System', `Task not found: ${cmd.args}`, 'system');
            }
            break;
          }
          case 'status': {
            const allTasks = taskManager.listTasks(projectId);
            const active = allTasks.filter(t => !['done', 'failed', 'cancelled'].includes(t.status));
            if (active.length === 0) {
              addMessage(projectId, channelId, 'System', 'No active tasks.', 'system');
            } else {
              const lines = ['**Active Tasks**'];
              for (const t of active) {
                const done = t.subtasks.filter(s => s.status === 'done').length;
                const total = t.subtasks.length;
                const executing = t.subtasks.find(s => s.status === 'executing' || s.status === 'claimed');
                const progress = total > 0 ? ` (${done}/${total} subtasks done)` : '';
                const current = executing ? `\n  Current: ${executing.text} → @${executing.assignee}` : '';
                lines.push(`[${t.status}] \`${t.id}\` — ${t.title}${progress}${current}`);
              }
              addMessage(projectId, channelId, 'System', lines.join('\n'), 'system');
            }
            break;
          }
          case 'cancel': {
            if (!cmd.args) {
              addMessage(projectId, channelId, 'System', 'Usage: `/task cancel <task_id>`', 'system');
              break;
            }
            try {
              const tasks = taskManager.listTasks(projectId);
              const match = tasks.find(t => t.id === cmd.args || t.id.includes(cmd.args));
              if (!match) throw new Error(`Task not found: ${cmd.args}`);
              taskManager.updateTaskStatus(projectId, match.id, 'cancelled', speaker, 'Cancelled by user');
              addMessage(projectId, channelId, 'System', `Task cancelled: ${match.title}`, 'system');
            } catch (err) {
              addMessage(projectId, channelId, 'System', `Error: ${err.message}`, 'system');
            }
            break;
          }
          case 'interject': {
            if (!cmd.args) {
              addMessage(projectId, channelId, 'System',
                'Usage: `/task interject <task_id> <message>`\nPauses task and sends it back to planning with your feedback.', 'system');
              break;
            }
            const parts = cmd.args.split(/\s+/);
            const taskIdPart = parts[0];
            const message = parts.slice(1).join(' ');
            if (!message) {
              addMessage(projectId, channelId, 'System', 'Provide a message after the task ID.', 'system');
              break;
            }
            try {
              const tasks = taskManager.listTasks(projectId);
              const match = tasks.find(t => t.id === taskIdPart || t.id.includes(taskIdPart));
              if (!match) throw new Error(`Task not found: ${taskIdPart}`);
              taskManager.updateTaskStatus(projectId, match.id, 'planning', speaker, `Interjection: ${message}`);
              addMessage(projectId, channelId, 'System',
                `Task "${match.title}" paused and sent back to planning.\nYour feedback: ${message}\n\nThe heartbeat will re-plan with your input.`, 'system');
            } catch (err) {
              addMessage(projectId, channelId, 'System', `Error: ${err.message}`, 'system');
            }
            break;
          }
          case 'retry': {
            if (!cmd.args) {
              addMessage(projectId, channelId, 'System', 'Usage: `/task retry <task_id>`', 'system');
              break;
            }
            try {
              const tasks = taskManager.listTasks(projectId);
              const match = tasks.find(t => t.id === cmd.args || t.id.includes(cmd.args));
              if (!match) throw new Error(`Task not found: ${cmd.args}`);
              taskManager.updateTaskStatus(projectId, match.id, 'queued', speaker, 'Manual retry');
              addMessage(projectId, channelId, 'System', `Task "${match.title}" requeued for retry.`, 'system');
            } catch (err) {
              addMessage(projectId, channelId, 'System', `Error: ${err.message}`, 'system');
            }
            break;
          }
          case 'done': {
            if (!cmd.args) {
              addMessage(projectId, channelId, 'System', 'Usage: `/task done <task_id> [reason]`', 'system');
              break;
            }
            try {
              const parts = cmd.args.split(/\s+/);
              const taskIdPart = parts[0];
              const reason = parts.slice(1).join(' ') || 'Manually marked done by operator';
              const tasks = taskManager.listTasks(projectId);
              const match = tasks.find(t => t.id === taskIdPart || t.id.includes(taskIdPart));
              if (!match) throw new Error(`Task not found: ${taskIdPart}`);

              const nonTerminalSubtasks = (match.subtasks || [])
                .filter(st => ['queued', 'claimed', 'executing'].includes(st.status));
              if (nonTerminalSubtasks.length > 0) {
                throw new Error(
                  `Cannot mark done: ${nonTerminalSubtasks.length} non-terminal subtasks remain. Complete/fail subtasks first, then review.`,
                );
              }

              if ((match.subtasks || []).length === 0) {
                taskManager.updateTaskStatus(projectId, match.id, 'done', speaker, reason);
                addMessage(projectId, channelId, 'System', `Task completed: "${match.title}"\nReason: ${reason}`, 'system');
                broadcastToChannel(projectId, channelId, { type: 'task_updated', taskId: match.id, status: 'done' });
                break;
              }

              if (typeof reviewTask !== 'function') {
                throw new Error('Review gate unavailable: cannot finalize task with subtasks without review.');
              }

              if (match.status !== 'reviewing') {
                taskManager.updateTaskStatus(
                  projectId,
                  match.id,
                  'reviewing',
                  speaker,
                  `Manual completion requested: ${reason} (review gate required)`,
                );
              }

              const fresh = taskManager.getTask(projectId, match.id);
              reviewTask(fresh).catch(err =>
                log.error('Review dispatch failed after /task done', { taskId: match.id, error: err.message }),
              );
              addMessage(
                projectId,
                channelId,
                'System',
                `Task "${match.title}" sent to review gate. It will be marked done only if review passes.`,
                'system',
              );
            } catch (err) {
              addMessage(projectId, channelId, 'System', `Error: ${err.message}`, 'system');
            }
            break;
          }
          case 'fail': {
            if (!cmd.args) {
              addMessage(projectId, channelId, 'System', 'Usage: `/task fail <task_id> [reason]`', 'system');
              break;
            }
            try {
              const parts = cmd.args.split(/\s+/);
              const taskIdPart = parts[0];
              const reason = parts.slice(1).join(' ') || 'Manually marked failed by operator';
              const tasks = taskManager.listTasks(projectId);
              const match = tasks.find(t => t.id === taskIdPart || t.id.includes(taskIdPart));
              if (!match) throw new Error(`Task not found: ${taskIdPart}`);
              taskManager.updateTaskStatus(projectId, match.id, 'failed', speaker, reason);
              addMessage(projectId, channelId, 'System', `Task failed: "${match.title}"\nReason: ${reason}`, 'system');
              broadcastToChannel(projectId, channelId, { type: 'task_updated', taskId: match.id, status: 'failed' });
              // Trigger strategist evaluation for campaign/milestone progression
              const campaign = campaignManager.findCampaignByTask(projectId, match.id);
              if (campaign && campaign.status === 'active') {
                strategistEvaluate(projectId, campaign.id).catch(err =>
                  log.error('Strategist evaluation failed after /task fail', { campaignId: campaign.id, error: err.message }));
              }
            } catch (err) {
              addMessage(projectId, channelId, 'System', `Error: ${err.message}`, 'system');
            }
            break;
          }
          case 'create-daemon': {
            if (!cmd.args) {
              addMessage(projectId, channelId, 'System',
                'Usage: `/task create-daemon <title> [--sleep <minutes>] [--daily-cap <usd>] [--cycle-cap <usd>]`\nCreates a recurring daemon task.', 'system');
              break;
            }
            let title = cmd.args;
            let sleepIntervalMs = config.tasks.daemon.defaultSleepMs;
            let maxDailyCost = config.tasks.daemon.maxDailyCostUsd;
            let maxPerCycleCost = config.tasks.daemon.maxPerCycleCostUsd;

            // Parse options
            const sleepMatch = title.match(/--sleep\s+(\d+)/);
            if (sleepMatch) { sleepIntervalMs = parseInt(sleepMatch[1]) * 60 * 1000; title = title.replace(sleepMatch[0], '').trim(); }
            const dailyCapMatch = title.match(/--daily-cap\s+([\d.]+)/);
            if (dailyCapMatch) { maxDailyCost = parseFloat(dailyCapMatch[1]); title = title.replace(dailyCapMatch[0], '').trim(); }
            const cycleCapMatch = title.match(/--cycle-cap\s+([\d.]+)/);
            if (cycleCapMatch) { maxPerCycleCost = parseFloat(cycleCapMatch[1]); title = title.replace(cycleCapMatch[0], '').trim(); }
            // Also parse --done and --context
            let doneCriteria = null;
            let taskContext = null;
            const doneMatch2 = title.match(/--done\s+\"([^\"]+)\"/);
            if (doneMatch2) { doneCriteria = doneMatch2[1]; title = title.replace(doneMatch2[0], '').trim(); }
            const ctxMatch2 = title.match(/--context\s+\"([^\"]+)\"/);
            if (ctxMatch2) { taskContext = ctxMatch2[1]; title = title.replace(ctxMatch2[0], '').trim(); }
            // Detect unquoted flags
            const unquotedFlag2 = title.match(/--(done|context)\s+(?!")/);
            if (unquotedFlag2) {
              addMessage(projectId, channelId, 'System',
                `Flag \`--${unquotedFlag2[1]}\` requires double-quoted value.\nUsage: \`/task create-daemon <title> [--done "criteria"] [--context "text"] [--sleep min] [--daily-cap $] [--cycle-cap $]\``, 'system');
              break;
            }

            const task = taskManager.createTask(projectId, channelId, {
              title, doneCriteria, context: taskContext,
              type: 'daemon',
              daemon: { sleepIntervalMs, maxDailyCost, maxPerCycleCost },
            });
            const sleepMin = Math.round(sleepIntervalMs / 60000);
            addMessage(projectId, channelId, 'System',
              `Daemon task created: \`${task.id}\`\n**${task.title}**\nSleep: ${sleepMin}m between cycles | Daily cap: $${maxDailyCost || '∞'} | Per-cycle cap: $${maxPerCycleCost || '∞'}\n\nThe heartbeat will pick this up and begin planning.`, 'system');
            broadcastToChannel(projectId, channelId, { type: 'task_created', task });
            break;
          }
          case 'pause': {
            if (!cmd.args) {
              addMessage(projectId, channelId, 'System', 'Usage: `/task pause <task_id>` — pause a daemon task', 'system');
              break;
            }
            try {
              const tasks = taskManager.listTasks(projectId);
              const match = tasks.find(t => t.id === cmd.args || t.id.includes(cmd.args));
              if (!match) throw new Error(`Task not found: ${cmd.args}`);
              if (match.type !== 'daemon') throw new Error(`Not a daemon task. Use /task cancel instead.`);
              taskManager.pauseDaemon(projectId, match.id, 'Paused by user');
              addMessage(projectId, channelId, 'System', `Daemon paused: "${match.title}"\nUse \`/task resume ${match.id}\` to restart.`, 'system');
            } catch (err) {
              addMessage(projectId, channelId, 'System', `Error: ${err.message}`, 'system');
            }
            break;
          }
          case 'resume': {
            if (!cmd.args) {
              addMessage(projectId, channelId, 'System', 'Usage: `/task resume <task_id>` — resume a paused daemon', 'system');
              break;
            }
            try {
              const tasks = taskManager.listTasks(projectId);
              const match = tasks.find(t => t.id === cmd.args || t.id.includes(cmd.args));
              if (!match) throw new Error(`Task not found: ${cmd.args}`);
              if (match.type !== 'daemon') throw new Error(`Not a daemon task.`);
              taskManager.resumeDaemon(projectId, match.id);
              addMessage(projectId, channelId, 'System', `Daemon resumed: "${match.title}"`, 'system');
            } catch (err) {
              addMessage(projectId, channelId, 'System', `Error: ${err.message}`, 'system');
            }
            break;
          }
        }
        return true;
      }
    }
    return false;
  }

  async function _handleApproveCommand(trimmed, text, projectId, channelId, speaker) {
    if (trimmed.startsWith('/approve ')) {
      const args = trimmed.slice(9).trim();
      const parts = args.split(/\s+/);

      let milestoneId = null;
      let campaignId = null;
      let targetProjectId = projectId;

      const projectFlagIndex = parts.findIndex(p => p === '--project');
      if (projectFlagIndex !== -1 && projectFlagIndex + 1 < parts.length) {
        targetProjectId = parts[projectFlagIndex + 1];
        parts.splice(projectFlagIndex, 2);
      }

      if (parts.length === 0) {
        addMessage(projectId, channelId, speaker, text);
        addMessage(projectId, channelId, 'System',
          'Usage: `/approve <milestone_id> [--project <project_id>]`\n       or `/approve <campaign_id> <milestone_id>`\nApproves a milestone waiting for operator approval and resumes execution.', 'system');
        return true;
      }

      if (parts.length === 1) {
        milestoneId = parts[0];
      } else if (parts.length >= 2) {
        campaignId = parts[0];
        milestoneId = parts[1];
      } else {
        addMessage(projectId, channelId, speaker, text);
        addMessage(projectId, channelId, 'System',
          'Usage: `/approve <milestone_id> [--project <project_id>]`\n       or `/approve <campaign_id> <milestone_id>`\nApproves a milestone waiting for operator approval and resumes execution.', 'system');
        return true;
      }

      // Authenticate operator via auth.getToken()
      const token = auth.getToken();
      if (!token) {
        addMessage(projectId, channelId, 'System',
          'Error: Authentication not configured. Cannot verify operator identity.', 'system');
        return true;
      }

      try {
        let campaign = null;
        let milestone = null;

        if (campaignId) {
          campaign = campaignManager.getCampaign(targetProjectId, campaignId);
          if (!campaign) {
            throw new Error(`Campaign '${campaignId}' not found in project '${targetProjectId}'.`);
          }
          milestone = campaign.milestones.find(m => m.id === milestoneId || m.id.includes(milestoneId));
          if (!milestone) {
            throw new Error(`Milestone '${milestoneId}' not found in campaign '${campaignId}'.`);
          }
        } else {
          const campaigns = campaignManager.listCampaigns(targetProjectId) || [];
          for (const c of campaigns) {
            milestone = c.milestones.find(m => m.id === milestoneId || m.id.includes(milestoneId));
            if (milestone) {
              campaign = c;
              break;
            }
          }
          if (!milestone) {
            throw new Error(`Milestone '${milestoneId}' not found in any campaign in project '${targetProjectId}'.`);
          }
        }

        if (milestone.status !== 'waiting_approval') {
          throw new Error(`Milestone '${milestoneId}' is not waiting for approval (current status: ${milestone.status}).`);
        }

        campaignManager.approveMilestone(
          targetProjectId,
          campaign.id,
          milestoneId,
          `Approved via CLI by ${speaker}`,
          speaker
        );

        // Record audit entry via operatorAuditStore.append()
        operatorAuditStore.append({
          projectId: targetProjectId,
          timestamp: new Date().toISOString(),
          actorId: speaker,
          actionType: 'milestone_approve',
          target: milestoneId,
          correlationId: campaign.id,
          reason: `Milestone approved via CLI command by operator ${speaker}`,
          source: 'cli',
          status: 'success',
          beforeState: { status: 'waiting_approval', approvalState: milestone.approvalState },
          afterState: { status: 'waiting_approval', approvalState: 'approved', approverId: speaker },
        });

        // Log to approval audit trail
        if (approvalAuditTrail) {
          approvalAuditTrail.logApproval({
            milestoneId: milestoneId,
            projectId: targetProjectId,
            campaignId: campaign.id,
            operatorId: speaker,
            reason: `Approved via CLI by ${speaker}`,
            source: 'cli',
            webhookProvider: null,
            deliveryId: null,
            signatureValidated: false,
            signatureError: null,
            webhookData: {},
          });
        }

        addMessage(projectId, channelId, 'System',
          `✅ Milestone \`${milestoneId}\` approved in project \`${targetProjectId}\`.\n         Campaign: \`${campaign.id}\` | Operator: ${speaker}\n\nExecution will resume automatically.`, 'system');

        // Trigger strategistEvaluate to resume
        strategistEvaluate(targetProjectId, campaign.id).catch(err =>
           log.error('Strategist evaluation failed after /approve', { projectId: targetProjectId, milestoneId, campaignId: campaign.id, error: err.message })
        );

        return true;
      } catch (err) {
        addMessage(projectId, channelId, 'System',
          `❌ Error approving milestone: ${err.message}`, 'system');

        // Record failed audit entry
        operatorAuditStore.append({
          projectId: targetProjectId,
          timestamp: new Date().toISOString(),
          actorId: speaker,
          actionType: 'milestone_approve',
          target: milestoneId,
          reason: err.message,
          source: 'cli',
          status: 'failed',
        });

        return true;
      }
    }
    return false;
  }

  async function _handleProjectCommand(trimmed, text, projectId, channelId, speaker) {
    if (trimmed === '/project' || trimmed.startsWith('/project ')) {
      const parts = trimmed.split(/\s+/);
      const sub = parts[1]?.toLowerCase();

      if (sub === 'list') {
        addMessage(projectId, channelId, speaker, text);
        const projects = stateManager.listProjects();
        if (projects.length === 0) {
          addMessage(projectId, channelId, 'System', 'No projects.', 'system');
        } else {
          const lines = ['**Projects**'];
          for (const p of projects) {
            const alloc = p.allocation ?? 100;
            const mode = p.mode || 'static';
            const paused = alloc === 0 ? ' [PAUSED]' : '';
            lines.push(`\`${p.id}\` — ${p.displayName || p.id} (${mode}, ${alloc}% alloc)${paused}`);
          }
          addMessage(projectId, channelId, 'System', lines.join('\n'), 'system');
        }
        return true;
      }

      if (sub === 'create') {
        const rest = text.trim().slice('/project create'.length).trim();
        if (!rest) {
          addMessage(projectId, channelId, speaker, text);
          addMessage(projectId, channelId, 'System',
            'Usage: `/project create <id> [--name "Display Name"] [--dir /path] [--channels general,dev] [--mode continuous|static]`', 'system');
          return true;
        }

        let idStr = rest;
        let displayName = null;
        let projectDir = null;
        let channels = ['general'];
        let mode = 'static';

        const nameMatch = idStr.match(/--name\s+\"([^\"]+)\"/);
        if (nameMatch) { displayName = nameMatch[1]; idStr = idStr.replace(nameMatch[0], '').trim(); }
        const dirMatch = idStr.match(/--dir\s+\"([^\"]+)\"/);
        if (dirMatch) { projectDir = dirMatch[1]; idStr = idStr.replace(dirMatch[0], '').trim(); }
        else {
          const dirMatch2 = idStr.match(/--dir\s+(\S+)/);
          if (dirMatch2) { projectDir = dirMatch2[1]; idStr = idStr.replace(dirMatch2[0], '').trim(); }
        }
        const channelsMatch = idStr.match(/--channels\s+(\S+)/);
        if (channelsMatch) { channels = channelsMatch[1].split(','); idStr = idStr.replace(channelsMatch[0], '').trim(); }
        const modeMatch = idStr.match(/--mode\s+(continuous|static)/);
        if (modeMatch) { mode = modeMatch[1]; idStr = idStr.replace(modeMatch[0], '').trim(); }

        idStr = idStr.trim();
        if (!idStr) {
          addMessage(projectId, channelId, speaker, text);
          addMessage(projectId, channelId, 'System', 'Error: project ID is required.', 'system');
          return true;
        }

        addMessage(projectId, channelId, speaker, text);

        try {
          const proj = stateManager.createProject(idStr, { displayName, projectDir, channels });
          if (mode === 'continuous' || mode === 'static') {
            proj.mode = mode;
            stateManager._saveProjectConfig(idStr);
          }
          const chList = channels.join(', ');
          addMessage(projectId, channelId, 'System',
            `Project created: \`${proj.name}\`${displayName ? ` (${displayName})` : ''}\nChannels: ${chList} | Mode: ${mode}\nSwitch to it: select from sidebar or use the channel picker.`, 'system');
          broadcast({ type: 'project_created', project: { id: idStr, ...proj } });
        } catch (e) {
          addMessage(projectId, channelId, 'System', `Error: ${e.message}`, 'system');
        }
        return true;
      }

      if (sub === 'vision') {
        const rest = text.trim().slice('/project vision'.length).trim();
        if (!rest) {
          addMessage(projectId, channelId, speaker, text);
          const vision = stateManager.getProjectVision(projectId);
          if (vision) {
            addMessage(projectId, channelId, 'System', `**Vision for ${projectId}:**\n${vision}`, 'system');
          } else {
            addMessage(projectId, channelId, 'System', 'No vision set. Usage: `/project vision <text>`', 'system');
          }
          return true;
        }
        addMessage(projectId, channelId, speaker, text);
        try {
          stateManager.setProjectVision(projectId, rest, { source: 'user' });
          addMessage(projectId, channelId, 'System', `Vision set for **${projectId}**.`, 'system');
          broadcastToChannel(projectId, channelId, { type: 'vision_updated', projectId, vision: rest });
        } catch (e) {
          addMessage(projectId, channelId, 'System', `Error: ${e.message}`, 'system');
        }
        return true;
      }

      // Unknown /project subcommand — show help
      addMessage(projectId, channelId, speaker, text);
      addMessage(projectId, channelId, 'System',
        'Usage:\n- `/project list` — list all projects\n- `/project create <id> [--name "..."] [--dir /path] [--channels a,b] [--mode continuous|static]`\n- `/project vision [text]` — get or set project vision', 'system');
      return true;
    }
    return false;
  }

  async function _handleCampaignCommand(trimmed, text, projectId, channelId, speaker) {
    if (trimmed === '/campaign' || trimmed.startsWith('/campaign ')) {
      const cmd = parseCampaignCommand(text.trim());
      if (cmd) {
        addMessage(projectId, channelId, speaker, text);

        switch (cmd.command) {
          case 'list': {
            const display = campaignManager.formatCampaignList(projectId);
            addMessage(projectId, channelId, 'System', display, 'system');
            break;
          }
          case 'create': {
            if (!cmd.args) {
              addMessage(projectId, channelId, 'System',
                'Usage: `/campaign create <title> [--done "criteria"] [--contingency "plan"] [--priority critical|revenue|normal]`', 'system');
              break;
            }
            let title = cmd.args;
            let doneCriteria = null;
            let contingency = null;
            let priority = 'normal';
            const doneMatch = title.match(/--done\s+\"([^\"]+)\"/);
            if (doneMatch) { doneCriteria = doneMatch[1]; title = title.replace(doneMatch[0], '').trim(); }
            const contingencyMatch = title.match(/--contingency\s+\"([^\"]+)\"/);
            if (contingencyMatch) { contingency = contingencyMatch[1]; title = title.replace(contingencyMatch[0], '').trim(); }
            const priorityMatch = title.match(/--priority\s+(critical|revenue|normal)/);
            if (priorityMatch) { priority = priorityMatch[1]; title = title.replace(priorityMatch[0], '').trim(); }

            const campaign = campaignManager.createCampaign(projectId, {
              title, doneCriteria, contingency, priority,
            });

            if (campaign.status === 'queued') {
              addMessage(projectId, channelId, 'System',
                `Campaign queued: \`${campaign.id}\`\n**${campaign.title}** [${priority}]\n\nAnother campaign is active. This will auto-start when a slot opens.`, 'system');
            } else {
              addMessage(projectId, channelId, 'System',
                `Campaign created: \`${campaign.id}\`\n**${campaign.title}** [${priority}]\n\nSending to architect for milestone decomposition...`, 'system');
            }
            broadcastToChannel(projectId, channelId, { type: 'campaign_created', campaign });
            // Decomposition triggers automatically via campaign:created event
            break;
          }
          case 'show': {
            if (!cmd.args) {
              addMessage(projectId, channelId, 'System', 'Usage: `/campaign show <campaign_id>`', 'system');
              break;
            }
            const campaigns = campaignManager.listCampaigns(projectId);
            const match = campaigns.find(c => c.id === cmd.args || c.id.includes(cmd.args));
            if (match) {
              addMessage(projectId, channelId, 'System',
                campaignManager.formatCampaignSummary(projectId, match.id), 'system');
            } else {
              addMessage(projectId, channelId, 'System', `Campaign not found: ${cmd.args}`, 'system');
            }
            break;
          }
          case 'status': {
            const activeCampaigns = campaignManager.listCampaigns(projectId, 'active');
            if (activeCampaigns.length === 0) {
              addMessage(projectId, channelId, 'System', 'No active campaigns.', 'system');
            } else {
              const lines = ['**Active Campaigns**'];
              for (const c of activeCampaigns) {
                const total = c.milestones.length;
                const done = c.milestones.filter(m => m.status === 'completed').length;
                const active = c.milestones.find(m => m.status === 'active');
                lines.push(`\`${c.id}\` — ${c.title} (${done}/${total} milestones)`);
                if (active) lines.push(`  Current: ${active.title}`);
                if (c.nextAction) lines.push(`  Next: ${c.nextAction}`);
              }
              addMessage(projectId, channelId, 'System', lines.join('\n'), 'system');
            }
            break;
          }
          case 'inject': {
            if (!cmd.args) {
              addMessage(projectId, channelId, 'System',
                'Usage: `/campaign inject <campaign_id> <idea>`', 'system');
              break;
            }
            const parts = cmd.args.split(/\s+/);
            const campIdPart = parts[0];
            const idea = parts.slice(1).join(' ');
            if (!idea) {
              addMessage(projectId, channelId, 'System', 'Provide an idea after the campaign ID.', 'system');
              break;
            }
            const campaigns = campaignManager.listCampaigns(projectId);
            const match = campaigns.find(c => c.id === campIdPart || c.id.includes(campIdPart));
            if (!match) {
              addMessage(projectId, channelId, 'System', `Campaign not found: ${campIdPart}`, 'system');
              break;
            }
            addMessage(projectId, channelId, 'System',
              `Injecting idea into campaign "${match.title}"...\nIdea: ${idea}`, 'system');

            campaignManager._appendEvent(projectId, {
              action: 'idea_injected',
              campaignId: match.id,
              agent: speaker,
              reason: idea,
            });

            (async () => {
              try {
                await strategistInject(projectId, match.id, idea);
              } catch (err) {
                addMessage(projectId, channelId, 'System',
                  `Idea injection error: ${err.message}`, 'system');
              }
            })();
            break;
          }
          case 'pause': {
            if (!cmd.args) {
              addMessage(projectId, channelId, 'System', 'Usage: `/campaign pause <campaign_id>`', 'system');
              break;
            }
            try {
              const campaigns = campaignManager.listCampaigns(projectId);
              const match = campaigns.find(c => c.id === cmd.args || c.id.includes(cmd.args));
              if (!match) throw new Error(`Campaign not found: ${cmd.args}`);
              campaignManager.updateCampaignStatus(projectId, match.id, 'paused', 'Paused by user');
              addMessage(projectId, channelId, 'System',
                `Campaign paused: "${match.title}"\nUse \`/campaign resume ${match.id}\` to restart.`, 'system');
            } catch (err) {
              addMessage(projectId, channelId, 'System', `Error: ${err.message}`, 'system');
            }
            break;
          }
          case 'resume': {
            if (!cmd.args) {
              addMessage(projectId, channelId, 'System', 'Usage: `/campaign resume <campaign_id>`', 'system');
              break;
            }
            try {
              const campaigns = campaignManager.listCampaigns(projectId);
              const match = campaigns.find(c => c.id === cmd.args || c.id.includes(cmd.args));
              if (!match) throw new Error(`Campaign not found: ${cmd.args}`);
              campaignManager.updateCampaignStatus(projectId, match.id, 'active', 'Resumed by user');
              addMessage(projectId, channelId, 'System',
                `Campaign resumed: "${match.title}"`, 'system');
               strategistEvaluate(projectId, match.id).catch(err => log.error('Strategist evaluation failed after campaign resume', { projectId, campaignId: match.id, error: err.message }));
            } catch (err) {
              addMessage(projectId, channelId, 'System', `Error: ${err.message}`, 'system');
            }
            break;
          }
          case 'decompose': {
            if (!cmd.args) {
              addMessage(projectId, channelId, 'System', 'Usage: `/campaign decompose <campaign_id>`', 'system');
              break;
            }
            try {
              const campaigns = campaignManager.listCampaigns(projectId);
              const match = campaigns.find(c => c.id === cmd.args || c.id.includes(cmd.args));
              if (!match) throw new Error(`Campaign not found: ${cmd.args}`);
              if (match.status !== 'active') throw new Error(`Campaign must be active (current: ${match.status})`);
              addMessage(projectId, channelId, 'System',
                `Triggering decomposition for campaign "${match.title}"...`, 'system');
              strategistDecomposeCampaign(projectId, match.id).catch(err => {
                addMessage(projectId, channelId, 'System', `Decomposition failed: ${err.message}`, 'system');
              });
            } catch (err) {
              addMessage(projectId, channelId, 'System', `Error: ${err.message}`, 'system');
            }
            break;
          }
          case 'replay': {
            if (!cmd.args) {
              addMessage(projectId, channelId, 'System', 'Usage: `/campaign replay <campaign_id> <checkpoint_id>`', 'system');
              break;
            }
            try {
              const parts = cmd.args.split(/\s+/);
              const campIdPart = parts[0];
              const checkpointId = parts[1];
              if (!checkpointId) {
                addMessage(projectId, channelId, 'System', 'Usage: `/campaign replay <campaign_id> <checkpoint_id>`', 'system');
                break;
              }
              const campaigns = campaignManager.listCampaigns(projectId);
              const match = campaigns.find(c => c.id === campIdPart || c.id.includes(campIdPart));
              if (!match) throw new Error(`Campaign not found: ${campIdPart}`);
              addMessage(projectId, channelId, 'System',
                `Replaying campaign "${match.title}" from checkpoint \`${checkpointId}\`...`, 'system');
              checkpointManager.replayFromCheckpoint(projectId, match.id, checkpointId, campaignManager, taskManager).then(() => {
                addMessage(projectId, channelId, 'System',
                  `Campaign "${match.title}" successfully replayed from checkpoint \`${checkpointId}\`. Re-evaluating work queue...`, 'system');
                strategistEvaluate(projectId, match.id).catch(err => log.error('Strategist evaluation failed after checkpoint replay', { projectId, campaignId: match.id, error: err.message }));
              }).catch(err => {
                addMessage(projectId, channelId, 'System', `Replay failed: ${err.message}`, 'system');
              });
            } catch (err) {
              addMessage(projectId, channelId, 'System', `Error: ${err.message}`, 'system');
            }
            break;
          }
          case 'milestone': {
             if (!cmd.args) {
               addMessage(projectId, channelId, 'System',
                 'Usage: `/campaign milestone <campaign_id> add <title> [--done "criteria"] [--contingency "plan"] [--after msId] [--blocked-by msId]`', 'system');
               break;
             }
             const msMatch = cmd.args.match(/^(\S+)\s+add\s+(.+)$/s);
             if (!msMatch) {
               addMessage(projectId, channelId, 'System',
                 'Usage: `/campaign milestone <campaign_id> add <title> [--done "criteria"] [--contingency "plan"] [--after msId] [--blocked-by msId]`', 'system');
               break;
             }
             const campIdPart = msMatch[1];
             let msTitle = msMatch[2];
             let msDone = null;
             let msContingency = null;
             let msBlockedBy = [];

             const doneM = msTitle.match(/--done\s+\"([^\"]+)\"/);
             if (doneM) { msDone = doneM[1]; msTitle = msTitle.replace(doneM[0], '').trim(); }
             const contM = msTitle.match(/--contingency\s+\"([^\"]+)\"/);
             if (contM) { msContingency = contM[1]; msTitle = msTitle.replace(contM[0], '').trim(); }
             const blockM = msTitle.match(/--blocked-by\s+(\S+)/);
             if (blockM) { msBlockedBy = [blockM[1]]; msTitle = msTitle.replace(blockM[0], '').trim(); }

             try {
               const campaigns = campaignManager.listCampaigns(projectId);
               const campMatch = campaigns.find(c => c.id === campIdPart || c.id.includes(campIdPart));
               if (!campMatch) throw new Error(`Campaign not found: ${campIdPart}`);

               const existingMs = campMatch.milestones;
               const order = existingMs.length > 0
                 ? Math.max(...existingMs.map(m => m.order)) + 1
                 : 1;

               const ms = campaignManager.addMilestone(projectId, campMatch.id, {
                 title: msTitle, doneCriteria: msDone, contingency: msContingency,
                 blockedBy: msBlockedBy, order,
               });
               addMessage(projectId, channelId, 'System',
                 `Milestone added: **${ms.title}** → campaign "${campMatch.title}"`, 'system');
             } catch (err) {
               addMessage(projectId, channelId, 'System', `Error: ${err.message}`, 'system');
             }
             break;
           }
 
         }
         return true;
       }
     }
     return false;
   }

  async function _handleScheduleCommand(trimmed, text, projectId, channelId, speaker) {
    if (trimmed === '/schedule' || trimmed.startsWith('/schedule ')) {
      const cmd = parseScheduleCommand(text.trim());
      if (!cmd) {
        addMessage(projectId, channelId, speaker, text);
        addMessage(projectId, channelId, 'System',
          'Unknown schedule command. Use: `/schedule create|list|show|pause|resume|delete|trigger`', 'system');
        return true;
      }

      addMessage(projectId, channelId, speaker, text);

      switch (cmd.command) {
        case 'list': {
          const schedules = scheduleManager.listSchedules(projectId);
          if (schedules.length === 0) {
            addMessage(projectId, channelId, 'System', 'No schedules found.', 'system');
          } else {
            const lines = schedules.map(s => {
              const next = s.nextFireAt ? new Date(s.nextFireAt).toLocaleString() : 'N/A';
              return `- **${s.title}** (\`${s.id}\`) [${s.status}] type=${s.type} next=${next} fires=${s.fireCount}`;
            });
            addMessage(projectId, channelId, 'System', `Schedules (${schedules.length}):\n${lines.join('\n')}`, 'system');
          }
          break;
        }

        case 'create': {
          if (!cmd.args) {
            addMessage(projectId, channelId, 'System',
              'Usage: `/schedule create <title> --type cron|interval|once --cron "expr" | --interval <ms> | --delay <ms> --action "message text"`', 'system');
            break;
          }

          try {
            // Parse flags from args
            const titleMatch = cmd.args.match(/^(.+?)(?=\s+--)/) || [null, cmd.args];
            const title = titleMatch[1].trim();
            const typeMatch = cmd.args.match(/--type\s+(\w+)/);
            const cronMatch = cmd.args.match(/--cron\s+"([^"]+)"/);
            const intervalMatch = cmd.args.match(/--interval\s+(\d+)/);
            const delayMatch = cmd.args.match(/--delay\s+(\d+)/);
            const actionMatch = cmd.args.match(/--action\s+"([^"]+)"/);
            const channelMatch = cmd.args.match(/--channel\s+(\S+)/);

            const type = typeMatch?.[1] || (cronMatch ? 'cron' : intervalMatch ? 'interval' : delayMatch ? 'once' : null);
            if (!type) throw new Error('Missing --type or infer from --cron/--interval/--delay');

            const schedule = scheduleManager.createSchedule(projectId, {
              title,
              type,
              cron: cronMatch?.[1] || null,
              intervalMs: intervalMatch ? parseInt(intervalMatch[1]) : null,
              delayMs: delayMatch ? parseInt(delayMatch[1]) : null,
              action: { type: 'message', content: actionMatch?.[1] || title },
              channel: channelMatch?.[1] || channelId,
            });

            const next = schedule.nextFireAt ? new Date(schedule.nextFireAt).toLocaleString() : 'N/A';
            addMessage(projectId, channelId, 'System',
              `Schedule created: **${schedule.title}** (\`${schedule.id}\`)\nType: ${schedule.type} | Next fire: ${next}`, 'system');
          } catch (err) {
            addMessage(projectId, channelId, 'System', `Error: ${err.message}`, 'system');
          }
          break;
        }

        case 'show': {
          if (!cmd.args) {
            addMessage(projectId, channelId, 'System', 'Usage: `/schedule show <schedule_id>`', 'system');
            break;
          }
          const schedule = scheduleManager.getSchedule(projectId, cmd.args);
          if (!schedule) {
            addMessage(projectId, channelId, 'System', `Schedule not found: ${cmd.args}`, 'system');
          } else {
            const next = schedule.nextFireAt ? new Date(schedule.nextFireAt).toLocaleString() : 'N/A';
            const lastFired = schedule.lastFiredAt ? new Date(schedule.lastFiredAt).toLocaleString() : 'never';
            const lines = [
              `**${schedule.title}** (\`${schedule.id}\`)`,
              `Status: ${schedule.status} | Type: ${schedule.type}`,
              schedule.cron ? `Cron: \`${schedule.cron}\`` : null,
              schedule.intervalMs ? `Interval: ${schedule.intervalMs}ms` : null,
              `Next fire: ${next}`,
              `Last fired: ${lastFired} | Fire count: ${schedule.fireCount}`,
              `Action: ${schedule.action.type} — "${schedule.action.content || schedule.action.title || ''}"`,
            ].filter(Boolean);
            addMessage(projectId, channelId, 'System', lines.join('\n'), 'system');
          }
          break;
        }

        case 'pause': {
          if (!cmd.args) {
            addMessage(projectId, channelId, 'System', 'Usage: `/schedule pause <schedule_id>`', 'system');
            break;
          }
          try {
            scheduleManager.updateScheduleStatus(projectId, cmd.args, 'paused', 'Paused via CLI');
            addMessage(projectId, channelId, 'System', `Schedule paused: ${cmd.args}`, 'system');
          } catch (err) {
            addMessage(projectId, channelId, 'System', `Error: ${err.message}`, 'system');
          }
          break;
        }

        case 'resume': {
          if (!cmd.args) {
            addMessage(projectId, channelId, 'System', 'Usage: `/schedule resume <schedule_id>`', 'system');
            break;
          }
          try {
            scheduleManager.updateScheduleStatus(projectId, cmd.args, 'active', 'Resumed via CLI');
            addMessage(projectId, channelId, 'System', `Schedule resumed: ${cmd.args}`, 'system');
          } catch (err) {
            addMessage(projectId, channelId, 'System', `Error: ${err.message}`, 'system');
          }
          break;
        }

        case 'delete': {
          if (!cmd.args) {
            addMessage(projectId, channelId, 'System', 'Usage: `/schedule delete <schedule_id>`', 'system');
            break;
          }
          const deleted = scheduleManager.deleteSchedule(projectId, cmd.args);
          if (deleted) {
            addMessage(projectId, channelId, 'System', `Schedule deleted: "${deleted.title}"`, 'system');
          } else {
            addMessage(projectId, channelId, 'System', `Schedule not found: ${cmd.args}`, 'system');
          }
          break;
        }

        case 'trigger': {
          if (!cmd.args) {
            addMessage(projectId, channelId, 'System', 'Usage: `/schedule trigger <schedule_id>`', 'system');
            break;
          }
          const schedule = scheduleManager.getSchedule(projectId, cmd.args);
          if (!schedule) {
            addMessage(projectId, channelId, 'System', `Schedule not found: ${cmd.args}`, 'system');
          } else {
            addMessage(projectId, channelId, 'System', `Triggering schedule: "${schedule.title}"...`, 'system');
          }
          break;
        }
      }
      return true;
    }
    return false;
  }

  async function _handleTriggerCommand(trimmed, text, projectId, channelId, speaker) {
    if (trimmed === '/trigger' || trimmed.startsWith('/trigger ')) {
      const cmdText = text.trim().slice('/trigger'.length).trim();
      const cmd = parseTriggerCommand(cmdText);
      if (!cmd) {
        addMessage(projectId, channelId, speaker, text);
        addMessage(projectId, channelId, 'System',
          'Unknown trigger command. Use: `/trigger create|list|show|pause|resume|delete`', 'system');
        return true;
      }

      addMessage(projectId, channelId, speaker, text);

      switch (cmd.subcommand) {
        case 'list': {
          const triggers = triggerManager.listTriggers(projectId);
          if (triggers.length === 0) {
            addMessage(projectId, channelId, 'System', 'No triggers found.', 'system');
          } else {
            const lines = triggers.map(t =>
              `- **${t.description || t.event}** (\`${t.id}\`) [${t.status}] event=${t.event} action=${t.action} fires=${t.fireCount}`
            );
            addMessage(projectId, channelId, 'System', `Triggers (${triggers.length}):\n${lines.join('\n')}`, 'system');
          }
          break;
        }

        case 'create': {
          const { event, action, config: cfg, channel, condition, description } = cmd.args;
          if (!event || !action) {
            addMessage(projectId, channelId, 'System',
              'Usage: `/trigger create --event <event> --action message|task|prompt --content "text" [--channel ch] [--condition field=value]`', 'system');
            break;
          }
          try {
            const trigger = triggerManager.createTrigger(projectId, {
              event, action, config: cfg,
              channel: channel || channelId,
              condition: condition || null,
              description: description || null,
            });
            addMessage(projectId, channelId, 'System',
              `Trigger created: **${trigger.event} → ${trigger.action}** (\`${trigger.id}\`)`, 'system');
          } catch (err) {
            addMessage(projectId, channelId, 'System', `Error: ${err.message}`, 'system');
          }
          break;
        }

        case 'show': {
          if (!cmd.args.triggerId) {
            addMessage(projectId, channelId, 'System', 'Usage: `/trigger show <trigger_id>`', 'system');
            break;
          }
          const trigger = triggerManager.getTrigger(projectId, cmd.args.triggerId);
          if (!trigger) {
            addMessage(projectId, channelId, 'System', `Trigger not found: ${cmd.args.triggerId}`, 'system');
          } else {
            const lines = [
              `**${trigger.description || trigger.event + ' → ' + trigger.action}** (\`${trigger.id}\`)`,
              `Status: ${trigger.status} | Event: ${trigger.event} | Action: ${trigger.action}`,
              `Channel: ${trigger.channel}`,
              trigger.condition ? `Condition: ${JSON.stringify(trigger.condition)}` : null,
              `Config: ${JSON.stringify(trigger.config)}`,
              `Fire count: ${trigger.fireCount} | Last fired: ${trigger.lastFiredAt || 'never'}`,
            ].filter(Boolean);
            addMessage(projectId, channelId, 'System', lines.join('\n'), 'system');
          }
          break;
        }

        case 'pause': {
          if (!cmd.args.triggerId) {
            addMessage(projectId, channelId, 'System', 'Usage: `/trigger pause <trigger_id>`', 'system');
            break;
          }
          const result = triggerManager.updateTriggerStatus(projectId, cmd.args.triggerId, 'paused');
          addMessage(projectId, channelId, 'System',
            result !== false ? `Trigger paused: ${cmd.args.triggerId}` : `Trigger not found: ${cmd.args.triggerId}`, 'system');
          break;
        }

        case 'resume': {
          if (!cmd.args.triggerId) {
            addMessage(projectId, channelId, 'System', 'Usage: `/trigger resume <trigger_id>`', 'system');
            break;
          }
          const result = triggerManager.updateTriggerStatus(projectId, cmd.args.triggerId, 'active');
          addMessage(projectId, channelId, 'System',
            result !== false ? `Trigger resumed: ${cmd.args.triggerId}` : `Trigger not found: ${cmd.args.triggerId}`, 'system');
          break;
        }

        case 'delete': {
          if (!cmd.args.triggerId) {
            addMessage(projectId, channelId, 'System', 'Usage: `/trigger delete <trigger_id>`', 'system');
            break;
          }
          const deleted = triggerManager.deleteTrigger(projectId, cmd.args.triggerId);
          addMessage(projectId, channelId, 'System',
            deleted ? `Trigger deleted: ${cmd.args.triggerId}` : `Trigger not found: ${cmd.args.triggerId}`, 'system');
          break;
        }
      }
      return true;
    }
    return false;
  }

  async function _handleWorkflowCommand(trimmed, text, projectId, channelId, speaker) {
    if (trimmed === '/workflow' || trimmed.startsWith('/workflow ')) {
      const cmdText = text.trim().slice('/workflow'.length).trim();
      const cmd = parseWorkflowCommand(cmdText);
      if (!cmd) {
        addMessage(projectId, channelId, speaker, text);
        addMessage(projectId, channelId, 'System',
          'Unknown workflow command. Use: `/workflow create|list|show|run|runs|run-detail|cancel|pause|resume|delete`', 'system');
        return true;
      }

      addMessage(projectId, channelId, speaker, text);

      switch (cmd.subcommand) {
        case 'list': {
          const display = workflowManager.formatWorkflowList(projectId);
          addMessage(projectId, channelId, 'System', display, 'system');
          break;
        }

        case 'create': {
          const { title, description, json: jsonStr } = cmd.args;
          if (!title || !jsonStr) {
            addMessage(projectId, channelId, 'System',
              'Usage: `/workflow create --title "Pipeline Name" --json \'{"nodes": [...]}`\n\nNode format: `{"id":"n1","title":"Step 1","type":"task|message|prompt|condition","config":{...},"dependsOn":[]}`', 'system');
            break;
          }
          try {
            const parsed = JSON.parse(jsonStr);
            const wf = workflowManager.createWorkflow(projectId, {
              title, description, nodes: parsed.nodes || parsed,
            });
            addMessage(projectId, channelId, 'System',
              `Workflow created: **${wf.title}** (\`${wf.id}\`) — ${wf.nodes.length} nodes`, 'system');
          } catch (err) {
            addMessage(projectId, channelId, 'System', `Error: ${err.message}`, 'system');
          }
          break;
        }

        case 'show': {
          if (!cmd.args.workflowId) {
            addMessage(projectId, channelId, 'System', 'Usage: `/workflow show <workflow_id>`', 'system');
            break;
          }
          const display = workflowManager.formatWorkflowDetail(projectId, cmd.args.workflowId);
          addMessage(projectId, channelId, 'System', display, 'system');
          break;
        }

        case 'run': {
          if (!cmd.args.workflowId) {
            addMessage(projectId, channelId, 'System', 'Usage: `/workflow run <workflow_id>`', 'system');
            break;
          }
          try {
            const run = workflowManager.startRun(projectId, cmd.args.workflowId, { type: 'manual', speaker });
            addMessage(projectId, channelId, 'System',
              `Workflow run started: \`${run.id}\`\nNodes will execute automatically as dependencies complete.`, 'system');
          } catch (err) {
            addMessage(projectId, channelId, 'System', `Error: ${err.message}`, 'system');
          }
          break;
        }

        case 'runs': {
          const runs = workflowManager.listRuns(projectId, cmd.args.workflowId || null);
          if (runs.length === 0) {
            addMessage(projectId, channelId, 'System', 'No workflow runs found.', 'system');
          } else {
            const lines = runs.map(r => {
              const completedNodes = Object.values(r.nodeStates).filter(s => s.status === 'completed').length;
              const totalNodes = Object.keys(r.nodeStates).length;
              return `- **${r.id}** [${r.status}] workflow=${r.workflowId} (${completedNodes}/${totalNodes} nodes) started=${r.startedAt}`;
            });
            addMessage(projectId, channelId, 'System', `Workflow runs (${runs.length}):\n${lines.join('\n')}`, 'system');
          }
          break;
        }

        case 'run-detail': {
          if (!cmd.args.runId) {
            addMessage(projectId, channelId, 'System', 'Usage: `/workflow run-detail <run_id>`', 'system');
            break;
          }
          const display = workflowManager.formatRunDetail(projectId, cmd.args.runId);
          addMessage(projectId, channelId, 'System', display, 'system');
          break;
        }

        case 'cancel': {
          if (!cmd.args.runId) {
            addMessage(projectId, channelId, 'System', 'Usage: `/workflow cancel <run_id>`', 'system');
            break;
          }
          const cancelled = workflowManager.cancelRun(projectId, cmd.args.runId);
          addMessage(projectId, channelId, 'System',
            cancelled ? `Workflow run cancelled: ${cmd.args.runId}` : `Run not found or not running: ${cmd.args.runId}`, 'system');
          break;
        }

        case 'pause': {
          if (!cmd.args.workflowId) {
            addMessage(projectId, channelId, 'System', 'Usage: `/workflow pause <workflow_id>`', 'system');
            break;
          }
          try {
            workflowManager.updateWorkflowStatus(projectId, cmd.args.workflowId, 'paused');
            addMessage(projectId, channelId, 'System', `Workflow paused: ${cmd.args.workflowId}`, 'system');
          } catch (err) {
            addMessage(projectId, channelId, 'System', `Error: ${err.message}`, 'system');
          }
          break;
        }

        case 'resume': {
          if (!cmd.args.workflowId) {
            addMessage(projectId, channelId, 'System', 'Usage: `/workflow resume <workflow_id>`', 'system');
            break;
          }
          try {
            workflowManager.updateWorkflowStatus(projectId, cmd.args.workflowId, 'active');
            addMessage(projectId, channelId, 'System', `Workflow resumed: ${cmd.args.workflowId}`, 'system');
          } catch (err) {
            addMessage(projectId, channelId, 'System', `Error: ${err.message}`, 'system');
          }
          break;
        }

        case 'delete': {
          if (!cmd.args.workflowId) {
            addMessage(projectId, channelId, 'System', 'Usage: `/workflow delete <workflow_id>`', 'system');
            break;
          }
          const deleted = workflowManager.deleteWorkflow(projectId, cmd.args.workflowId);
          addMessage(projectId, channelId, 'System',
            deleted ? `Workflow deleted: ${cmd.args.workflowId}` : `Workflow not found: ${cmd.args.workflowId}`, 'system');
          break;
        }
      }
      return true;
    }
    return false;
  }

  function _timeSince(date) {
    const secs = Math.max(0, Math.floor((Date.now() - date.getTime()) / 1000));
    if (secs < 60) return `${secs}s`;
    const mins = Math.floor(secs / 60);
    if (mins < 60) return `${mins}m`;
    const hours = Math.floor(mins / 60);
    if (hours < 24) return `${hours}h`;
    const days = Math.floor(hours / 24);
    return `${days}d`;
  }

  function _formatDurationSeconds(totalSeconds) {
    const secs = Math.max(0, Math.floor(totalSeconds));
    const days = Math.floor(secs / 86400);
    const hours = Math.floor((secs % 86400) / 3600);
    const mins = Math.floor((secs % 3600) / 60);
    const remSecs = secs % 60;

    const parts = [];
    if (days > 0) parts.push(`${days}d`);
    if (days > 0 || hours > 0) parts.push(`${hours}h`);
    if (days > 0 || hours > 0 || mins > 0) parts.push(`${mins}m`);
    parts.push(`${remSecs}s`);
    return parts.join(' ');
  }

  function _toMiB(bytes) {
    return Math.round(bytes / 1048576);
  }

  async function _handleStatusCommand(trimmed, text, projectId, channelId, speaker) {
    if (trimmed === '/status') {
      addMessage(projectId, channelId, speaker, text);

      const activeAgents = Object.entries(agents)
        .filter(([, agent]) => !agent?._status || agent._status === 'active')
        .map(([id, agent]) => ({
          name: agent.name || id,
          model: agent.model || 'default',
        }));

      let pendingTasks = 0;
      let runningTasks = 0;
      for (const task of taskManager.listTasks(projectId)) {
        if (['done', 'failed', 'cancelled'].includes(task.status)) continue;
        if (task.status === 'executing' || task.status === 'reviewing') runningTasks++;
        else pendingTasks++;
      }

      const activeCampaignCount = campaignManager.listCampaigns(projectId, 'active').length;
      const mem = process.memoryUsage();
      const uptime = _formatDurationSeconds(process.uptime());

      const agentLines = activeAgents.length > 0
        ? activeAgents.map(a => `  - ${a.name} (${a.model})`).join('\n')
        : '  - none';

      const lines = [
        '**System Status**',
        `Server uptime: ${uptime}`,
        '',
        `Active agents (${activeAgents.length}):`,
        agentLines,
        '',
        `Tasks: ${pendingTasks} pending, ${runningTasks} running`,
        `Active campaigns: ${activeCampaignCount}`,
        `Memory: ${_toMiB(mem.rss)}MB RSS, ${_toMiB(mem.heapUsed)}MB heap`,
      ];
      addMessage(projectId, channelId, 'System', lines.join('\n'), 'system');
      return true;
    }
    return false;
  }

  async function _handleHealthCommand(trimmed, text, projectId, channelId, speaker, wss) {
    if (trimmed === '/health' || trimmed === '/health --json') {
      const isJson = trimmed.includes('--json');
      addMessage(projectId, channelId, speaker, text);

      const uptimeMs = Date.now() - SERVER_START_TIME;
      const uptimeStr = _timeSince(new Date(SERVER_START_TIME)); // Use a local timeSince for consistency

      const wsConnections = wss ? [...wss.clients].filter(c => c.readyState === 1).length : 0;

      const agentStatuses = {};
      for (const [name, agent] of Object.entries(agents)) {
        let status = 'idle';
        for (const key of thinkingAgents) {
          if (key.endsWith(`#${name}`)) { status = 'thinking'; break; }
        }
        const fbState = fallbackStates.get(name);
        if (isAgentCoolingDown(name)) { // isAgentCoolingDown comes from deps
          const until = agentCooldowns.get(name);
          const remainMs = until - Date.now();
          const remainMins = Math.ceil(remainMs / 60000);
          status = fbState?.active
            ? `fallback (${fbState.currentProvider}/${fbState.currentModel}, primary back in ${remainMins}m)`
            : `rate_limited (${remainMins}m remaining)`;
        }
        agentStatuses[name] = { status, model: agent.model };
      }

      const allThreads = stateManager.getActiveThreads(projectId, channelId);
      const activeThreadCount = allThreads.filter(t => t.status === 'active').length;
      const mem = process.memoryUsage();

      if (isJson) {
        const data = {
          uptime: { ms: uptimeMs, human: uptimeStr },
          websocketConnections: wsConnections,
          agents: agentStatuses,
          sessionMessages: getSessionMessageCount(),
          activeThreads: activeThreadCount,
          memory: {
            rss: Math.round(mem.rss / 1048576),
            heapUsed: Math.round(mem.heapUsed / 1048576),
            heapTotal: Math.round(mem.heapTotal / 1048576),
          },
        };
        addMessage(projectId, channelId, 'System',
          '```json\n' + JSON.stringify(data, null, 2) + '\n```', 'system');
      } else {
        const agentLines = Object.entries(agentStatuses)
          .map(([name, info]) => `  ${name}: ${info.status} (${info.model})`)
          .join('\n');
        const card = [
          '**Synapse Health**',
          `Uptime: ${uptimeStr}`,
          `WebSocket clients: ${wsConnections}`,
          `Session messages: ${getSessionMessageCount()}`,
          `Active threads: ${activeThreadCount}`,
          `Memory: ${Math.round(mem.rss / 1048576)}MB RSS, ${Math.round(mem.heapUsed / 1048576)}MB heap`,
          '',
          '**Agents:**',
          agentLines,
        ].join('\n');
        addMessage(projectId, channelId, 'System', card, 'system');
      }
      return true;
    }
    return false;
  }

  async function _handleThreadCommand(cmd, projectId, channelId, speaker) {
    const { command, args } = cmd;

    if (command === 'start') {
      const label = args || 'New thread';
      const id = generateThreadId(label);
      stateManager.createThread(projectId, { id, label, channel: channelId });
      const { keywords, anchorKeywords } = updateThreadKeywords({ keywords: [], anchorKeywords: [] }, label, true);
      stateManager.updateThread(projectId, id, { keywords, anchorKeywords });
      stateManager.setChannelActiveThread(projectId, channelId, id);
      addMessage(projectId, channelId, 'System',
        `Thread started: "${label}" — all messages will go to this thread until you /thread end or /thread auto`, 'system', { threadId: id });
      broadcastToChannel(projectId, channelId, {
        type: 'thread_created', threadId: id, label, channel: channelId,
      });
      broadcastToChannel(projectId, channelId, {
        type: 'thread_switched', threadId: id, label,
      });
    }

    else if (command === 'switch') {
      if (!args) {
        addMessage(projectId, channelId, 'System', 'Usage: /thread switch <thread-slug>', 'system');
        return;
      }
      const activeThreads = stateManager.getActiveThreads(projectId, channelId);
      const target = activeThreads.find(t =>
        t.id.includes(args.toLowerCase()) || t.label.toLowerCase().includes(args.toLowerCase())
      );
      if (!target) {
        addMessage(projectId, channelId, 'System',
          `No active thread matching "${args}". Use /thread list to see threads.`, 'system');
        return;
      }
      stateManager.setChannelActiveThread(projectId, channelId, target.id);
      addMessage(projectId, channelId, 'System',
        `Switched to thread: "${target.label}"`, 'system', { threadId: target.id });
      broadcastToChannel(projectId, channelId, {
        type: 'thread_switched', threadId: target.id, label: target.label,
      });
    }

    else if (command === 'list') {
      const activeThreads = stateManager.getActiveThreads(projectId, channelId);
      if (activeThreads.length === 0) {
        addMessage(projectId, channelId, 'System', 'No active threads in this channel.', 'system');
        return;
      }
      const currentActive = stateManager.getChannelActiveThread(projectId, channelId);
      const lines = activeThreads.map(t => {
        const active = t.id === currentActive ? ' ← active' : '';
        return `• "${t.label}" (${t.messageCount || 0} msgs, ${t.participants?.join(', ') || 'none'})${active}`;
      });
      addMessage(projectId, channelId, 'System', `Active threads:\n${lines.join('\n')}`, 'system');
    }

    else if (command === 'end') {
      const currentActive = stateManager.getChannelActiveThread(projectId, channelId);
      if (!currentActive) {
        addMessage(projectId, channelId, 'System', 'No active thread to end. Use /thread list.', 'system');
        return;
      }
      const thread = stateManager.getThread(projectId, currentActive);
      stateManager.updateThread(projectId, currentActive, { status: 'closed' });
      stateManager.setChannelActiveThread(projectId, channelId, null);
      addMessage(projectId, channelId, 'System',
        `Thread closed: "${thread?.label || currentActive}"`, 'system', { threadId: currentActive });
      broadcastToChannel(projectId, channelId, {
        type: 'thread_ended', threadId: currentActive,
      });
    }

    else if (command === 'auto') {
      stateManager.setChannelActiveThread(projectId, channelId, null);
      addMessage(projectId, channelId, 'System',
        'Auto-classification mode — messages will be routed to threads automatically.', 'system');
      broadcastToChannel(projectId, channelId, {
        type: 'thread_switched', threadId: null, label: null,
      });
    }
  }

  async function _handleSteerStreamCommand(trimmed, text, projectId, channelId, speaker) {
    if (trimmed !== '/steer-stream' && !trimmed.startsWith('/steer-stream ')) {
      return false;
    }

    if (!cliSteeringSubscriber) {
      addMessage(projectId, channelId, speaker, text);
      addMessage(projectId, channelId, 'System',
        'Steering stream subscriber not available. Please ensure the CLI steering subscriber is initialized.', 'system');
      return true;
    }

    if (trimmed === '/steer-stream' || trimmed === '/steer-stream start') {
      addMessage(projectId, channelId, speaker, text);
      
      cliSteeringSubscriber.onEvent = (event) => {
        const formatted = cliSteeringSubscriber.formatEvent(event);
        addMessage(projectId, channelId, 'System', formatted, 'system');
      };

      cliSteeringSubscriber.onLatencyWarning = (p95Latency) => {
        const warning = cliSteeringSubscriber.formatLatencyWarning(p95Latency);
        addMessage(projectId, channelId, 'System', warning, 'system');
      };

      cliSteeringSubscriber.onLatencyRecovered = () => {
        const recovered = cliSteeringSubscriber.formatLatencyRecovered();
        addMessage(projectId, channelId, 'System', recovered, 'system');
      };

      cliSteeringSubscriber.onConnected = () => {
        addMessage(projectId, channelId, 'System',
          '✅ Connected to steering event stream. Listening for real-time steering actions.', 'system');
      };

      cliSteeringSubscriber.onDisconnected = () => {
        addMessage(projectId, channelId, 'System',
          '⚠️  Disconnected from steering event stream. Reconnecting...', 'system');
      };

      cliSteeringSubscriber.connect();
      addMessage(projectId, channelId, 'System',
        'Starting CLI steering event subscriber...\nUse `/steer-stream stop` to disconnect.', 'system');
      return true;
    }

    else if (trimmed === '/steer-stream stop' || trimmed === '/steer-stream status') {
      addMessage(projectId, channelId, speaker, text);
      
      const status = cliSteeringSubscriber.getStatus();
      const lines = [
        '**Steering Stream Status**',
        `Connected: ${status.connected ? 'Yes' : 'No'}`,
        `Fallback polling: ${status.fallbackActive ? 'Active' : 'Inactive'}`,
        `P95 Latency: ${Math.round(status.latencyP95)}ms`,
        `Events received: ${status.eventsReceived}`,
      ];
      
      addMessage(projectId, channelId, 'System', lines.join('\n'), 'system');
      
      if (trimmed === '/steer-stream stop') {
        cliSteeringSubscriber.disconnect();
        addMessage(projectId, channelId, 'System', 'Steering stream subscriber stopped.', 'system');
      }
      
      return true;
    }

    return false;
  }


  async function _handleProjectCommand(trimmed, text, projectId, channelId, speaker) {
    if (trimmed === '/project vision history') {
      addMessage(projectId, channelId, speaker, text);
      const history = stateManager.getProjectVisionHistory(projectId);
      if (history.length === 0) {
        addMessage(projectId, channelId, 'System', 'No vision history yet.', 'system');
      } else {
        const lines = history.map((entry, i) => {
          const date = entry.timestamp?.split('T')[0] || 'unknown';
          const src = entry.source === 'closeout' ? `closeout (campaign)` : 'user';
          return `**${i + 1}. ${date}** (${src})\n> ${entry.vision}`;
        }).join('\n\n');
        addMessage(projectId, channelId, 'System', `**Vision History:**\n\n${lines}`, 'system');
      }
      return true;
    }
    if (trimmed === '/project vision' || trimmed.startsWith('/project vision ')) {
      addMessage(projectId, channelId, speaker, text);
      const arg = text.trim().slice('/project vision'.length).trim();
      if (!arg) {
        // Show current vision
        const vision = stateManager.getProjectVision(projectId);
        const history = stateManager.getProjectVisionHistory(projectId);
        if (vision) {
          const revisions = history.length > 1 ? ` (${history.length} revisions — \`/project vision history\`)` : '';
          addMessage(projectId, channelId, 'System', `**Project Vision:**\n${vision}${revisions}`, 'system');
        } else {
          addMessage(projectId, channelId, 'System',
            'No project vision set. Use `/project vision <text>` to set one.', 'system');
        }
      } else {
        stateManager.setProjectVision(projectId, arg, { source: 'user' });
        addMessage(projectId, channelId, 'System', `Project vision updated.`, 'system');
      }
      return true;
    }
    return false;
  }

  async function handleCommand(text, projectId, channelId, wsThreadMeta, speaker = 'operator', wss) {
    const trimmed = text.trim().toLowerCase();

    // Handle /project commands
    if (await _handleProjectCommand(trimmed, text, projectId, channelId, speaker)) return true;

    // Handle /session commands
    if (await _handleSessionCommand(trimmed, text, projectId, channelId, speaker)) return true;

    // Handle /cleanup command
    if (await _handleCleanupCommand(trimmed, text, projectId, channelId, speaker)) return true;

    // Handle /agenda commands
    if (await _handleAgendaCommand(trimmed, text, projectId, channelId, speaker)) return true;

    // Handle /prefs commands
    if (await _handlePrefsCommand(trimmed, text, projectId, channelId, speaker)) return true;

    // Handle /task commands
    if (await _handleTaskCommand(trimmed, text, projectId, channelId, speaker)) return true;

    // Handle /project commands
    if (await _handleProjectCommand(trimmed, text, projectId, channelId, speaker)) return true;

    // Handle /campaign commands
    if (await _handleCampaignCommand(trimmed, text, projectId, channelId, speaker)) return true;

    // Handle /approve command (operator approval gate)
    if (await _handleApproveCommand(trimmed, text, projectId, channelId, speaker)) return true;

    // Handle /schedule commands
    if (await _handleScheduleCommand(trimmed, text, projectId, channelId, speaker)) return true;

    // Handle /trigger commands
    if (await _handleTriggerCommand(trimmed, text, projectId, channelId, speaker)) return true;

    // Handle /workflow commands
    if (await _handleWorkflowCommand(trimmed, text, projectId, channelId, speaker)) return true;

    // Handle /status command
    if (await _handleStatusCommand(trimmed, text, projectId, channelId, speaker)) return true;

    // Handle /health command
    if (await _handleHealthCommand(trimmed, text, projectId, channelId, speaker, wss)) return true;

    // Handle /steer-stream command
    if (await _handleSteerStreamCommand(trimmed, text, projectId, channelId, speaker)) return true;

    // Handle /thread commands (after vote, but before general message)
    // This requires thread resolution logic which is currently in orchestrator.js
    // For now, only parse and delegate, keep actual thread resolution in orchestrator.js
    // Or, move thread resolution here too?
    const threadCommand = parseThreadCommand(trimmed);
    if (threadCommand) {
      addMessage(projectId, channelId, speaker, text);
      await _handleThreadCommand(threadCommand, projectId, channelId, speaker);
      return true;
    }

    return false;
  }

  return { handleCommand };
}
