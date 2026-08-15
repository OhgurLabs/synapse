// OpenAPI 3.1 specification loader
// Reads spec from configurable path with environment variable support and error logging

import { readFileSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));

const SPEC_FALLBACKS = [
  join(__dirname, '../../docs/openapi.json'),
  join(__dirname, '../../config/openapi.json'),
  join(__dirname, '../../src/docs/openapi.json'),
];

function resolveSpecPath() {
  const envPath = process.env.OPENAPI_SPEC_PATH;
  if (envPath && existsSync(envPath)) {
    console.error(`[openapi-spec] Using OPENAPI_SPEC_PATH from env: ${envPath}`);
    return envPath;
  }
  for (const fallback of SPEC_FALLBACKS) {
    if (existsSync(fallback)) {
      console.error(`[openapi-spec] Found spec at fallback path: ${fallback}`);
      return fallback;
    }
  }
  console.error(`[openapi-spec] No spec file found. Checked: ${SPEC_FALLBACKS.join(', ')}`);
  if (envPath) {
    console.error(`[openapi-spec] OPENAPI_SPEC_PATH set but file does not exist: ${envPath}`);
  }
  return SPEC_FALLBACKS[0];
}

const SPEC_PATH = resolveSpecPath();

/**
 * Load and return the OpenAPI 3.1 specification
 * @returns {object} The parsed OpenAPI spec
 * @throws {Error} SPEC_NOT_FOUND if file does not exist, SPEC_INVALID if JSON is malformed
 */
export function loadOpenApiSpec() {
  if (!existsSync(SPEC_PATH)) {
    const errorMsg = `OpenAPI spec not found at: ${SPEC_PATH}`;
    console.error(`[openapi-spec] ${errorMsg}`);
    const err = new Error(errorMsg);
    err.code = 'SPEC_NOT_FOUND';
    throw err;
  }
  try {
    const content = readFileSync(SPEC_PATH, 'utf-8');
    const spec = JSON.parse(content);
    console.error(`[openapi-spec] Successfully loaded spec from: ${SPEC_PATH}`);
    return spec;
  } catch (err) {
    const errorMsg = `Invalid JSON in OpenAPI spec at: ${SPEC_PATH} - ${err.message}`;
    console.error(`[openapi-spec] ${errorMsg}`);
    const parseErr = new Error(errorMsg);
    parseErr.code = 'SPEC_INVALID';
    parseErr.cause = err;
    throw parseErr;
  }
}

/**
 * Get the OpenAPI spec path (for reference/debugging)
 * @returns {string} The path to the spec file
 */
export function getSpecPath() {
  return SPEC_PATH;
}