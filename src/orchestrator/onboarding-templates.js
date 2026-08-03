// Starter-project templates for the onboarding wizard's "First Project"
// step. These are FUN build prompts, not enterprise demos — chosen to match
// the prompt genres the local-AI / homelab / agent-builder community
// actually shares (one-shot game builds, bench dashboards, homelab status
// pages, retro web). Each vision is a complete, self-contained build prompt:
// concrete deliverables, no external API keys, works inside the project
// workspace sandbox, visible payoff fast.
//
// The wizard offers these 1-2-3-4 plus "Custom (expert)" — a blank
// name + vision for users who already know what they want.
//
// ATTRIBUTION RULE: if a template adopts someone's shared prompt (not just
// the genre), it MUST carry a `credit` field — { handle, url? } — which the
// wizard renders as a shout-out on the card — AND an `origin` block with the
// source postings. Credit the VERIFIED root when one exists; when the root
// is unknown, thank the account the prompt was pulled from and state origin
// unknown (operator ruling 2026-08-02) — never assert authorship the
// evidence doesn't support. The rest are original writes in community
// genres and ship uncredited. Every template carries `origin` provenance
// (operator ruling 2026-08-01: nail down the root of all prompts).
//
// REPRODUCTION THESIS (operator, 2026-08-01): these prompts are meant to be
// REPRODUCED — the OOBE is the reproduction rig for the prompts the local-AI
// community shares (sudoingX's snake showdowns, homelab HUDs, bench boards).
// That means: same one-shot prompt shape, the community's done-means-played
// bar, and comparable PACE (the strategist right-sizes small visions to 2-3
// milestones — a build the community one-shots must not become a week of
// ceremony). Synapse's twist on the format: a TEAM of agents ships it.

