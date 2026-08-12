// Scheduled tasks — cron expressions, intervals, one-shot delayed execution.
// CAS-protected JSON + append-only JSONL events (same pattern as tasks.js, campaigns.js).
// Zero npm dependencies — cron parsing is hand-rolled (standard 5-field subset).

import { readFileSync, writeFileSync, appendFileSync, mkdirSync, existsSync, renameSync } from 'fs';
import { join } from 'path';
import { randomBytes } from 'crypto';
import { createLogger } from './logger.js';
import config from './config.js';
import { assertSafeProjectId } from './safe-id.js';

const log = createLogger('scheduler');

// The zone every schedule is evaluated and displayed in, unless a schedule
// pins its own. Read at call time (not captured at import) so a settings
// change takes effect without a restart.
export function instanceTimezone() {
  return config.time?.timezone || null;  // null = host zone
}

const MAX_CAS_RETRIES = 3;
const SCHEMA_VERSION = '1';

const SCHEDULE_STATUSES = ['active', 'paused', 'completed', 'failed'];

// ─── Cron Parser (5-field: min hour dom month dow) ────────────────────
// Supports: *, N, N-M, */N, N/N, comma-separated lists
// Does NOT support: @yearly, @monthly, etc. (use explicit cron instead)

function parseCronField(field, min, max) {
  const parts = field.split(',');
  const values = new Set();

  for (const part of parts) {
    if (part === '*') {
      for (let i = min; i <= max; i++) values.add(i);
      continue;
    }

    const stepMatch = part.match(/^(\*|(\d+)-(\d+))\/(\d+)$/);
    if (stepMatch) {
      const step = parseInt(stepMatch[4]);
      let start = min, end = max;
      if (stepMatch[2] !== undefined) {
        start = parseInt(stepMatch[2]);
        end = parseInt(stepMatch[3]);
      }
      for (let i = start; i <= end; i += step) values.add(i);
      continue;
    }

    const rangeMatch = part.match(/^(\d+)-(\d+)$/);
    if (rangeMatch) {
      const a = parseInt(rangeMatch[1]), b = parseInt(rangeMatch[2]);
      for (let i = a; i <= b; i++) values.add(i);
      continue;
    }

    const num = parseInt(part);
    if (!isNaN(num) && num >= min && num <= max) values.add(num);
  }

  return values;
}

export function parseCron(expr) {
  const fields = expr.trim().split(/\s+/);
  if (fields.length !== 5) return null;

  const minutes  = parseCronField(fields[0], 0, 59);
  const hours    = parseCronField(fields[1], 0, 23);
  const doms     = parseCronField(fields[2], 1, 31);
  const months   = parseCronField(fields[3], 1, 12);
  const dows     = parseCronField(fields[4], 0, 6); // 0 = Sunday

  if (minutes.size === 0 || hours.size === 0 || doms.size === 0 || months.size === 0 || dows.size === 0) {
    return null;
  }

  return { minutes, hours, doms, months, dows };
}

// Wall-clock fields for `date` as seen in `tz`. Without a tz this uses the
// SERVER's local zone — which is how cron has always behaved here, and is the
// trap: the enclave runs UTC while the operator reads PDT, so "0 9 * * *"
// silently means 2am to them. Passing a tz makes the intent explicit.
const DOW = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
function wallClockParts(date, tz) {
  if (!tz) {
    return {
      minute: date.getMinutes(), hour: date.getHours(), day: date.getDate(),
      month: date.getMonth() + 1, dow: date.getDay(),
    };
  }
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: tz, hour12: false,
    minute: 'numeric', hour: 'numeric', day: 'numeric', month: 'numeric', weekday: 'short',
  }).formatToParts(date).reduce((acc, p) => (acc[p.type] = p.value, acc), {});
  return {
    // hour can come back as "24" at midnight in some ICU versions
    minute: Number(parts.minute), hour: Number(parts.hour) % 24,
    day: Number(parts.day), month: Number(parts.month), dow: DOW[parts.weekday],
  };
}

export function isValidTimezone(tz) {
  if (!tz) return false;
  try { new Intl.DateTimeFormat('en-US', { timeZone: tz }); return true; }
  catch { return false; }
}

export function cronMatches(parsed, date, tz = null) {
  const w = wallClockParts(date, tz);
  return parsed.minutes.has(w.minute)
    && parsed.hours.has(w.hour)
    && parsed.doms.has(w.day)
    && parsed.months.has(w.month)
    && parsed.dows.has(w.dow);
}

