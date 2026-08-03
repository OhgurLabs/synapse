/**
 * @module test-harness.js
 * @description Test infrastructure for UI components
 *
 * Provides:
 * - JSDOM-based DOM setup (with fallback to minimal mock)
 * - Module loader for window.Synapse* namespaces
 * - WebSocket mock with message queue
 * - authFetch stub for API calls
 *
 * Usage:
 *   import { setupTestEnv, teardownTestEnv, mockWebSocket, mockAuthFetch } from './test-harness.js';
 *
 *   const env = setupTestEnv();
 *   // ... run tests ...
 *   teardownTestEnv(env);
 */

import { readFileSync } from 'fs';
import { join } from 'path';
import { fileURLToPath } from 'url';
import { dirname } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// --- JSDOM Setup (with fallback) ---

let JSDOM;
try {
  // Try to import jsdom if available (optional dependency)
  const jsdomModule = await import('jsdom');
  JSDOM = jsdomModule.JSDOM;
} catch {
  // JSDOM not available - use minimal mock
  JSDOM = null;
}

/**
 * Creates a minimal DOM environment
 * @param {string} html - HTML content to load
 * @returns {object} { window, document, cleanup }
 */
function createMinimalDOM(html = '<!DOCTYPE html><html><head></head><body></body></html>') {
  if (JSDOM) {
    // Use real JSDOM
    const dom = new JSDOM(html, {
      url: 'http://localhost:3600',
      runScripts: 'outside-only',
      resources: 'usable',
    });
    return {
      window: dom.window,
      document: dom.window.document,
      cleanup: () => {
        dom.window.close();
      },
    };
  }

  // Fallback: minimal mock DOM
  const mockDocument = {
    querySelector: () => null,
    querySelectorAll: () => [],
    getElementById: () => null,
    createElement: (tag) => ({
      tagName: tag.toUpperCase(),
      setAttribute: () => {},
      getAttribute: () => null,
      appendChild: () => {},
      removeChild: () => {},
      addEventListener: () => {},
      removeEventListener: () => {},
      classList: {
        add: () => {},
        remove: () => {},
        toggle: () => {},
        contains: () => false,
      },
      dataset: {},
      style: {},
      innerHTML: '',
      textContent: '',
    }),
    body: {
      appendChild: () => {},
      removeChild: () => {},
    },
    addEventListener: () => {},
    removeEventListener: () => {},
  };

  const mockWindow = {
    document: mockDocument,
    location: {
      protocol: 'http:',
      host: 'localhost:3600',
      href: 'http://localhost:3600/',
    },
    WebSocket: class MockWebSocketConstructor {},
    addEventListener: () => {},
    removeEventListener: () => {},
  };

  return {
    window: mockWindow,
    document: mockDocument,
    cleanup: () => {},
  };
}

/**
 * Mock WebSocket implementation for testing
 */
class MockWebSocket {
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSING = 2;
  static CLOSED = 3;

  constructor(url) {
    this.url = url;
    this.readyState = MockWebSocket.CONNECTING;
    this.onopen = null;
    this.onmessage = null;
    this.onclose = null;
    this.onerror = null;
    this._messageQueue = [];
    this._isClosed = false;

    // Simulate async connection
    setTimeout(() => {
      if (!this._isClosed) {
        this.readyState = MockWebSocket.OPEN;
        if (this.onopen) this.onopen({ type: 'open' });
      }
    }, 0);
  }

  send(data) {
    if (this.readyState !== MockWebSocket.OPEN) {
      throw new Error('WebSocket is not open');
    }
    this._messageQueue.push(data);
  }

  close(code = 1000, reason = '') {
    if (this._isClosed) return;
    this._isClosed = true;
    this.readyState = MockWebSocket.CLOSED;
    if (this.onclose) {
      this.onclose({ type: 'close', code, reason });
    }
  }

  // Test helpers
  _simulateMessage(data) {
    if (this.readyState === MockWebSocket.OPEN && this.onmessage) {
      this.onmessage({ type: 'message', data: JSON.stringify(data) });
    }
  }

  _simulateError(error) {
    if (this.onerror) {
      this.onerror({ type: 'error', error });
    }
  }

  _getSentMessages() {
    return this._messageQueue.map(msg => {
      try {
        return JSON.parse(msg);
      } catch {
        return msg;
      }
    });
  }

  _clearMessages() {
    this._messageQueue = [];
  }
}

/**
 * Mock authFetch implementation for testing
 */
class MockAuthFetch {
  constructor() {
    this._responses = new Map();
    this._requests = [];
  }

  /**
   * Register a mock response for a URL pattern
   * @param {string|RegExp} urlPattern - URL or pattern to match
   * @param {object|Function} response - Response data or function returning response
   */
  mockResponse(urlPattern, response) {
    this._responses.set(urlPattern, response);
  }