export const ONBOARDING_TEMPLATES = [
  {
    id: 'neon-snake',
    title: 'Neon Snake',
    tagline: 'The classic, glowing. One file, in your browser, tonight.',
    // PROVENANCE: original write (this repo, 2026-08-01), in the genre of the
    // community's snake showdowns (sudoingX et al. — genre, not any specific
    // person's prompt text; hence no credit field).
    origin: { kind: 'original', genre: 'community snake showdown', authored: '2026-08-01' },
    vision: `Build a polished Snake game as ONE single index.html file that runs in any browser — no build step, no frameworks, no external assets. Canvas rendering with a neon-glow aesthetic on a dark background: glowing snake with a distinct head, glowing food, subtle grid, smooth motion. HUD showing SCORE, BEST (persisted to localStorage), and SPEED (increases every few points). Arrow keys and WASD. A clean game-over screen with the final score and "press any key to play again". It should look good enough to screenshot and share the first time it runs. DONE MEANS PLAYED: open it in a browser, steer with the arrows, eat food, watch the speed rise, die, and play again — confirm every one of those behaviors yourself before calling it complete.`,
  },
  {
    id: 'voxel-showpiece',
    title: 'Voxel Showpiece',
    tagline: 'The community voxel bench: a pagoda garden in bloom, one HTML file.',
    // THE community cross-model voxel bench (GLM 5.2, DeepSeek v4 Flash,
    // Qwen, Nemotron and friends are all publicly compared on it). The first
    // paragraph below IS the circulating prompt, unmodified; only the DONE
    // MEANS clause is ours.
    // PROVENANCE (root traced 2026-08-02): the prompt is @GoogleAI's own
    // demo prompt from the Gemini 2.5 Deep Think launch thread, posted
    // 2025-08-01 (x.com/GoogleAI/status/1951284436739260452 — "Here's the
    // prompt: Design and create a very creative, elaborate, and detailed
    // voxel art scene of a pagoda…", character-for-character). It then became
    // a standing cross-model challenge (e.g. rival.tips voxel-art-pagoda-
    // garden). The July-2026 bench wave credits @thatcofffeeguy for
    // recirculating it (TechMD: "Thanks for the prompt @thatcofffeeguy") —
    // circulation credit, NOT authorship.
    origin: {
      kind: 'adopted',
      root: {
        author: '@GoogleAI',
        url: 'https://x.com/GoogleAI/status/1951284436739260452',
        posted: '2025-08-01',
        context: 'Gemini 2.5 Deep Think launch demo prompt',
      },
      rootConfirmed: true,
      circulationCredit: '@thatcofffeeguy (July 2026 local-model bench wave)',
      sources: [
        'x.com/GoogleAI/status/1951284436739260452 (earliest verifiable posting)',
        'rival.tips/challenges/voxel-art-pagoda-garden (standing challenge)',
        'x.com/MiaAI_lab/status/2082061169158660504',
        'x.com/TechMDAI/status/2081858400976044414',
        '@loktar00 reply, Jul 28 2026 (verbatim paste, matches Mia char-for-char)',
      ],
      adopted: '2026-08-01',
    },
    credit: { handle: '@GoogleAI', url: 'https://x.com/GoogleAI/status/1951284436739260452', note: 'Gemini 2.5 Deep Think demo prompt; community bench wave via @thatcofffeeguy' },
    vision: `Design and create a very creative, elaborate, and detailed voxel art scene of a pagoda in a beautiful garden with trees, including some cherry blossoms. Make the scene impressive and varied and use colorful voxels. Use whatever libraries to get this done but make sure I can paste it all into a single HTML file.

DONE MEANS WATCHED: open it in a browser and watch the scene long enough to judge it — confirm the pagoda reads clearly, the garden feels varied and colorful, and the scene renders smoothly before calling it complete.`,
  },
  {
    id: 'bench-board',
    title: 'Agent Bench Board',
    tagline: 'Benchmark the agents you just configured, honest numbers on a dashboard.',
    origin: { kind: 'original', genre: 'agent bench dashboards', authored: '2026-08-01' },
    vision: `Build a small benchmark harness plus a static dashboard that compares this workspace's own coding agents. Deliverables: bench.md defining 5 short, objective coding tasks (each with pass/fail criteria); results.json recording per-agent task outcomes and wall-clock seconds (fill it by actually completing the tasks); index.html — a dark-theme, dependency-free dashboard that renders results.json as a comparison table with a one-line verdict per agent. Honest numbers only: record what actually happened, including failures, with wall-clock seconds per run and a caveats section stating what was NOT measured. DONE MEANS RENDERED: open index.html and confirm every results.json row displays before calling it complete.`,
  },
  {
    id: 'homelab-hud',
    title: 'Homelab Status HUD',
    tagline: 'One dark-theme page that shows what this box is doing.',
    origin: { kind: 'original', genre: 'homelab status pages', authored: '2026-08-01' },
    vision: `Build a single-page status HUD for the machine this runs on. Deliverables: collect.sh (gathers hostname, uptime, CPU load, memory, disk usage per mount, and top 5 processes into status.json using only standard Linux tools); index.html (a dependency-free dark-theme dashboard that renders status.json — cards, bars, and a red/amber/green health strip); README.md explaining the one-liner to refresh and serve it. Everything local: no external requests, no npm installs. Bonus if the HUD auto-refreshes by re-reading status.json every 10 seconds. DONE MEANS EXERCISED: run collect.sh twice and confirm status.json refreshes, then open the HUD and confirm the real values render — a dashboard nobody opened is not done.`,
  },
  {
    id: 'retro-site',
    title: 'Retro Personal Site',
    tagline: 'A 1996-style personal homepage. Guestbook included. No shame.',
    origin: { kind: 'original', genre: 'retro web nostalgia builds', authored: '2026-08-01' },
    vision: `Build a gloriously retro 90s personal homepage as static files. Deliverables: index.html (marquee-style banner done with CSS animation, "under construction" section, visitor counter reading from counter.json, tiled background), guestbook.html (entries rendered from guestbook.json with a form that appends via a tiny serve.js Node file-server — no frameworks, no dependencies), style.css (system fonts, web-safe colors, beveled borders). It should make people grin and screenshot it. Everything must work by running: node serve.js. DONE MEANS USED: start the server, load both pages, submit a guestbook entry through the form, and confirm it persists to guestbook.json and appears on reload before calling it complete.`,
  },
];