// Calculate the next fire time from `after` date for a parsed cron.
// Brute-force minute-by-minute scan (max 527040 = 366 days in minutes).
export function nextCronFire(parsed, after, tz = null) {
  const candidate = new Date(after);
  candidate.setSeconds(0, 0);
  candidate.setMinutes(candidate.getMinutes() + 1); // at least 1 minute from now

  const limit = 527040; // ~366 days
  for (let i = 0; i < limit; i++) {
    if (cronMatches(parsed, candidate, tz)) return candidate;
    candidate.setMinutes(candidate.getMinutes() + 1);
  }
  // Reachable in one real case: a DST spring-forward can delete the wall-clock
  // hour a daily cron targets, so that day has no match. Scanning a full year
  // means a daily schedule still finds tomorrow; only a cron pinned to a date
  // AND an hour that never exists returns null.
  return null;
}

// ─── Schedule Command Parser ──────────────────────────────────────────

export function parseScheduleCommand(text) {
  const trimmed = text.trim();
  if (trimmed === '/schedule' || trimmed === '/schedule list') {
    return { command: 'list', args: null };
  }

  const match = trimmed.match(/^\/schedule\s+([\w-]+)(?:\s+(.+))?$/s);
  if (!match) return null;

  const command = match[1].toLowerCase();
  const args = match[2]?.trim() || null;
  const valid = ['create', 'list', 'show', 'pause', 'resume', 'delete', 'trigger'];
  if (!valid.includes(command)) return null;

  return { command, args };
}

// ─── ScheduleManager ──────────────────────────────────────────────────

export class ScheduleManager {
  constructor(stateManager) {
    this.stateManager = stateManager;
  }

  _schedulesPath(projectId) {
    assertSafeProjectId(projectId);
    return join(this.stateManager.projectsDir, projectId, 'schedules.json');
  }

  _eventsPath(projectId) {
    assertSafeProjectId(projectId);
    return join(this.stateManager.projectsDir, projectId, 'schedule-events.jsonl');
  }

  // --- Persistence (CAS-protected) ---

  load(projectId) {
    const path = this._schedulesPath(projectId);
    if (!existsSync(path)) {
      return { schemaVersion: SCHEMA_VERSION, version: 0, schedules: [] };
    }
    try {
      return JSON.parse(readFileSync(path, 'utf-8'));
    } catch {
      return { schemaVersion: SCHEMA_VERSION, version: 0, schedules: [] };
    }
  }

  _save(projectId, data) {
    const path = this._schedulesPath(projectId);
    mkdirSync(join(this.stateManager.projectsDir, projectId), { recursive: true });
    const tmp = path + '.tmp.' + process.pid;
    writeFileSync(tmp, JSON.stringify(data, null, 2) + '\n');
    renameSync(tmp, path);
  }

  _withCAS(projectId, mutator) {
    for (let attempt = 0; attempt < MAX_CAS_RETRIES; attempt++) {
      const data = this.load(projectId);
      const oldVersion = data.version;
      const result = mutator(data);
      if (result === null) return null; // mutator signaled abort
      data.version = oldVersion + 1;

      // CAS check
      const current = this.load(projectId);
      if (current.version !== oldVersion) {
        log.warn('CAS conflict, retrying', { projectId, attempt, expected: oldVersion, actual: current.version });
        continue;
      }

      this._save(projectId, data);
      return result;
    }
    throw new Error('CAS conflict after max retries');
  }

  _logEvent(projectId, event) {
    const path = this._eventsPath(projectId);
    mkdirSync(join(this.stateManager.projectsDir, projectId), { recursive: true });
    appendFileSync(path, JSON.stringify({ ...event, timestamp: new Date().toISOString() }) + '\n');
  }

  // --- CRUD ---

