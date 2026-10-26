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

/** At the start of a sentence, line or heading the replacement is capitalised ("Liveboard Plan" → "Dashboard Plan"). */
const atStart = (s: string, at: number) => {
  const before = s.slice(Math.max(0, at - 8), at)
  return /([.!?:]\s+|\n[\s#>*-]*)$/.test(before) || (at <= 8 && /^[\s#>*-]*$/.test(before))
}

export const rebrand = (text: string) =>
  REPLACEMENTS.reduce(
    (s, [re, to]) => s.replace(re, (found: string, at: number) => (atStart(s, at) && /^[A-Z]/.test(found) ? to[0]!.toUpperCase() + to.slice(1) : to)),
    text,
  )
