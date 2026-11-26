// Starter projects for the setup wizard. Each vision fits in one workspace,
// uses local inputs, and gives agents a concrete way to verify the result.

export const ONBOARDING_TEMPLATES = [
  {
    id: 'grid-runner',
    title: 'Grid Runner',
    tagline: 'Build a maze game that runs from a single HTML file.',
    origin: { kind: 'original', genre: 'browser games' },
    vision: `Build a keyboard-controlled browser maze in one index.html file. The player must collect three keys to open an exit. Show how many keys remain, provide a restart button, and save the fastest completion time with localStorage. Use built-in browser APIs and bundle all styles and script in the HTML. Open the game and verify that walls block movement, the exit opens only after all keys are collected, and the best time survives a reload.`,
  },
  {
    id: 'voxel-showpiece',
    title: 'Voxel Lighthouse',
    tagline: 'Render a block-built lighthouse with a rotating beam.',
    origin: { kind: 'original', genre: 'browser graphics' },
    vision: `Create a small lighthouse scene in a self-contained index.html file using isometric blocks. Put a lighthouse on a rocky island, add a pier and buoys, and animate its beam sweeping across the water. Include a pause control and start with animation paused when the browser requests reduced motion. Open the file in a browser and verify that the scene fits a narrow window, the beam animates, and the pause control works.`,
  },
  {
    id: 'bench-board',
    title: 'Agent Benchmark Dashboard',
    tagline: 'Run a small benchmark and compare the recorded results.',
    origin: { kind: 'original', genre: 'benchmark dashboards' },
    vision: `Build a benchmark harness and a static dashboard. Define five short coding tasks in bench.md with a pass condition for each. Run each task with the configured agents and save the outcomes and elapsed seconds to results.json. Build a dependency-free index.html that shows every run, including failures, and describes what the benchmark measures. Open the dashboard and check that its rows and totals match results.json.`,
  },
  {
    id: 'system-status',
    title: 'System Status Dashboard',
    tagline: 'Show uptime, memory, CPU load, and disk usage on a local page.',
    origin: { kind: 'original', genre: 'system status pages' },
    vision: `Build a local status page with a shell script that records uptime, CPU load, memory use, and disk usage from standard Linux tools. Write the results to status.json and display them in a dependency-free index.html. Include README.md instructions for refreshing the data and serving the page locally. Run the collector twice and open the dashboard to verify that it displays the values and update time from the latest sample.`,
  },
  {
    id: 'retro-site',
    title: 'Retro Personal Site',
    tagline: 'Build a colorful personal homepage with a local guestbook.',
    origin: { kind: 'original', genre: 'personal websites' },
    vision: `Make a 1990s-inspired personal website with a homepage and a guestbook. Use HTML and CSS for the layout and a small Node.js server built with standard modules to store guestbook entries in a local JSON file. Render submitted entries as plain text. Document how to start the server, then load both pages, submit a sample entry, and verify that it survives a server restart.`,
  },
];