  createSchedule(projectId, opts) {
    const { title, description, type, cron, intervalMs, delayMs, action, channel, timezone } = opts;

    if (!title) throw new Error('title required');
    if (!type || !['cron', 'interval', 'once'].includes(type)) {
      throw new Error('type must be "cron", "interval", or "once"');
    }
    if (!action) throw new Error('action required');

    // Validate type-specific fields
    if (type === 'cron') {
      if (!cron) throw new Error('cron expression required for type "cron"');
      const parsed = parseCron(cron);
      if (!parsed) throw new Error(`Invalid cron expression: ${cron}`);
      // Reject a bad zone at creation — otherwise every fire silently falls
      // back to server time and the schedule runs at the wrong hour forever.
      if (timezone && !isValidTimezone(timezone)) {
        throw new Error(`Invalid timezone: ${timezone} (expected an IANA name like America/Los_Angeles)`);
      }
    }
    if (type === 'interval') {
      if (!intervalMs || intervalMs < 60000) throw new Error('intervalMs required (minimum 60000ms = 1 min)');
    }
    if (type === 'once') {
      if (!delayMs || delayMs < 1000) throw new Error('delayMs required (minimum 1000ms)');
    }

    const id = 'sched_' + Date.now() + '_' + randomBytes(4).toString('hex');
    const now = new Date().toISOString();

    const schedule = {
      id,
      title,
      description: description || null,
      type,
      status: 'active',
      channel: channel || 'general',
      // Type-specific config
      cron: type === 'cron' ? cron : null,
      // IANA zone the cron is evaluated in. null = server local time, which is
      // the historical behaviour and stays the default so existing schedules
      // are untouched. Setting it is how an operator in a different zone from
      // the server gets the hour they actually meant.
      timezone: type === 'cron' ? (timezone || instanceTimezone()) : null,
      intervalMs: type === 'interval' ? intervalMs : null,
      delayMs: type === 'once' ? delayMs : null,
      // Action: what to do when triggered
      action, // { type: 'message'|'task'|'prompt'|'workflow', content: '...', workflowId? }
      // Execution state
      nextFireAt: null,
      lastFiredAt: null,
      fireCount: 0,
      createdAt: now,
      updatedAt: now,
    };

    // Calculate initial next fire time
    if (type === 'cron') {
      const parsed = parseCron(cron);
      const next = nextCronFire(parsed, new Date(), schedule.timezone);
      schedule.nextFireAt = next ? next.toISOString() : null;
    } else if (type === 'interval') {
      schedule.nextFireAt = new Date(Date.now() + intervalMs).toISOString();
    } else if (type === 'once') {
      schedule.nextFireAt = new Date(Date.now() + delayMs).toISOString();
    }

    const result = this._withCAS(projectId, (data) => {
      data.schedules.push(schedule);
      return schedule;
    });

    this._logEvent(projectId, { event: 'schedule_created', scheduleId: id, type, title });
    log.info('Schedule created', { projectId, scheduleId: id, type, title, nextFireAt: schedule.nextFireAt });
    return result;
  }

  listSchedules(projectId, status = null) {
    const data = this.load(projectId);
    if (status) return data.schedules.filter(s => s.status === status);
    return data.schedules;
  }

  getSchedule(projectId, scheduleId) {
    const data = this.load(projectId);
    return data.schedules.find(s => s.id === scheduleId) || null;
  }

  updateScheduleStatus(projectId, scheduleId, newStatus, reason = null) {
    if (!SCHEDULE_STATUSES.includes(newStatus)) {
      throw new Error(`Invalid status: ${newStatus}`);
    }

    return this._withCAS(projectId, (data) => {
      const schedule = data.schedules.find(s => s.id === scheduleId);
      if (!schedule) throw new Error(`Schedule "${scheduleId}" not found`);

      const old = schedule.status;
      schedule.status = newStatus;
      schedule.updatedAt = new Date().toISOString();

      this._logEvent(projectId, { event: 'status_changed', scheduleId, from: old, to: newStatus, reason });
      return schedule;
    });
  }

  deleteSchedule(projectId, scheduleId) {
    return this._withCAS(projectId, (data) => {
      const idx = data.schedules.findIndex(s => s.id === scheduleId);
      if (idx === -1) return null;
      const removed = data.schedules.splice(idx, 1)[0];
      this._logEvent(projectId, { event: 'schedule_deleted', scheduleId, title: removed.title });
      return removed;
    });
  }

  // Record that a schedule just fired and compute the next fire time
  recordFire(projectId, scheduleId) {
    return this._withCAS(projectId, (data) => {
      const schedule = data.schedules.find(s => s.id === scheduleId);
      if (!schedule) return null;

      const now = new Date();
      schedule.lastFiredAt = now.toISOString();
      schedule.fireCount++;
      schedule.updatedAt = now.toISOString();

      // Calculate next fire time
      if (schedule.type === 'cron') {
        const parsed = parseCron(schedule.cron);
        const next = parsed ? nextCronFire(parsed, now, schedule.timezone || null) : null;
        schedule.nextFireAt = next ? next.toISOString() : null;
      } else if (schedule.type === 'interval') {
        schedule.nextFireAt = new Date(now.getTime() + schedule.intervalMs).toISOString();
      } else if (schedule.type === 'once') {
        schedule.status = 'completed';
        schedule.nextFireAt = null;
      }

      this._logEvent(projectId, { event: 'schedule_fired', scheduleId, fireCount: schedule.fireCount });
      return schedule;
    });
  }

  // Get all schedules across all projects that are due to fire
  getDueSchedules() {
    const now = Date.now();
    const due = [];
    const projects = this.stateManager.listProjects();

    for (const proj of projects) {
      const data = this.load(proj.id);
      for (const schedule of data.schedules) {
        if (schedule.status !== 'active') continue;
        if (!schedule.nextFireAt) continue;
        if (new Date(schedule.nextFireAt).getTime() <= now) {
          due.push({ projectId: proj.id, schedule });
        }
      }
    }

    return due;
  }
}