  /**
   * Create the authFetch function
   * @returns {Function} authFetch(url, opts)
   */
  createFetch() {
    return async (url, opts = {}) => {
      this._requests.push({ url, opts });

      // Find matching mock response
      for (const [pattern, response] of this._responses) {
        const matches = typeof pattern === 'string'
          ? url === pattern || url.includes(pattern)
          : pattern.test(url);

        if (matches) {
          const responseData = typeof response === 'function'
            ? response(url, opts)
            : response;

          return {
            ok: responseData.ok !== false,
            status: responseData.status || 200,
            statusText: responseData.statusText || 'OK',
            json: async () => responseData.data || responseData,
            text: async () => JSON.stringify(responseData.data || responseData),
          };
        }
      }

      // Default 404 response
      return {
        ok: false,
        status: 404,
        statusText: 'Not Found',
        json: async () => ({ error: 'Not found' }),
        text: async () => JSON.stringify({ error: 'Not found' }),
      };
    };
  }

  /**
   * Get all requests made
   * @returns {Array} List of { url, opts } objects
   */
  getRequests() {
    return [...this._requests];
  }

  /**
   * Clear request history
   */
  clearRequests() {
    this._requests = [];
  }

  /**
   * Reset all mocks
   */
  reset() {
    this._responses.clear();
    this._requests = [];
  }
}

/**
 * Load a UI module into the test environment
 * @param {object} window - Window object to attach to
 * @param {string} modulePath - Path to module file (relative to src/ui/public/js/)
 * @returns {Promise<void>}
 */
async function loadUIModule(window, modulePath) {
  const fullPath = join(__dirname, 'public', 'js', modulePath);
  const code = readFileSync(fullPath, 'utf-8');

  // Execute module code in context of window
  const wrappedCode = `
    (function(window, document, location) {
      ${code}
    })(window, window.document, window.location);
  `;

  // eslint-disable-next-line no-eval
  eval(wrappedCode);
}

/**
 * Setup complete test environment
 * @param {object} options - Configuration options
 * @param {string} options.html - HTML to load
 * @param {Array<string>} options.modules - UI modules to load (e.g., ['websocket.js', 'health.js'])
 * @returns {object} Test environment { window, document, mockWS, mockFetch, cleanup }
 */
export function setupTestEnv(options = {}) {
  const { html, modules = [] } = options;

  // Create DOM
  const { window, document, cleanup: domCleanup } = createMinimalDOM(html);

  // Create mocks
  const mockWSConstructor = MockWebSocket;
  const mockFetchInstance = new MockAuthFetch();
  const mockFetch = mockFetchInstance.createFetch();

  // Attach to window
  window.WebSocket = mockWSConstructor;

  // Create mock meta tag for auth token
  const meta = window.document.createElement('meta');
  meta.setAttribute('name', 'auth-token');
  meta.setAttribute('content', 'test-token-12345');
  if (window.document.head) {
    window.document.head.appendChild(meta);
  }

  // Initialize Synapse namespaces
  window.SynapseWebSocket = null;
  window.SynapseHealth = null;
  window.SynapseAgents = null;
  window.SynapseMessages = null;
  window.SynapseTasks = null;
  window.SynapseCampaigns = null;
  window.SynapseBudget = null;
  window.SynapseInput = null;
  window.SynapseOnboarding = null;
  window.SynapseModals = null;
  window.SynapseModalBase = null;
  window.SynapseTheme = null;
  window.SynapseSidebar = null;

  // Load modules if requested
  // Note: This is a basic implementation; full module loading would require
  // proper IIFE evaluation which is complex in a test environment.
  // For now, tests should mock the window.Synapse* namespaces directly.

  const cleanup = () => {
    domCleanup();
    mockFetchInstance.reset();
  };

  return {
    window,
    document,
    mockWS: mockWSConstructor,
    mockFetch: mockFetchInstance,
    authFetch: mockFetch,
    cleanup,
  };
}

/**
 * Teardown test environment
 * @param {object} env - Environment returned by setupTestEnv
 */
export function teardownTestEnv(env) {
  if (env && env.cleanup) {
    env.cleanup();
  }
}

/**
 * Create a mock WebSocket instance
 * @returns {MockWebSocket}
 */
export function createMockWebSocket() {
  return new MockWebSocket('ws://localhost:3600/ws?token=test');
}

/**
 * Create a mock authFetch instance
 * @returns {MockAuthFetch}
 */
export function createMockAuthFetch() {
  return new MockAuthFetch();
}

// Export classes for advanced usage
export { MockWebSocket, MockAuthFetch };
