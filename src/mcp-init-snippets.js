/**
 * Phase 1B.1 — Operator-printed MCP client snippets for `synapse init --print-mcp`.
 *
 * ZERO Bridge A: this module ONLY formats copy-paste JSON/TOML snippets to stdout.
 * It NEVER reads, creates, or mutates `~/.claude`, `~/.codex`, `~/.config/opencode`,
 * or `~/.omp` configuration files.
 */

export function formatMcpInitSnippets({
  serverUrl = 'http://127.0.0.1:8080',
  tokenPlaceholder = '<YOUR_AGENT_TOKEN>',
} = {}) {
  const base = String(serverUrl || 'http://127.0.0.1:8080').replace(/\/+$/, '');
  const mcpUrl = `${base}/mcp`;
  const authHeader = `Bearer ${tokenPlaceholder}`;

  const claudeSnippet = {
    mcpServers: {
      synapse: {
        type: 'http',
        url: mcpUrl,
        headers: {
          Authorization: authHeader,
        },
      },
    },
  };

  // P2 #4: Valid TOML for ~/.codex/config.toml with proper TOML basic-string escaping
  const codexToml = [
    '[mcp_servers.synapse]',
    `url = ${JSON.stringify(mcpUrl)}`,
    `http_headers = { Authorization = ${JSON.stringify(authHeader)} }`,
  ].join('\n');

  const opencodeSnippet = {
    mcp: {
      synapse: {
        type: 'remote',
        url: mcpUrl,
        headers: {
          Authorization: authHeader,
        },
      },
    },
  };

  const ompSnippet = {
    mcpServers: {
      synapse: {
        transport: 'http',
        url: mcpUrl,
        headers: {
          Authorization: authHeader,
        },
      },
    },
  };

  const text = [
    '=== Synapse Inbound MCP Connection Snippets (Operator Copy-Paste — Zero Bridge A) ===',
    `Endpoint: ${mcpUrl}`,
    '',
    '--- Claude Code (.mcp.json / ~/.claude.json) ---',
    JSON.stringify(claudeSnippet, null, 2),
    '',
    '--- Codex CLI (~/.codex/config.toml) ---',
    codexToml,
    '',
    '--- opencode (opencode.json) ---',
    JSON.stringify(opencodeSnippet, null, 2),
    '',
    '--- oh-my-pi / omp (~/.omp/agent/mcp.json) ---',
    JSON.stringify(ompSnippet, null, 2),
    '',
    'Note: Synapse never modifies external harness config files automatically.',
  ].join('\n');

  return {
    mcpUrl,
    snippets: {
      claude: claudeSnippet,
      codexToml,
      opencode: opencodeSnippet,
      omp: ompSnippet,
    },
    text,
  };
}
