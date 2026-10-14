import { useState, type FormEvent } from 'react'

/**
 * "Ask Shuttle" strip under the Insights filter bar: three starter questions for
 * the open tab and a box for the user's own, as a 2×2 grid. Questions go to the Shuttle drawer together with
 * the dashboard's live filters (see Insights.askShuttle).
 */
export function AskShuttleBar({
  scope,
  questions,
  onAsk,
  busy,
}: {
  /** What the questions are about, e.g. "Exec KPIs" or "Store Performance · West". */
  scope: string
  questions: string[]
  onAsk: (question: string) => void
  /** Shuttle is answering: wait before asking again. */
  busy: boolean
}) {
  const [text, setText] = useState('')
  const submit = (e: FormEvent) => {
    e.preventDefault()
    if (!text.trim() || busy) return
    onAsk(text)
    setText('')
  }

  return (
    <section className="askbar" aria-label={`Ask Shuttle about ${scope}`}>
      <div className="askbar-head">
        <span className="shuttle-pill" aria-hidden />
        <div>
          <strong>Ask Shuttle about {scope}</strong>
          <span className="mono-label">Answers use the filters above</span>
        </div>
      </div>
      <div className="askbar-chips">
        {questions.map((q) => (
          <button key={q} type="button" onClick={() => onAsk(q)} disabled={busy}>
            {q}
          </button>
        ))}
        <form className="askbar-form" onSubmit={submit}>
          <input
            value={text}
            onChange={(e) => setText(e.target.value)}
            placeholder={busy ? 'Shuttle is answering…' : `Ask your own question about ${scope}…`}
            aria-label={`Ask Shuttle about ${scope}`}
          />
          <button type="submit" disabled={busy || !text.trim()} aria-label="Ask Shuttle">
            →
          </button>
        </form>
      </div>
    </section>
  )
}
