// Timezone list, taken from the tzdata the host already ships.
//
// This is what Ubuntu (and Pop!_OS, Debian, Fedora — anything with tzdata)
// uses for its own timezone picker: `dpkg-reconfigure tzdata` reads these same
// tables to offer geographic area then city.
//
// Reading them beats deriving a list in code for three concrete reasons:
//
//  1. zone1970.tab is CURATED — 312 zones for populated places, versus the 418
//     Intl.supportedValuesOf() reports. The extra 106 are aliases and
//     duplicates the tzdb maintainers deliberately keep out of pickers.
//  2. It already uses MODERN names. Intl still reports Europe/Kiev and
//     Asia/Calcutta as canonical because ICU lags the tzdb (2022b made
//     Europe/Kyiv canonical). The shipped table has Kyiv and Kolkata, so a
//     hand-maintained rename map is redundant — and would rot.
//  3. It carries ISO-3166 country codes, which Intl has no equivalent for.
//     That is what makes country-grouped selection possible at all, including
//     rows where one zone serves several countries (AE,OM,RE,SC,TF ->
//     Asia/Dubai).
//
// The list therefore updates with the OS tzdata package rather than with our
// code. Hosts without tzdata (Windows, some containers) fall back to Intl.
import { readFileSync, existsSync } from 'fs';

const ZONE_TAB = '/usr/share/zoneinfo/zone1970.tab';
const ISO3166_TAB = '/usr/share/zoneinfo/iso3166.tab';

function parseIso3166(path) {
  const countries = {};
  for (const line of readFileSync(path, 'utf-8').split('\n')) {
    if (!line || line.startsWith('#')) continue;
    const [code, name] = line.split('\t');
    if (code && name) countries[code.trim()] = name.trim();
  }
  return countries;
}

function parseZoneTab(path, countries) {
  const zones = [];
  for (const line of readFileSync(path, 'utf-8').split('\n')) {
    if (!line || line.startsWith('#')) continue;
    // country-codes \t coordinates \t TZ \t comments
    const [codes, , tz, comment] = line.split('\t');
    if (!tz) continue;
    const codeList = (codes || '').split(',').map(c => c.trim()).filter(Boolean);
    zones.push({
      id: tz.trim(),
      countries: codeList,
      countryNames: codeList.map(c => countries[c] || c),
      // tzdb uses this to disambiguate multi-zone countries ("Eastern time")
      note: (comment || '').trim() || null,
    });
  }
  return zones;
}

/**
 * The selectable zone list. Returns { source, zones } where source is
 * 'tzdata' or 'intl' so callers can tell the operator which list they got —
 * a silently degraded fallback is how a worse list ships unnoticed.
 */
export function listTimezones() {
  try {
    if (existsSync(ZONE_TAB) && existsSync(ISO3166_TAB)) {
      const countries = parseIso3166(ISO3166_TAB);
      const zones = parseZoneTab(ZONE_TAB, countries);
      if (zones.length) {
        zones.sort((a, b) => (a.countryNames[0] || '').localeCompare(b.countryNames[0] || '')
          || a.id.localeCompare(b.id));
        return { source: 'tzdata', zones };
      }
    }
  } catch { /* fall through to Intl */ }

  // No tzdata on this host. Intl's list is longer and carries legacy spellings,
  // but it is better than no picker.
  let ids = [];
  try { ids = Intl.supportedValuesOf('timeZone') || []; } catch { ids = []; }
  return {
    source: 'intl',
    zones: ids.map(id => ({ id, countries: [], countryNames: [], note: null })),
  };
}
