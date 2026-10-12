/**
 * Keeps the analytics vendor's product names out of what the assistant shows:
 * its reasoning, titles and write-ups can mention the platform, tool or object
 * types by name.
 */
const REPLACEMENTS: [RegExp, string][] = [
  [/\bThoughtSpot\b/gi, 'Storeloom'],
  [/\bSpotter\b/gi, 'Shuttle'],
  [/\bSpotIQ\b/gi, 'Storeloom'],
  [/\bLiveboards\b/gi, 'dashboards'],
  [/\bLiveboard\b/gi, 'dashboard'],
  [/\bWorksheets\b/gi, 'datasets'],
  [/\bWorksheet\b/gi, 'dataset'],
]

export const rebrand = (text: string) => REPLACEMENTS.reduce((s, [re, to]) => s.replace(re, to), text)
