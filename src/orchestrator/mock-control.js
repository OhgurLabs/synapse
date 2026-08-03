
import { createWriteStream, appendFileSync, readFileSync, existsSync } from 'fs';
import { join } from 'path';
import { createHash } from 'crypto';

const MOCK_CONTROL_DIR = '.synapse/mock_control';
const LOG_FILE = join(MOCK_CONTROL_DIR, 'intents.jsonl');

let intents = []; // In-memory queue
let nextIntentId = 1;

// Ensure the directory exists
function ensureDirExists(dir) {
  if (!existsSync(dir)) {
    try {
      // Not using recursive option here, expecting .synapse to exist
      // If it doesn't, this will throw, and the error will be caught.
      // This is simpler than importing 'fs/promises' or using sync recursive.
      // In a real app, you might want more robust dir creation.
      createWriteStream(dir).close(); // A simple way to create a dir entry, then close it.
      // fs.mkdirSync(dir, { recursive: true }); is another option if not in .synapse
    } catch (e) {
      // If .synapse doesn't exist, this will error. This assumes .synapse does exist.
      console.error(`Error ensuring mock control directory exists: ${e.message}`);
      // Fallback to in-memory only if directory can't be ensured.
    }
  }
}

// Check if .synapse/mock_control directory exists. If not, create it.
// This is a simplified approach assuming '.synapse' already exists.
// For a robust solution, you might want a recursive mkdir.
// For this context, it's safer to ensure a directory by attempting a write
// which will create the parent directory if it does not exist (for files only).
// This is not standard directory creation. Let's use fs.mkdirSync with recursive.

import { mkdirSync } from 'fs';

function initialize() {
    const fullPath = join(process.cwd(), MOCK_CONTROL_DIR);
    if (!existsSync(fullPath)) {
        mkdirSync(fullPath, { recursive: true });
    }
    // Load existing intents from file
    if (existsSync(LOG_FILE)) {
        const data = readFileSync(LOG_FILE, 'utf8');
        data.split('\n').forEach(line => {
            if (line.trim()) {
                try {
                    const intent = JSON.parse(line);
                    intents.push(intent);
                    if (intent.intentId && intent.intentId >= nextIntentId) {
                        nextIntentId = intent.intentId + 1;
                    }
                } catch (e) {
                    console.error('Error parsing mock intent log line:', e.message);
                }
            }
        });
    }
}

// Call initialize once on module load
initialize();

/**
 * Records an operator intent when actual dispatcher/campaignManager is unavailable.
 * @param {string} action - The action type (e.g., 'reroute', 'replay', 'pause_provider').
 * @param {object} params - Parameters associated with the action.
 * @returns {object} An object containing the intentId and the recorded intent.
 */
export function recordIntent(action, params) {
    const intentId = nextIntentId++;
    const timestamp = new Date().toISOString();
    const intent = { intentId, action, params, timestamp, status: 'pending' };
    intents.push(intent);

    try {
        appendFileSync(LOG_FILE, JSON.stringify(intent) + '\n');
    } catch (e) {
        console.error('Error persisting mock intent to file:', e.message);
        // Continue without persistence if file write fails
    }

    return { intentId, intent };
}

/**
 * Retrieves all pending intents.
 * @returns {Array<object>} A list of pending intents.
 */
export function getPending() {
    return intents.filter(intent => intent.status === 'pending');
}

/**
 * "Drains" or clears pending intents, optionally filtering by intentId.
 * This function also updates the status of the drained intents to 'completed'.
 * @param {Array<number>} [intentIdsToDrain] - Optional array of intent IDs to mark as completed.
 *                                           If not provided, all pending intents are drained.
 * @returns {Array<object>} The intents that were drained.
 */
export function drainPending(intentIdsToDrain = null) {
    const drained = [];
    intents = intents.map(intent => {
        if (intent.status === 'pending' && (!intentIdsToDrain || intentIdsToDrain.includes(intent.intentId))) {
            drained.push({ ...intent, status: 'completed' });
            return { ...intent, status: 'completed' };
        }
        return intent;
    });

    // Re-write the log file for simplicity, or implement more complex line-by-line update
    try {
        writeFileSync(LOG_FILE, intents.map(i => JSON.stringify(i)).join('\n') + '\n');
    } catch (e) {
        console.error('Error updating mock intent log file after draining:', e.message);
    }

    return drained;
}

// Function to calculate a simple hash for content to be recorded
// This might be useful if intents need to be unique or identifiable by content
export function calculateIntentHash(content) {
    return createHash('sha256').update(JSON.stringify(content)).digest('hex');
}
