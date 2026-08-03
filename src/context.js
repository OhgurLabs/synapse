export function escapeRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function parseMentions(text, agents) {
  const lower = text.toLowerCase();
  const mentioned = [];

  // Direct @name mentions
  for (const name of Object.keys(agents)) {
    if (lower.includes(`@${name}`)) mentioned.push(name);
  }

  // Role-based group mentions: @qa, @devs, @dev, @reviewers, @researchers, @team
  const roleAliases = {
    '@qa':          ['reviewer'],
    '@reviewers':   ['reviewer'],
    '@devs':        ['developer'],
    '@dev':         ['developer'],
    '@developers':  ['developer'],
    '@researchers': ['researcher'],
    '@research':    ['researcher'],
    '@architects':  ['architect'],
    '@team':        null, // null = everyone
  };

  for (const [alias, roles] of Object.entries(roleAliases)) {
    if (lower.includes(alias)) {
      if (roles === null) {
        // @team = everyone
        for (const name of Object.keys(agents)) {
          if (!mentioned.includes(name)) mentioned.push(name);
        }
      } else {
        for (const [name, agent] of Object.entries(agents)) {
          if (roles.includes(agent.role) && !mentioned.includes(name)) mentioned.push(name);
        }
      }
    }
  }

  return mentioned;
}

export function parseDirectedSegments(text, agents) {
  const agentNames = Object.keys(agents);
  const mentionPattern = new RegExp(`@(${agentNames.map(escapeRegExp).join('|')})\\b`, 'gi');

  const mentions = [];
  let match;
  while ((match = mentionPattern.exec(text)) !== null) {
    mentions.push({ name: match[1].toLowerCase(), index: match.index });
  }

  if (mentions.length === 0) return { directed: {}, broadcast: text };

  const directed = {};

  const first = mentions[0];
  const last = mentions[mentions.length - 1];
  const lastLen = (`@${last.name}`).length;
  const segment = text.slice(last.index + lastLen).trim();
  if (segment) {
    directed[first.name] = segment;
  }

  let broadcast = text.slice(0, first.index);
  if (first.index > 0 && text[first.index - 1] !== ' ') {
    broadcast += ' ';
  }


  return { directed, broadcast };
}
