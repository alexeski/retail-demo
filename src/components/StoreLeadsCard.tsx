import { useState } from 'react'
import { shortStoreName } from '../storeActions'
import type { StoreLead, StoreLeads } from '../storeLeads'

/** Stores Shuttle found in an answer, each one a click (or a reply) away from an action plan. */
export function StoreLeadsCard({
  state,
  actioned,
  onAct,
}: {
  state: { status: 'loading' } | ({ status: 'ready' } & StoreLeads)
  /** Store name → launched action plan ticket. */
  actioned: Record<string, string>
  onAct: (lead: StoreLead) => void
}) {
  const [showAll, setShowAll] = useState(false)

  if (state.status === 'loading') {
    return (
      <div className="leads is-loading" aria-live="polite">
        <span className="sp-shuttle" aria-hidden /> Checking this answer for stores to act on…
      </div>
    )
  }

  const { leads, attention } = state
  const shown = showAll ? leads : leads.slice(0, 5)
  const one = leads.length === 1
  return (
    <section className={attention ? 'leads is-attention' : 'leads'} aria-label="Stores to act on">
      <header className="leads-head">
        <span className="leads-bolt" aria-hidden>
          ⚡
        </span>
        <div>
          <strong>
            {attention
              ? one
                ? `${shortStoreName(leads[0].name)} may need attention`
                : `${leads.length} stores here may need attention`
              : one
                ? `Plan an action for ${shortStoreName(leads[0].name)}?`
                : `Plan an action for one of these ${leads.length} stores?`}
          </strong>
          <p>
            {one
              ? 'I can build an action plan with its live figures and recommended plays.'
              : 'Pick one and I’ll build an action plan with its live figures, or reply with its name or position (e.g. “the 2nd one”).'}
          </p>
        </div>
      </header>
      <ol className="leads-list">
        {shown.map((l, i) => {
          const ticket = actioned[l.name]
          return (
            <li key={l.name}>
              <span className="leads-pos mono-label">{String(i + 1).padStart(2, '0')}</span>
              <span className="leads-name">
                <strong>{shortStoreName(l.name)}</strong>
                {l.region && <span className="mono-label">{l.region}</span>}
              </span>
              <span className="leads-metrics">
                {l.metrics.map((m) => (
                  <span key={m.label} title={m.label}>
                    <span className="mono-label">{m.label}</span> {m.text}
                  </span>
                ))}
              </span>
              {ticket ? (
                <button type="button" className="leads-act is-done" onClick={() => onAct(l)} title={`Plan launched (${ticket}). Build another plan`}>
                  ✓ {ticket}
                </button>
              ) : (
                <button type="button" className="leads-act" onClick={() => onAct(l)}>
                  Act →
                </button>
              )}
            </li>
          )
        })}
      </ol>
      {leads.length > shown.length && (
        <button type="button" className="leads-more" onClick={() => setShowAll(true)}>
          Show all {leads.length} stores
        </button>
      )}
    </section>
  )
}