// ─── Scheduler Loop ───────────────────────────────────────────────────
// Checks for due schedules on a regular interval and fires them.
// Depends on injected services for message dispatch and task creation.

export function createSchedulerLoop(deps) {
  const { scheduleManager, addMessage, broadcastToChannel, taskManager, events, config } = deps;

  const CHECK_INTERVAL_MS = config.scheduler?.checkIntervalMs || 30000; // 30s default
  let intervalHandle = null;
  let running = false;
  let lastTickAt = null;

  async function tick() {
    lastTickAt = Date.now();
    if (running) return; // single-flight
    running = true;

    try {
      const due = scheduleManager.getDueSchedules();
      if (due.length === 0) { running = false; return; }

      for (const { projectId, schedule } of due) {
        try {
          await fireSchedule(projectId, schedule);
        } catch (err) {
          log.error('Schedule fire error', { projectId, scheduleId: schedule.id, error: err.message });
        }
      }
    } catch (err) {
      log.error('Scheduler tick error', { error: err.message });
    } finally {
      running = false;
    }
  }

  async function fireSchedule(projectId, schedule) {
    log.info('Firing schedule', { projectId, scheduleId: schedule.id, type: schedule.type, title: schedule.title });

    const action = schedule.action;
    const channel = schedule.channel || 'general';

    if (action.type === 'message') {
      // Inject a user-like message into the channel
      addMessage(projectId, channel, 'Scheduler', `[Scheduled] ${action.content}`, 'system', {
        scheduleId: schedule.id,
        scheduledAction: true,
      });
      broadcastToChannel(projectId, channel, {
        type: 'schedule_fired', scheduleId: schedule.id, title: schedule.title,
      });

      events.emit('schedule:fired', { projectId, scheduleId: schedule.id, actionType: 'message' }).catch(() => {});

    } else if (action.type === 'task') {
      // Create a new task
      const task = taskManager.createTask(projectId, channel, {
        title: action.title || schedule.title,
        description: action.description || action.content,
        context: `Created by scheduled trigger: ${schedule.title} (${schedule.id})`,
      });

      addMessage(projectId, channel, 'Scheduler',
        `[Scheduled] Task created: \`${task.id}\` — "${task.title}"`, 'system', {
          scheduleId: schedule.id, taskId: task.id, scheduledAction: true,
        });
      broadcastToChannel(projectId, channel, {
        type: 'schedule_fired', scheduleId: schedule.id, title: schedule.title, taskId: task.id,
      });

      events.emit('schedule:fired', { projectId, scheduleId: schedule.id, actionType: 'task', taskId: task.id }).catch(() => {});

    } else if (action.type === 'prompt') {
      // Send a prompt that triggers agent dispatch (goes through handleUserMessage)
      addMessage(projectId, channel, 'Scheduler', action.content, 'message', {
        scheduleId: schedule.id,
        scheduledAction: true,
      });
      broadcastToChannel(projectId, channel, {
        type: 'schedule_fired', scheduleId: schedule.id, title: schedule.title,
      });

      events.emit('schedule:fired', { projectId, scheduleId: schedule.id, actionType: 'prompt' }).catch(() => {});

    } else if (action.type === 'workflow') {
      // Start a workflow run
      const { workflowManager } = deps;
      if (workflowManager && action.workflowId) {
        const run = workflowManager.startRun(projectId, action.workflowId, {
          type: 'schedule', scheduleId: schedule.id,
        });
        addMessage(projectId, channel, 'Scheduler',
          `[Scheduled] Workflow run started: \`${run.id}\``, 'system', {
            scheduleId: schedule.id, runId: run.id, scheduledAction: true,
          });
        broadcastToChannel(projectId, channel, {
          type: 'schedule_fired', scheduleId: schedule.id, title: schedule.title, runId: run.id,
        });
        events.emit('schedule:fired', { projectId, scheduleId: schedule.id, actionType: 'workflow', runId: run.id }).catch(() => {});
      }
    }

    // Update fire record
    scheduleManager.recordFire(projectId, schedule.id);
  }

  function start() {
    if (intervalHandle) return;
    intervalHandle = setInterval(tick, CHECK_INTERVAL_MS);
    log.info('Scheduler loop started', { intervalSec: CHECK_INTERVAL_MS / 1000 });
    // Run immediately on start
    tick();
  }

  function stop() {
    if (intervalHandle) {
      clearInterval(intervalHandle);
      intervalHandle = null;
      log.info('Scheduler loop stopped');
    }
  }

  return {
    start,
    stop,
    tick,
    fireSchedule,
    get lastTickAt() { return lastTickAt; },
    checkIntervalMs: CHECK_INTERVAL_MS,
  };
}
