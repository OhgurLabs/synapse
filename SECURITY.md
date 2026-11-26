# Security Policy

## Reporting a Vulnerability

If you believe you've found a security issue in Synapse, please **do not open a public
issue**. Submit a [private vulnerability report](https://github.com/ohgurlabs/synapse/security/advisories/new)
and include the following:

- A description of the vulnerability and its impact.
- Steps to reproduce (a minimal repro is ideal).
- Affected version(s) (`synapse --version` or the version in `package.json`).
- Any relevant logs (with secrets redacted).

You should receive an acknowledgement within **72 hours**. We aim to assess severity and
publish an initial response within **7 days**.

## Embargo

Please give us a reasonable embargo period (default: **90 days**, or until a fix is
released — whichever comes first) before publishing details. We'll work with you on
disclosure timing and credit you in the release notes if you'd like.

## Scope

Synapse is a single-tenant orchestrator, deployable locally or in the cloud. The threat model assumes:

- **The operator owns the host.** The orchestrator runs as a normal user process on a
  machine the operator trusts; we do not defend against a hostile local user with shell
  access on the same host.
- **The web UI is for the operator, not the public internet.** The server is started with
  `server.listen(PORT)`, which listens on all available interfaces by default, so it is
  reachable from any network the host is attached to unless you restrict it. Restrict the web
  UI to a trusted network. Login uses a single shared password (`SYNAPSE_PASSWORD`), which
  **must** be changed from the `synapse` default before granting access.
- **Agent CLIs and HTTP endpoints execute commands.** Agents drive real subprocesses
  (`claude`, `codex`, `gemini`, etc.) and call real model APIs. Treat the projects you
  configure as you would any shell environment.

**In scope:**
- Authentication / session bypass on the web UI or MCP HTTP endpoint
- SSRF, command injection, or path traversal in routing, webhooks, or agent dispatch
- Credential leakage (logs, persisted state, snapshots, MCP responses)
- Sandbox escapes from the agent workspace
- Denial-of-service made possible by a single unauthenticated request

**Out of scope:**
- Misconfigurations the operator has explicitly chosen (e.g. binding `0.0.0.0` with the
  default password, sharing the host with untrusted local users)
- Vulnerabilities in upstream agent CLIs, model providers, or transitive dependencies
  (report those upstream; we will track and bump when patches land)
- Self-XSS, social-engineering of the operator, or attacks requiring physical access

## Supported Versions

While Synapse is in `0.1.x` beta, only the **current release** receives security fixes.
Once `1.0` ships we'll publish a longer-term support window.

| Version | Supported |
|---------|-----------|
| `0.1.x` (current beta) | ✅ |
| Pre-`0.1.0` snapshots  | ❌ |

## Public Acknowledgements

Reporters who follow this policy will be credited in `CHANGELOG.md` and the
corresponding GitHub release, unless they prefer to remain anonymous.
