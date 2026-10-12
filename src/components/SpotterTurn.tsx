import { useEffect, useMemo, useState } from 'react'
import { createPortal } from 'react-dom'
import DOMPurify from 'dompurify'
import { marked } from 'marked'
import { rebrand } from '../brand'
import { answerFrameUrl, stageLabel, type AnswerMeta, type Step, type Turn } from '../spotter'
import './SpotterTurn.css'

/** Spotter's markdown, rendered and sanitised (it is server-generated HTML). */
function Markdown({ text, className }: { text: string; className?: string }) {
  const html = useMemo(() => DOMPurify.sanitize(marked.parse(rebrand(text), { async: false, gfm: true, breaks: false })), [text])
  return <div className={['md', className].filter(Boolean).join(' ')} dangerouslySetInnerHTML={{ __html: html }} />
}

function useElapsed(start: number, end?: number) {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (end) return
    const t = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(t)
  }, [end])
  return Math.max(0, Math.round(((end ?? now) - start) / 1000))
}

function StepItem({ step, live }: { step: Step; live: boolean }) {
  const [showOutput, setShowOutput] = useState(false)
  return (
    <li className={step.running ? 'sp-step is-running' : 'sp-step'}>
      <span className="sp-step-icon" aria-hidden>
        {step.running ? <span className="sp-shuttle" /> : '✓'}
      </span>
      <div className="sp-step-body">
        <span className="sp-step-title">{rebrand(step.title)}</span>
        {step.stages.length > 0 && (
          <span className="sp-stages">
            {step.stages.map((code, i) => (
              <span key={code} className={step.running && i === step.stages.length - 1 ? 'sp-stage is-current' : 'sp-stage'}>
                {stageLabel(code)}
              </span>
            ))}
          </span>
        )}
        {step.thinking && <Markdown text={step.thinking} className={live && step.running ? 'sp-thinking is-streaming' : 'sp-thinking'} />}
        {step.answer && (
          <span className="sp-step-answer">
            Answer: <strong>{rebrand(step.answer.title ?? '')}</strong>
          </span>
        )}
        {step.outputs.length > 0 && (
          <>
            <button type="button" className="sp-output-toggle" onClick={() => setShowOutput((v) => !v)}>
              {showOutput ? 'Hide' : 'Show'} tool output
            </button>
            {showOutput && (
              <pre className="sp-output">{rebrand(step.outputs.join('\n\n').slice(0, 4000))}</pre>
            )}
          </>
        )}
      </div>
    </li>
  )
}

/**
 * The interactive Spotter answer (chart or table) in a card. The frame is
 * cross-origin and doesn't report its height, so it gets a generous default,
 * can be dragged taller, and can be expanded to a large overlay.
 */
function AnswerCard({ answer }: { answer: AnswerMeta }) {
  const [expanded, setExpanded] = useState(false)
  const url = answerFrameUrl(answer)
  const title = rebrand(answer.title ?? 'Shuttle answer')

  useEffect(() => {
    if (!expanded) return
    // Capture phase, so Escape closes the overlay rather than the whole drawer.
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return
      e.stopImmediatePropagation()
      setExpanded(false)
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [expanded])

  return (
    <figure className="sp-answer">
      <figcaption>
        <span className="sp-answer-head">
          <span className="sp-answer-title">{title}</span>
          <button type="button" className="sp-expand" onClick={() => setExpanded(true)} title="Open larger">
            Expand ⤢
          </button>
        </span>
        {answer.sage_query && <code className="sp-answer-query">{answer.sage_query}</code>}
      </figcaption>
      <div className="sp-answer-frame">
        <div className="sp-answer-clip">
          <iframe src={url} title={title} loading="lazy" />
        </div>
      </div>
      {/* Portalled: the drawer's slide-in transform would otherwise trap a fixed overlay inside it. */}
      {expanded &&
        createPortal(
        <div className="sp-overlay" role="dialog" aria-label={title} onClick={() => setExpanded(false)}>
          <div className="sp-overlay-panel" onClick={(e) => e.stopPropagation()}>
            <div className="sp-overlay-head">
              <span className="sp-answer-title">{title}</span>
              <button type="button" className="drawer-close" aria-label="Close" onClick={() => setExpanded(false)}>
                ×
              </button>
            </div>
            <div className="sp-answer-clip">
              <iframe src={url} title={title} />
            </div>
          </div>
        </div>,
          document.body,
        )}
    </figure>
  )
}

/** One question to Spotter, rendered the way Spotter shows its work. */
export function SpotterTurn({ turn, onRetry }: { turn: Turn; onRetry?: () => void }) {
  const live = turn.phase === 'starting' || turn.phase === 'working' || turn.phase === 'answering'
  const seconds = useElapsed(turn.startedAt, turn.endedAt)
  // The work log stays open while Spotter works and folds away once the answer
  // arrives, unless the viewer has opened or closed it themselves.
  const [workOpen, setWorkOpen] = useState<boolean | null>(null)
  const autoOpen = turn.phase === 'starting' || turn.phase === 'working'
  const open = workOpen ?? autoOpen

  return (
    <div className="sp-turn">
      <span className="sp-label mono-label">
        <span className="shuttle-pill is-small" />
        Shuttle
      </span>

      {(turn.steps.length > 0 || live) && (
        <div className={open ? 'sp-work is-open' : 'sp-work'}>
          <button type="button" className="sp-work-head" onClick={() => setWorkOpen(!open)} aria-expanded={open}>
            {live ? <span className="sp-shuttle" aria-hidden /> : <span aria-hidden>✓</span>}
            <span>
              {turn.phase === 'starting'
                ? 'Starting Shuttle'
                : live
                  ? `Working · ${seconds}s`
                  : `Worked for ${seconds}s · ${turn.steps.length} step${turn.steps.length === 1 ? '' : 's'}`}
            </span>
            <span className="sp-work-caret" aria-hidden>
              {open ? '−' : '+'}
            </span>
          </button>
          {open && (
            <ol className="sp-steps">
              {turn.steps.map((s) => (
                <StepItem key={s.id} step={s} live={live} />
              ))}
              {turn.phase === 'starting' && <li className="sp-step-pending">Connecting to your data…</li>}
            </ol>
          )}
        </div>
      )}

      {turn.answers.map((a) => (
        <AnswerCard key={`${a.session_id}-${a.gen_no}`} answer={a} />
      ))}

      {turn.text && <Markdown text={turn.text} className={turn.phase === 'answering' ? 'sp-text is-streaming' : 'sp-text'} />}

      {turn.phase === 'stopped' && <p className="sp-note">Stopped.</p>}
      {turn.phase === 'error' && (
        <div className="sp-error" role="alert">
          {turn.error}
          {onRetry && (
            <button type="button" onClick={onRetry}>
              Try again
            </button>
          )}
        </div>
      )}
    </div>
  )
}
