/**
 * Utility for time-based constraints.
 */

/**
 * Checks if a given time is within a time window constraint.
 * 
 * @param {object} window - The time window object.
 * @param {string|Date} [now] - The current time to check (defaults to now).
 * @returns {boolean} True if within window, false otherwise.
 */
export function isWithinTimeWindow(window, now = new Date()) {
  if (!window) return true;
  
  const date = typeof now === 'string' ? new Date(now) : now;
  
  if (isNaN(date.getTime())) {
    throw new Error(`Invalid date: ${now}`);
  }

  // Absolute windows
  if (window.after || window.before) {
    if (window.after) {
      const afterDate = new Date(window.after);
      if (date < afterDate) return false;
    }
    if (window.before) {
      const beforeDate = new Date(window.before);
      if (date > beforeDate) return false;
    }
    return true;
  }

  // Recurring windows
  const dayNames = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
  const currentDay = dayNames[date.getDay()];
  const currentHour = date.getHours();

  if (window.days) {
    const allowedDays = window.days.map(d => d.toLowerCase());
    if (!allowedDays.includes(currentDay)) {
      return false;
    }
  }

  const start = window.startHour;
  const end = window.endHour;

  if (start !== undefined && end !== undefined) {
    if (start <= end) {
      // Standard range e.g. 9 to 17 (9:00 to 16:59:59)
      if (currentHour < start || currentHour >= end) {
        return false;
      }
    } else {
      // Crosses midnight e.g. 22 to 6 (22:00 to 05:59:59)
      // Within if hour >= 22 OR hour < 6
      // Outside if hour < 22 AND hour >= 6
      if (currentHour < start && currentHour >= end) {
        return false;
      }
    }
  } else if (start !== undefined) {
    if (currentHour < start) return false;
  } else if (end !== undefined) {
    if (currentHour >= end) return false;
  }

  return true;
}
