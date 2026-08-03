#!/usr/bin/env node
import { createInterface } from 'readline';
import http from 'http';
import https from 'https';

const SEARXNG_URL = process.env.SEARXNG_URL || 'http://localhost:8888';
const PROTOCOL_VERSION = '2024-11-05';
const SERVER_INFO = { name: 'searxng-mcp', version: '1.0.0' };
const CAPABILITIES = { tools: {} };

const TOOLS = [
  {
    name: 'web_search',
    description: 'Search the web using SearXNG. Returns a list of results with titles, URLs, and content snippets. Use this tool when you need to find information on the internet.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Search query' },
        categories: {
          type: 'string',
          description: 'Comma-separated categories: general, news, images, videos, music, files, science, it, social media',
        },
        max_results: {
          type: 'number',
          description: 'Maximum number of results to return (default: 10, max: 30)',
        },
      },
      required: ['query'],
    },
  },
  {
    name: 'web_fetch',
    description: 'Fetch and extract text content from a URL. Returns the page content as plain text. Use this to read the full content of a web page found via web_search.',
    inputSchema: {
      type: 'object',
      properties: {
        url: { type: 'string', description: 'URL to fetch' },
        max_length: {
          type: 'number',
          description: 'Maximum characters to return (default: 10000)',
        },
      },
      required: ['url'],
    },
  },
];

function searxngSearch(query, categories, maxResults) {
  return new Promise((resolve, reject) => {
    const limit = Math.min(maxResults || 10, 30);
    let path = `/search?q=${encodeURIComponent(query)}&format=json`;
    if (categories) path += `&categories=${encodeURIComponent(categories)}`;

    const url = new URL(path, SEARXNG_URL);
    const timeout = setTimeout(() => reject(new Error('SearXNG request timed out')), 30000);

    http.get(url, { headers: { Accept: 'application/json' } }, (res) => {
      let data = '';
      res.on('data', (chunk) => (data += chunk));
      res.on('end', () => {
        clearTimeout(timeout);
        try {
          const parsed = JSON.parse(data);
          const results = (parsed.results || []).slice(0, limit).map((r) => ({
            title: r.title || '',
            url: r.url || '',
            content: r.content || '',
            engine: r.engine || '',
          }));
          resolve(results);
        } catch (err) {
          reject(new Error(`Failed to parse SearXNG response: ${err.message}`));
        }
      });
    }).on('error', (err) => {
      clearTimeout(timeout);
      reject(err);
    });
  });
}

function fetchUrl(urlStr, maxLength) {
  return new Promise((resolve, reject) => {
    const maxLen = maxLength || 10000;
    const url = new URL(urlStr);
    const mod = url.protocol === 'https:' ? https : http;
    const timeout = setTimeout(() => reject(new Error('Fetch timed out')), 30000);

    mod.get(url, { headers: { 'User-Agent': 'Synapse/1.0' } }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        clearTimeout(timeout);
        return fetchUrl(res.headers.location, maxLen).then(resolve).catch(reject);
      }
      if (res.statusCode !== 200) {
        clearTimeout(timeout);
        return reject(new Error(`HTTP ${res.statusCode}`));
      }
      let data = '';
      res.on('data', (chunk) => {
        data += chunk.toString();
        if (data.length > maxLen * 2) res.destroy();
      });
      res.on('end', () => {
        clearTimeout(timeout);
        const text = data
          .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
          .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
          .replace(/<[^>]+>/g, ' ')
          .replace(/&amp;/g, '&')
          .replace(/&lt;/g, '<')
          .replace(/&gt;/g, '>')
          .replace(/&quot;/g, '"')
          .replace(/&#39;/g, "'")
          .replace(/&nbsp;/g, ' ')
          .replace(/\s+/g, ' ')
          .trim();
        resolve(text.slice(0, maxLen));
      });
    }).on('error', (err) => {
      clearTimeout(timeout);
      reject(err);
    });
  });
}

async function handleTool(name, args) {
  switch (name) {
    case 'web_search': {
      const results = await searxngSearch(args.query, args.categories, args.max_results);
      const formatted = results
        .map((r, i) => `[${i + 1}] ${r.title}\n    ${r.url}\n    ${r.content}`)
        .join('\n\n');
      return {
        content: [
          {
            type: 'text',
            text: results.length
              ? `Found ${results.length} results for "${args.query}":\n\n${formatted}`
              : `No results found for "${args.query}".`,
          },
        ],
      };
    }
    case 'web_fetch': {
      const content = await fetchUrl(args.url, args.max_length);
      return { content: [{ type: 'text', text: content }] };
    }
    default:
      return { content: [{ type: 'text', text: `Unknown tool: ${name}` }], isError: true };
  }
}

function makeResponse(id, result) {
  return { jsonrpc: '2.0', id, result };
}

function makeError(id, code, message) {
  return { jsonrpc: '2.0', id, error: { code, message } };
}

async function handleRequest(req) {
  const { id, method, params } = req;
  switch (method) {
    case 'initialize':
      return makeResponse(id, {
        protocolVersion: PROTOCOL_VERSION,
        capabilities: CAPABILITIES,
        serverInfo: SERVER_INFO,
      });
    case 'notifications/initialized':
      return null;
    case 'tools/list':
      return makeResponse(id, { tools: TOOLS });
    case 'tools/call': {
      const { name, arguments: toolArgs } = params;
      try {
        const result = await handleTool(name, toolArgs || {});
        return makeResponse(id, result);
      } catch (err) {
        return makeResponse(id, {
          content: [{ type: 'text', text: `Error: ${err.message}` }],
          isError: true,
        });
      }
    }
    case 'ping':
      return makeResponse(id, {});
    default:
      if (id != null) return makeError(id, -32601, `Method not found: ${method}`);
      return null;
  }
}

const rl = createInterface({ input: process.stdin, terminal: false });

rl.on('line', async (line) => {
  try {
    const req = JSON.parse(line);
    const resp = await handleRequest(req);
    if (resp) process.stdout.write(JSON.stringify(resp) + '\n');
  } catch {
    process.stdout.write(JSON.stringify(makeError(null, -32700, 'Parse error')) + '\n');
  }
});

process.stderr.write(`SearXNG MCP server started → ${SEARXNG_URL}\n`);
