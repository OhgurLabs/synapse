// Plugin loader — reads .synapse/plugins/*.js and calls register(api)
import { readdirSync, existsSync } from 'fs';
import { join } from 'path';
import { pathToFileURL } from 'url';
import { createLogger } from './logger.js';

const log = createLogger('plugins');

export async function loadPlugins(pluginDir, api) {
  if (!existsSync(pluginDir)) return [];

  const loaded = [];
  const files = readdirSync(pluginDir).filter(f => f.endsWith('.js')).sort();

  for (const file of files) {
    const fullPath = join(pluginDir, file);
    try {
      const mod = await import(pathToFileURL(fullPath).href);
      if (typeof mod.register === 'function') {
        await mod.register(api);
        loaded.push(file);
        log.info('Plugin loaded', { file });
      } else {
        log.warn('Plugin skipped (no register export)', { file });
      }
    } catch (err) {
      log.error('Plugin error', { file, error: err.message });
    }
  }

  return loaded;
}
