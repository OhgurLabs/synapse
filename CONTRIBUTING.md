# Contributing to Synapse

## Development Setup

### Prerequisites

- **Node.js** >= 20 (non-snap; the snap-packaged variant breaks subprocess pipes)
- **Linux** (Synapse uses `/proc`, `pgrep`, and process groups)
- One or more agent CLIs: `claude`, `codex`, `gemini`, or a running Ollama instance

### Install

```bash
git clone https://github.com/ohgurlabs/synapse.git
cd synapse
npm install
```

### Run

```bash
# First run — interactive wizard
node src/cli.js init

# Start the server
node src/cli.js start
# or
node src/orchestrator.js
```

Open `http://localhost:8080`. Login with the password from init — `synapse` by default, or whatever you set during the wizard. The password is printed in the Setup Complete banner and stored in `.env` as `SYNAPSE_PASSWORD`.

### Environment Variables

Create a `.env` file in the project root (or let `synapse init` create one):

```
SYNAPSE_PASSWORD=your-password
SYNAPSE_OPERATOR_NAME=your-name
SYNAPSE_EMBED_ENDPOINT=http://localhost:11434   # optional, for Ollama embeddings
PORT=8080
```

## Running Tests

```bash
npm test                 # full suite via mocha (node test.mjs)
npm test -- campaigns    # filter to files whose path matches "campaigns"
npm run test:ui          # Playwright browser tests
```

The suite is mocha-based and discovers `*.test.js` files under `src/`, `test/`, and
`test/integration/`. A subset of files are mid-migration from the legacy JSON-CAS
persistence layer to the current SQLite-backed storage; new test work should target the
SQLite-backed API directly.

### Test Structure

- `src/**/*.test.js` — unit tests co-located with source
- `test/*.test.js` — integration and workflow tests
- `test/integration/**/*.test.js` — multi-component integration tests
- `test/ui/` — Playwright end-to-end browser tests

### Writing Tests

Tests use [mocha](https://mochajs.org/) with node's built-in `assert/strict`. The
existing tests register top-level `function testFoo()` driver functions and call them
from a `try/catch` at the bottom of the file that calls `process.exit(1)` on failure.
Example using the same style:

```js
import { strict as assert } from 'assert';
import { computeRoutingWeights } from './router.js';

function testRoutingWeightsSingleCandidate() {
  const result = computeRoutingWeights({ agent: { successRate: 0.9, totalDispatches: 10 } });
  assert.equal(result[0].weight, 1.0);
  console.log('  PASS: uniform weight for single candidate');
}

try {
  console.log('Routing weight tests:');
  testRoutingWeightsSingleCandidate();
} catch (e) {
  console.error('Test failed:', e);
  process.exit(1);
}
```

## Project Structure

```
src/
├── orchestrator.js          # Entry point, conversation loop
├── cli.js                   # CLI: init, agent add/list
├── state.js                 # State manager (projects, channels, config)
├── campaigns.js             # Campaign lifecycle (SQLite-backed)
├── tasks.js                 # Task lifecycle (SQLite-backed)
├── router.js                # Agent routing (delta-proportional weights)
├── agents/
│   ├── claude.js            # Claude CLI subprocess agent
│   ├── codex.js             # Codex CLI subprocess agent
│   ├── gemini.js            # Gemini CLI subprocess agent
│   ├── ollama.js            # Ollama HTTP agent
│   ├── glm.js               # GLM HTTP agent
│   └── llama.js             # Llama.cpp HTTP agent
├── orchestrator/
│   ├── api.js               # HTTP + WebSocket server, all REST endpoints
│   ├── conversation.js      # Conversation dispatch, agent coordination
│   ├── lifecycle.js         # Campaign lifecycle engine
│   ├── mcp-server.js        # MCP streamable HTTP server
│   ├── state-db.js          # SQLite schema, row mappers, persistence
│   ├── threading.js         # Thread classification (Jaccard similarity)
│   └── ...                  # trust-score, code-validation, etc.
└── ui/public/
    ├── index.html           # Chat UI
    ├── js/                  # 29 JS modules
    └── css/                 # 30 CSS files
```

## Adding a New Provider

1. Create `src/agents/<provider>.js` implementing the agent interface:

```js
export class MyProviderAgent {
  constructor(config) {
    this.name = config.name;
    this.provider = 'myprovider';
    this.model = config.model;
    this._status = 'idle';
  }

  async send(prompt, workingDir = null, options = {}) {
    // Send prompt to provider, return response text
    // Must return a string
  }

  async stop(reason) {
    // Terminate any running process/connection
  }
}
```

2. Register in `src/orchestrator/agents.js` — add to the provider factory in `createAgent()`.
3. Add a persona file at `.synapse/agents/<name>/persona.md` (optional).
4. Add tests at `src/agents/<provider>.test.js`.
5. Update `src/cli.js` init wizard to detect the CLI if applicable.

## Code Style

- **No comments** unless explicitly requested — code should be self-documenting
- **No emojis** in code or commit messages
- **Single quotes** for JS strings
- **No semicolons** (follow existing patterns in each file)
- **2-space indentation**
- Commits: conventional format — `feat:`, `fix:`, `chore:`, `refactor:`, `docs:`, `test:`

## Pull Request Process

1. All tests must pass (`npm test`)
2. No secrets or credentials in code
3. One logical change per PR
4. Commit messages explain the "why", not the "what"

## Architecture

See [ARCHITECTURE.md](ARCHITECTURE.md) for the full system design.
