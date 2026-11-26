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

// Wall-clock fields for `date` in `tz`. With no timezone specified, use
// the server's local zone. Pass a timezone for schedules tied to local time.
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
      for (const { projectId, schedule } of due) {
        try {
          await fireSchedule(projectId, schedule);
        } catch (err) {
          log.error('Schedule fire error', { projectId, scheduleId: schedule.id, error: err.message });
        }
      }

      // Phase 2A (Sol P1 #12): Drain cancel-prior targets, claim occurrences, and dispatch FIFO queued runs
      if (deps.loopStore) {
        const armedLoops = deps.loopStore.listArmedLoopSchedules();
        for (const armed of armedLoops) {
          try {
            await tickArmedLoopSchedule({
              loopStore: deps.loopStore,
              loopEngine: deps.loopEngine || null,
              loopId: armed.loopId,
              nowDate: new Date(),
              awaitExecution: false,
            });
          } catch (loopSchedErr) {
            log.error('Loop schedule tick error', { loopId: armed.loopId, error: loopSchedErr.message });
          }
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


// ─── Phase 2A: Hardened Loop Schedule Occurrence Admission & Strict IANA DST ───

/**
 * Convert a Loop schedule cadence object into a standard 5-field cron expression.
 * Supports:
 *   - { preset: 'hourly', minute }
 *   - { preset: 'daily-at', time: 'HH:MM' }
 *   - { preset: 'weekdays-at', time: 'HH:MM' }
 *   - { preset: 'weekly-at', day: 0..6, time: 'HH:MM' }
 *   - { cron: 'm h dom mon dow' }
 */
export function cadenceToCron(cadence) {
  if (!cadence || typeof cadence !== 'object') {
    throw new Error('Loop schedule cadence is required');
  }
  if (typeof cadence.cron === 'string' && cadence.cron.trim()) {
    return cadence.cron.trim();
  }
  const parseHHMM = (t) => {
    const m = /^(\d{2}):(\d{2})$/.exec(String(t || ''));
    if (!m) throw new Error(`Invalid schedule time "${t}" (expected HH:MM)`);
    const hh = Number(m[1]);
    const mm = Number(m[2]);
    if (hh < 0 || hh > 23 || mm < 0 || mm > 59) throw new Error(`Out-of-range time "${t}"`);
    return { hh, mm };
  };
  if (cadence.preset === 'hourly') {
    const min = Number(cadence.minute ?? 0);
    if (!Number.isInteger(min) || min < 0 || min > 59) throw new Error(`Invalid hourly minute: ${cadence.minute}`);
    return `${min} * * * *`;
  }
  if (cadence.preset === 'daily-at') {
    const { hh, mm } = parseHHMM(cadence.time);
    return `${mm} ${hh} * * *`;
  }
  if (cadence.preset === 'weekdays-at') {
    const { hh, mm } = parseHHMM(cadence.time);
    return `${mm} ${hh} * * 1-5`;
  }
  if (cadence.preset === 'weekly-at') {
    const day = Number(cadence.day);
    if (!Number.isInteger(day) || day < 0 || day > 6) throw new Error(`Invalid weekly day: ${cadence.day}`);
    const { hh, mm } = parseHHMM(cadence.time);
    return `${mm} ${hh} * * ${day}`;
  }
  throw new Error(`Unsupported Loop schedule cadence preset: ${cadence.preset}`);
}

/**
 * Strict IANA DST fold check:
 * Returns true iff `date` is the EARLIEST UTC instant producing its local wall-clock
 * (year, month, day, hour, minute) in `tz`.
 *
 * - Spring-forward nonexistent local minute: no UTC instant ever maps to it (0 occurrences).
 * - Fall-back repeated local minute (e.g. America/New_York 2026-11-01 01:30):
 *   05:30Z -> local 01:30 EDT (first fold -> true)
 *   06:30Z -> local 01:30 EST (second fold; 05:30Z already had identical local wall-clock -> false!).
 */
const _wallClockFmtCache = new Map();
function wallClockFullParts(date, tz) {
  if (!tz) {
    return {
      year: date.getFullYear(),
      month: date.getMonth() + 1,
      day: date.getDate(),
      hour: date.getHours(),
      minute: date.getMinutes(),
    };
  }
  let fmt = _wallClockFmtCache.get(tz);
  if (!fmt) {
    fmt = new Intl.DateTimeFormat('en-US', {
      timeZone: tz,
      year: 'numeric',
      month: 'numeric',
      day: 'numeric',
      hour: 'numeric',
      minute: 'numeric',
      hourCycle: 'h23',
    });
    _wallClockFmtCache.set(tz, fmt);
  }
  const parts = fmt.formatToParts(date);
  const get = (t) => Number(parts.find(p => p.type === t)?.value);
  return {
    year: get('year'),
    month: get('month'),
    day: get('day'),
    hour: get('hour') % 24,
    minute: get('minute'),
  };
}

function tzUtcOffsetMinutes(date, tz) {
  const parts = wallClockFullParts(date, tz);
  const asUtc = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, 0, 0);
  const floored = Math.floor(date.getTime() / 60_000) * 60_000;
  return Math.round((asUtc - floored) / 60_000);
}

/**
 * Generalized strict IANA DST fold check (P2 #7):
 * Dynamically computes the local UTC offset shift across the preceding 24h AND probes
 * standard offsets so ANY rollback length (15m, 20m, 30m, 45m, 60m, 90m, 120m, or custom)
 * emits ONLY the earlier UTC instant.
 */
export function isEarlierFoldOccurrence(date, tz) {
  if (!tz) return true;
  const curr = wallClockFullParts(date, tz);
  const probes = new Set([15, 20, 30, 45, 60, 90, 120]);
  const offNow = tzUtcOffsetMinutes(date, tz);
  for (const lookbackH of [3, 12, 24]) {
    const offPrev = tzUtcOffsetMinutes(new Date(date.getTime() - lookbackH * 3600_000), tz);
    const delta = offPrev - offNow;
    if (delta > 0 && delta <= 720) probes.add(delta);
  }
  for (const offsetMin of probes) {
    const earlier = new Date(date.getTime() - offsetMin * 60_000);
    const prev = wallClockFullParts(earlier, tz);
    if (
      prev.year === curr.year
      && prev.month === curr.month
      && prev.day === curr.day
      && prev.hour === curr.hour
      && prev.minute === curr.minute
    ) {
      return false;
    }
  }
  return true;
}

export function cronMatchesStrictDst(parsed, date, tz = null) {
  if (!cronMatches(parsed, date, tz)) return false;
  return isEarlierFoldOccurrence(date, tz);
}

export function nextLoopFires(cadence, afterDate, tz = null, count = 1) {
  const expr = cadenceToCron(cadence);
  const parsed = parseCron(expr);
  if (!parsed) throw new Error(`Invalid Loop cron expression: "${expr}"`);
  if (tz && !isValidTimezone(tz)) throw new Error(`Invalid IANA timezone: "${tz}"`);

  const out = [];
  const candidate = new Date(afterDate);
  candidate.setUTCSeconds(0, 0);
  candidate.setUTCMinutes(candidate.getUTCMinutes() + 1);

  // Scan up to 5 years for sparse expressions (e.g. Feb 29 leap year)
  const limit = 5 * 366 * 1440;
  for (let i = 0; i < limit && out.length < count; i++) {
    if (cronMatchesStrictDst(parsed, candidate, tz)) {
      out.push(new Date(candidate.getTime()).toISOString());
    }
    candidate.setUTCMinutes(candidate.getUTCMinutes() + 1);
  }
  return out;
}

export function floorToUtcMinute(date) {
  const d = new Date(date);
  d.setUTCSeconds(0, 0);
  return d;
}

export function claimLoopOccurrence({
  loopStore,
  loopId,
  nowDate = new Date(),
  createRunFn = null,
  maxScanMinutes = 60 * 24 * 31,
} = {}) {
  if (!loopStore || !loopId) throw new Error('claimLoopOccurrence requires loopStore and loopId');

  const nowFloor = floorToUtcMinute(nowDate);
  const nowFloorMs = nowFloor.getTime();
  const nowIso = nowFloor.toISOString();

  const tx = loopStore.db.transaction(() => {
    const armed = loopStore.getLoopSchedule(loopId);
    if (!armed || !armed.enabled) {
      return { claimed: false, reason: 'not_armed', occurrences: [] };
    }

    const published = loopStore.getLoopVersion(loopId, armed.loopVersion);
    const schedDef = published?.manifest?.schedule;
    if (!published || !schedDef) {
      return { claimed: false, reason: 'no_schedule_in_manifest', occurrences: [] };
    }

    const tz = schedDef.timezone || instanceTimezone() || 'UTC';
    if (!isValidTimezone(tz)) {
      throw new Error(`Invalid persisted timezone "${tz}" on loop "${loopId}"`);
    }
    const cronExpr = cadenceToCron(schedDef.cadence);
    const parsed = parseCron(cronExpr);
    if (!parsed) throw new Error(`Invalid cron expression "${cronExpr}" on loop "${loopId}"`);

    const cursorMs = floorToUtcMinute(new Date(armed.cursorUtc)).getTime();
    // P2 #6: Ceil sub-minute effectiveFrom to the NEXT whole UTC minute so a slot BEFORE effectiveFrom never fires!
    const rawEffMs = new Date(armed.effectiveFrom || armed.cursorUtc).getTime();
    const effectiveFromMs = Math.ceil(rawEffMs / 60_000) * 60_000;
    if (nowFloorMs <= cursorMs || nowFloorMs < effectiveFromMs) {
      return { claimed: false, reason: 'already_up_to_date', occurrences: [], cursorUtc: armed.cursorUtc };
    }

    const lowerBoundMs = Math.max(cursorMs + 60_000, effectiveFromMs);
    const scanWindowStartMs = nowFloorMs - maxScanMinutes * 60_000;
    const effectiveStartMs = Math.max(lowerBoundMs, scanWindowStartMs);

    // P2 #6: Preserve truncated pre-window outage history counting matching cron slots (not raw elapsed minutes!)
    if (effectiveStartMs > lowerBoundMs) {
      const truncatedEndMs = effectiveStartMs - 60_000;
      const truncSpanMinutes = Math.floor((truncatedEndMs - lowerBoundMs) / 60_000) + 1;
      let truncatedMatches = 0;
      if (truncSpanMinutes <= 527_040) {
        for (let t = lowerBoundMs; t <= truncatedEndMs; t += 60_000) {
          if (cronMatchesStrictDst(parsed, new Date(t), tz)) truncatedMatches++;
        }
      } else {
        // Estimate via 7-day representative sample * weeks for multi-year outages
        const sampleLen = 7 * 1440;
        let sampleMatches = 0;
        for (let i = 0; i < sampleLen; i++) {
          if (cronMatchesStrictDst(parsed, new Date(lowerBoundMs + i * 60_000), tz)) sampleMatches++;
        }
        truncatedMatches = Math.round((sampleMatches / sampleLen) * truncSpanMinutes);
      }
      if (truncatedMatches > 0) {
        loopStore.db.prepare(`
          INSERT INTO schedule_skipped_ranges (schedule_id, from_utc, to_utc, skipped_count, created_at)
          VALUES (?, ?, ?, ?, ?)
        `).run(
          armed.scheduleId,
          new Date(lowerBoundMs).toISOString(),
          new Date(truncatedEndMs).toISOString(),
          truncatedMatches,
          new Date().toISOString()
        );
      }
    }

    const matchingSlots = [];
    for (let t = effectiveStartMs; t <= nowFloorMs; t += 60_000) {
      const d = new Date(t);
      if (cronMatchesStrictDst(parsed, d, tz)) {
        matchingSlots.push(d.toISOString());
      }
    }

    const advanceCursor = () => {
      loopStore.db.prepare(
        'UPDATE loop_schedules SET cursor_utc = ?, updated_at = ? WHERE schedule_id = ?'
      ).run(nowIso, new Date().toISOString(), armed.scheduleId);
    };

    if (matchingSlots.length === 0) {
      advanceCursor();
      return { claimed: false, reason: 'no_due_slots', occurrences: [], cursorUtc: nowIso };
    }

    const onTimeSlot = matchingSlots[matchingSlots.length - 1] === nowIso ? nowIso : null;
    const missedSlots = onTimeSlot ? matchingSlots.slice(0, -1) : matchingSlots;
    const missedPolicy = schedDef.missedRun || 'skip';
    const overlapPolicy = schedDef.overlap || 'skip';

    let targetSlot = null;
    const coalescedSkipped = [];

    if (onTimeSlot) {
      targetSlot = onTimeSlot;
      if (missedSlots.length > 0) coalescedSkipped.push(...missedSlots);
    } else if (missedSlots.length > 0) {
      if (missedPolicy === 'catch-up-one') {
        targetSlot = missedSlots[missedSlots.length - 1];
        if (missedSlots.length > 1) coalescedSkipped.push(...missedSlots.slice(0, -1));
      } else {
        coalescedSkipped.push(...missedSlots);
      }
    }

    if (coalescedSkipped.length > 0) {
      loopStore.db.prepare(`
        INSERT INTO schedule_skipped_ranges (schedule_id, from_utc, to_utc, skipped_count, created_at)
        VALUES (?, ?, ?, ?, ?)
      `).run(
        armed.scheduleId,
        coalescedSkipped[0],
        coalescedSkipped[coalescedSkipped.length - 1],
        coalescedSkipped.length,
        new Date().toISOString()
      );
    }

    if (!targetSlot) {
      advanceCursor();
      return {
        claimed: false,
        reason: 'missed_slots_skipped',
        skippedCount: coalescedSkipped.length,
        occurrences: [],
        cursorUtc: nowIso,
      };
    }

    const occurrenceKey = `${armed.scheduleId}:${targetSlot}`;
    const existingOcc = loopStore.db.prepare(
      'SELECT * FROM schedule_occurrences WHERE schedule_id = ? AND scheduled_slot_iso = ?'
    ).get(armed.scheduleId, targetSlot);
    if (existingOcc) {
      advanceCursor();
      return {
        claimed: false,
        deduplicated: true,
        reason: 'already_claimed',
        occurrence: existingOcc,
        cursorUtc: nowIso,
      };
    }

    const activeRuns = loopStore.listActiveRuns(loopId);
    const runningRuns = activeRuns.filter(r => r.phase === 'running' || r.phase === 'cancelling' || r.phase === 'awaiting_approval' || r.phase === 'finalizing');

    // P1 #12: Check unresolved external effects across ALL phases (including terminal flagged runs!)
    const unresolvedEffect = loopStore.findUnresolvedEffectForLoop(loopId);

    let disposition = 'admitted';
    let reason = null;
    let runId = null;
    let cancelTargetRunIds = [];
    let blockedByUnresolvedEffect = false;

    if (unresolvedEffect && overlapPolicy === 'cancel-prior') {
      disposition = 'skipped_overlap';
      reason = `UNRESOLVED_EFFECT_BLOCKED:${unresolvedEffect.runId}:${unresolvedEffect.sideEffectKey}`;
      blockedByUnresolvedEffect = true;
    } else if (runningRuns.length > 0 || activeRuns.length > 0) {
      if (overlapPolicy === 'skip') {
        disposition = 'skipped_overlap';
        reason = `Active run exists (${activeRuns[0].runId})`;
      } else if (overlapPolicy === 'queue') {
        disposition = 'queued';
        reason = `Queued behind active run (${activeRuns[0].runId})`;
      } else if (overlapPolicy === 'cancel-prior') {
        cancelTargetRunIds = activeRuns.map(r => r.runId);
        for (const prevRun of activeRuns) {
          if (prevRun.phase === 'queued') {
            loopStore.updateRunAtomic(prevRun.runId, (r) => {
              r.phase = 'terminal';
              r.verdict = 'cancelled';
              r.reasonCode = 'SUPERSEDED';
              r.provenance.endedAt = new Date().toISOString();
              return r;
            });
            if (prevRun.provenance?.trigger?.occurrenceKey) {
              loopStore.db.prepare(
                `UPDATE schedule_occurrences SET disposition = 'superseded', reason = ? WHERE occurrence_key = ?`
              ).run(`Superseded by ${occurrenceKey}`, prevRun.provenance.trigger.occurrenceKey);
            }
          } else if (prevRun.phase !== 'terminal') {
            loopStore.updateRunAtomic(prevRun.runId, (r) => {
              r.phase = 'cancelling';
              return r;
            });
          }
        }
        disposition = runningRuns.length > 0 ? 'queued' : 'admitted';
        reason = runningRuns.length > 0 ? `Waiting for quiescence of ${runningRuns[0].runId}` : null;
      }
    }

    if ((disposition === 'admitted' || disposition === 'queued') && typeof createRunFn === 'function') {
      const admitted = createRunFn({
        loopId,
        loopVersion: armed.loopVersion,
        params: schedDef.params || {},
        trigger: {
          kind: 'schedule',
          occurrenceKey,
          scheduledSlotIso: targetSlot,
        },
        allowQueuedOverlap: true,
      });
      runId = admitted?.run?.runId || admitted?.runId || null;
    }

    loopStore.db.prepare(`
      INSERT INTO schedule_occurrences (schedule_id, scheduled_slot_iso, occurrence_key, disposition, run_id, loop_version, reason, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      armed.scheduleId,
      targetSlot,
      occurrenceKey,
      disposition,
      runId,
      armed.loopVersion,
      reason,
      new Date().toISOString()
    );

    advanceCursor();

    return {
      claimed: disposition === 'admitted' || disposition === 'queued',
      disposition,
      occurrenceKey,
      scheduledSlotIso: targetSlot,
      loopVersion: armed.loopVersion,
      runId,
      reason,
      blockedByUnresolvedEffect,
      cancelTargetRunIds,
      skippedCount: coalescedSkipped.length,
      cursorUtc: nowIso,
    };
  });

  return tx();
}

/**
 * P1 #12: Complete live scheduler tick driver for a Loop:
 *  1. Claims any due slot via claimLoopOccurrence
 *  2. Drives cancellation to quiescence on any `cancelling` runs (including awaiting_approval/orphaned!)
 *  3. Drains the oldest FIFO `queued` run once no active non-queued run or unresolved effect blocks it!
 */
export async function tickArmedLoopSchedule({
  loopStore,
  loopEngine = null,
  loopId,
  nowDate = new Date(),
  executeOptions = {},
  awaitExecution = false,
} = {}) {
  const claim = claimLoopOccurrence({
    loopStore,
    loopId,
    nowDate,
    createRunFn: loopEngine ? (a) => loopEngine.startRun(a) : null,
  });

  // Complete cancellation quiescence for any cancelling runs (newly flagged or stranded across restart)
  const cancelling = loopStore.listCancellingRuns(loopId);
  const cancelledIds = [];
  if (loopEngine) {
    for (const cRun of cancelling) {
      await loopEngine.cancelRun(cRun.runId);
      cancelledIds.push(cRun.runId);
    }
  }

  // Drain FIFO queued runs once slot is quiescent and no unresolved effect blocks execution.
  // P1 #12: By default (awaitExecution=false) dispatch asynchronously so a slow Loop run NEVER blocks
  // other armed loops or a subsequent cancel-prior tick!
  let dispatchedRunId = null;
  let executionPromise = null;
  if (loopEngine && !loopStore.findUnresolvedEffectForLoop(loopId)) {
    const active = loopStore.listActiveRuns(loopId);
    const busy = active.filter(r => r.phase !== 'queued');
    if (busy.length === 0) {
      const queued = loopStore.listQueuedRuns(loopId);
      if (queued.length > 0) {
        dispatchedRunId = queued[0].runId;
        executionPromise = Promise.resolve()
          .then(() => loopEngine.executeRun(dispatchedRunId, executeOptions))
          .catch(err => {
            log.error('Scheduled Loop execution error', { loopId, runId: dispatchedRunId, error: err.message });
          });
        if (awaitExecution) {
          await executionPromise;
        }
      }
    }
  }

  return { claim, cancelledIds, dispatchedRunId, executionPromise };
}
