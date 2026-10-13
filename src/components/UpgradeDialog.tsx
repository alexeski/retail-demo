import { useEffect, useMemo, useState, type FormEvent } from 'react'
import { createPortal } from 'react-dom'
import { useAuth } from '../auth'
import { applyPlan, formatQuestions, PLANS, renewalDate, useAccount, useUsage, type Plan, type PlanId } from '../demoConfig'
import './UpgradeDialog.css'

// The upsell shown when Shuttle's question allowance runs out (metering is set
// on /config). Everything is simulated: booking a meeting or paying only
// changes the demo's local plan settings. Card details stay in this component's
// state; they are never stored or sent anywhere.

type Step = 'plans' | 'meeting' | 'booked' | 'checkout' | 'processing' | 'paid'
type Cycle = 'monthly' | 'annual'

const usd = (n: number, cents = true) =>
  n.toLocaleString('en-US', { style: 'currency', currency: 'USD', minimumFractionDigits: cents ? 2 : 0, maximumFractionDigits: cents ? 2 : 0 })
const day = (d: Date, opts: Intl.DateTimeFormatOptions = { month: 'short', day: 'numeric' }) => d.toLocaleDateString('en-US', opts)
const ORDER: PlanId[] = ['growth', 'scale', 'enterprise']

export type UpgradeOutcome = { kind: 'meeting'; when: Date; rep: string } | { kind: 'upgrade'; plan: Plan; available: number | null }

export function UpgradeDialog({ onClose, onDone }: { onClose: () => void; onDone: (o: UpgradeOutcome) => void }) {
  const usage = useUsage()
  const account = useAccount()
  const current = PLANS[usage.plan]
  // The next plan up that can be bought online (Enterprise is sales-led).
  const target = ORDER.map((id) => PLANS[id]).find((p, i) => i > ORDER.indexOf(usage.plan) && p.monthly !== null)
  const [step, setStep] = useState<Step>('plans')
  const [cycle, setCycle] = useState<Cycle>('annual')
  const [meeting, setMeeting] = useState<{ when: Date; attendees: string } | null>(null)
  // Kept apart from `target`: once the upgrade applies, the "next plan up" changes.
  const [receipt, setReceipt] = useState<(Receipt & { plan: Plan }) | null>(null)
  const busy = step === 'processing'

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || busy) return
      e.stopImmediatePropagation()
      onClose()
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [onClose, busy])

  return createPortal(
    <div className="up-scrim" onClick={busy ? undefined : onClose}>
      <div
        className={`up-dialog is-${step}`}
        role="dialog"
        aria-modal="true"
        aria-label="Upgrade your Storeloom plan"
        onClick={(e) => e.stopPropagation()}
      >
        <button type="button" className="up-close" aria-label="Close" onClick={onClose} disabled={busy}>
          ×
        </button>

        {step === 'plans' && (
          <PlansStep
            usage={usage}
            current={current}
            target={target}
            cycle={cycle}
            onCycle={setCycle}
            onCheckout={() => setStep('checkout')}
            onMeeting={() => setStep('meeting')}
            onLater={onClose}
          />
        )}
        {step === 'meeting' && (
          <MeetingStep
            current={current}
            onBack={() => setStep('plans')}
            onBooked={(m) => {
              setMeeting(m)
              setStep('booked')
              onDone({ kind: 'meeting', when: m.when, rep: account.repName })
            }}
          />
        )}
        {step === 'booked' && meeting && <BookedStep meeting={meeting} onClose={onClose} />}
        {(step === 'checkout' || step === 'processing') && target && (
          <CheckoutStep
            current={current}
            target={target}
            cycle={cycle}
            onCycle={setCycle}
            processing={step === 'processing'}
            onBack={() => setStep('plans')}
            onPay={(r) => {
              setStep('processing')
              // Authorisation, bank confirmation, plan activation.
              setTimeout(() => {
                applyPlan(target.id)
                setReceipt({ ...r, plan: target })
                setStep('paid')
                onDone({ kind: 'upgrade', plan: target, available: target.questions === null ? null : target.questions - usage.used })
              }, 3200)
            }}
          />
        )}
        {step === 'paid' && receipt && <PaidStep plan={receipt.plan} receipt={receipt} used={usage.used} onClose={onClose} />}
      </div>
    </div>,
    document.body,
  )
}

// ---------------------------------------------------------------------------
// 1. The limit, and the plans
// ---------------------------------------------------------------------------

function PlansStep({
  usage,
  current,
  target,
  cycle,
  onCycle,
  onCheckout,
  onMeeting,
  onLater,
}: {
  usage: ReturnType<typeof useUsage>
  current: Plan
  target?: Plan
  cycle: Cycle
  onCycle: (c: Cycle) => void
  onCheckout: () => void
  onMeeting: () => void
  onLater: () => void
}) {
  const account = useAccount()
  const renews = renewalDate()
  const daysLeft = Math.ceil((renews.getTime() - Date.now()) / 86_400_000)
  const atLimit = usage.used >= usage.total

  return (
    <div className="up-body">
      <span className="up-eyebrow">{atLimit ? 'Plan limit reached' : 'Upgrade your plan'}</span>
      <h2 className="up-title">
        {atLimit
          ? `You’ve used all ${formatQuestions(current.questions)} Shuttle questions on ${current.name} this month.`
          : `Get more out of Shuttle with ${target?.name ?? 'Enterprise'}.`}
      </h2>
      <p className="up-lede">
        Your allowance renews on <strong>{day(renews, { month: 'long', day: 'numeric' })}</strong> ({daysLeft} days). Upgrade now to keep
        the analysis going, or talk to {account.repName.split(' ')[0]} about the right plan for {account.company}.
      </p>

      <div className="up-usage">
        <div className="up-usage-bar" aria-hidden>
          <span style={{ width: `${Math.min(100, (usage.used / Math.max(1, usage.total)) * 100)}%` }} />
        </div>
        <div className="up-usage-meta">
          <span>
            <strong>{usage.used.toLocaleString('en-US')}</strong> / {formatQuestions(current.questions)} questions used
          </span>
          <span>Billing period {day(new Date(renews.getFullYear(), renews.getMonth() - 1, 1))} – {day(new Date(renews.getTime() - 86_400_000))}</span>
        </div>
      </div>

      <div className="up-cycle" role="radiogroup" aria-label="Billing cycle">
        {(['monthly', 'annual'] as Cycle[]).map((c) => (
          <button key={c} type="button" role="radio" aria-checked={cycle === c} className={cycle === c ? 'is-on' : ''} onClick={() => onCycle(c)}>
            {c === 'monthly' ? 'Monthly' : 'Annual'}
            {c === 'annual' && <span className="up-save">Save 20%</span>}
          </button>
        ))}
      </div>

      <div className="up-plans">
        {ORDER.map((id) => {
          const p = PLANS[id]
          const isCurrent = id === current.id
          const isTarget = id === target?.id
          const price = cycle === 'annual' ? p.annualMonthly : p.monthly
          return (
            <article key={id} className={['up-plan', isCurrent && 'is-current', isTarget && 'is-target'].filter(Boolean).join(' ')}>
              {isTarget && <span className="up-badge">Recommended</span>}
              {isCurrent && <span className="up-badge is-muted">Current plan</span>}
              <h3>{p.name}</h3>
              <p className="up-plan-tag">{p.tagline}</p>
              <div className="up-price">
                {price === null ? (
                  <strong>Custom</strong>
                ) : (
                  <>
                    <strong>{usd(price, false)}</strong>
                    <span>/ month{cycle === 'annual' ? ', billed annually' : ''}</span>
                  </>
                )}
              </div>
              <ul>
                {p.features.map((f) => (
                  <li key={f}>{f}</li>
                ))}
              </ul>
              {isCurrent ? (
                <button type="button" className="up-btn is-ghost" disabled>
                  Your plan
                </button>
              ) : p.monthly === null ? (
                <button type="button" className="up-btn is-ghost" onClick={onMeeting}>
                  Talk to sales
                </button>
              ) : ORDER.indexOf(id) < ORDER.indexOf(current.id) ? (
                <button type="button" className="up-btn is-ghost" disabled>
                  —
                </button>
              ) : (
                <button type="button" className="up-btn" onClick={onCheckout}>
                  Upgrade to {p.name} →
                </button>
              )}
            </article>
          )
        })}
      </div>

      <div className="up-foot">
        <button type="button" className="up-rep-link" onClick={onMeeting}>
          <span className="up-avatar">{initials(account.repName)}</span>
          <span>
            <strong>Not sure which plan fits?</strong> Book 30 minutes with {account.repName}, your account executive.
          </span>
          <span aria-hidden>→</span>
        </button>
        <button type="button" className="up-later" onClick={onLater}>
          Remind me later
        </button>
      </div>
    </div>
  )
}

const initials = (name: string) =>
  name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((p) => p[0]!.toUpperCase())
    .join('')

// ---------------------------------------------------------------------------
// 2a. Book a meeting with the account rep
// ---------------------------------------------------------------------------

const SLOTS = ['09:30', '10:30', '11:30', '13:00', '14:00', '15:30', '16:30']

/** Next `n` business days, starting tomorrow. */
function businessDays(n: number): Date[] {
  const out: Date[] = []
  const d = new Date()
  d.setHours(0, 0, 0, 0)
  while (out.length < n) {
    d.setDate(d.getDate() + 1)
    if (d.getDay() !== 0 && d.getDay() !== 6) out.push(new Date(d))
  }
  return out
}

/** Some slots are "taken" (stable per day), so the calendar looks lived-in. */
const slotTaken = (date: Date, i: number) => (date.getDate() * 7 + i * 13) % 5 === 0

function MeetingStep({
  current,
  onBack,
  onBooked,
}: {
  current: Plan
  onBack: () => void
  onBooked: (m: { when: Date; attendees: string }) => void
}) {
  const account = useAccount()
  const { user } = useAuth()
  const days = useMemo(() => businessDays(5), [])
  const [dayIdx, setDayIdx] = useState(0)
  const [slot, setSlot] = useState<string | null>(null)
  const [attendees, setAttendees] = useState(user?.email ?? '')
  const [agenda, setAgenda] = useState(
    `Shuttle reached ${current.name}’s ${formatQuestions(current.questions)}-question limit on ${day(new Date(), { month: 'long', day: 'numeric' })}. ` +
      `Review usage across our regions and compare Scale vs Enterprise for ${account.company}.`,
  )
  const [sending, setSending] = useState(false)
  const tz = Intl.DateTimeFormat().resolvedOptions().timeZone.replace(/_/g, ' ')

  const submit = (e: FormEvent) => {
    e.preventDefault()
    if (!slot) return
    const [h, m] = slot.split(':').map(Number)
    const when = new Date(days[dayIdx])
    when.setHours(h, m, 0, 0)
    setSending(true)
    setTimeout(() => onBooked({ when, attendees }), 1100)
  }

  return (
    <form className="up-body" onSubmit={submit}>
      <button type="button" className="up-back" onClick={onBack}>
        ← Plans
      </button>
      <span className="up-eyebrow">Talk to your account team</span>
      <h2 className="up-title">Book a plan review with {account.repName.split(' ')[0]}</h2>

      <div className="up-rep">
        <span className="up-avatar is-large">{initials(account.repName)}</span>
        <div>
          <strong>{account.repName}</strong>
          <span>
            {account.repTitle} · {account.company}
          </span>
          <span className="up-rep-mail">{account.repEmail}</span>
        </div>
        <span className="up-rep-meta">
          <span className="up-dot" /> Typically replies within 2 business hours
        </span>
      </div>

      <div className="up-meeting-type">
        <strong>Plan review</strong> · 30 min · Video call (link in the invitation)
      </div>

      <fieldset className="up-fieldset">
        <legend>Pick a day</legend>
        <div className="up-days">
          {days.map((d, i) => (
            <button
              key={d.toISOString()}
              type="button"
              className={i === dayIdx ? 'is-on' : ''}
              onClick={() => {
                setDayIdx(i)
                setSlot(null)
              }}
            >
              <span>{day(d, { weekday: 'short' })}</span>
              <strong>{d.getDate()}</strong>
              <span>{day(d, { month: 'short' })}</span>
            </button>
          ))}
        </div>
      </fieldset>

      <fieldset className="up-fieldset">
        <legend>
          Available times <span>({tz})</span>
        </legend>
        <div className="up-slots">
          {SLOTS.map((s, i) => {
            const taken = slotTaken(days[dayIdx], i)
            return (
              <button key={s} type="button" disabled={taken} className={slot === s ? 'is-on' : ''} onClick={() => setSlot(s)}>
                {new Date(`2000-01-01T${s}:00`).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })}
              </button>
            )
          })}
        </div>
      </fieldset>

      <div className="up-grid">
        <label className="up-field">
          <span>Attendees</span>
          <input value={attendees} onChange={(e) => setAttendees(e.target.value)} placeholder="you@company.com, colleague@company.com" />
        </label>
        <label className="up-field is-wide">
          <span>What would you like to cover?</span>
          <textarea rows={3} value={agenda} onChange={(e) => setAgenda(e.target.value)} />
        </label>
      </div>

      <div className="up-actions">
        <span className="up-hint">{slot ? `${day(days[dayIdx], { weekday: 'long', month: 'long', day: 'numeric' })} at ${slot}` : 'Choose a time to continue'}</span>
        <button type="submit" className="up-btn" disabled={!slot || sending}>
          {sending ? 'Booking…' : 'Book meeting →'}
        </button>
      </div>
    </form>
  )
}

function BookedStep({ meeting, onClose }: { meeting: { when: Date; attendees: string }; onClose: () => void }) {
  const account = useAccount()
  const end = new Date(meeting.when.getTime() + 30 * 60_000)

  const downloadIcs = () => {
    const stamp = (d: Date) => d.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '')
    const ics = [
      'BEGIN:VCALENDAR',
      'VERSION:2.0',
      'PRODID:-//Storeloom//Plan review//EN',
      'BEGIN:VEVENT',
      `UID:${crypto.randomUUID()}@storeloom.example`,
      `DTSTAMP:${stamp(new Date())}`,
      `DTSTART:${stamp(meeting.when)}`,
      `DTEND:${stamp(end)}`,
      `SUMMARY:Storeloom plan review with ${account.repName}`,
      `DESCRIPTION:Plan review for ${account.company}. Video link in the invitation from ${account.repEmail}.`,
      `ORGANIZER;CN=${account.repName}:mailto:${account.repEmail}`,
      'END:VEVENT',
      'END:VCALENDAR',
    ].join('\r\n')
    const url = URL.createObjectURL(new Blob([ics], { type: 'text/calendar' }))
    const a = document.createElement('a')
    a.href = url
    a.download = 'storeloom-plan-review.ics'
    a.click()
    setTimeout(() => URL.revokeObjectURL(url), 1000)
  }

  return (
    <div className="up-body up-done">
      <span className="up-check" aria-hidden>
        ✓
      </span>
      <span className="up-eyebrow">Meeting booked</span>
      <h2 className="up-title">You’re all set with {account.repName.split(' ')[0]}.</h2>
      <div className="up-ticket">
        <div>
          <span>When</span>
          <strong>
            {day(meeting.when, { weekday: 'long', month: 'long', day: 'numeric' })} ·{' '}
            {meeting.when.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })} –{' '}
            {end.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', timeZoneName: 'short' })}
          </strong>
        </div>
        <div>
          <span>With</span>
          <strong>
            {account.repName}, {account.repTitle}
          </strong>
        </div>
        <div>
          <span>Invitation sent to</span>
          <strong>{meeting.attendees || '—'}</strong>
        </div>
      </div>
      <p className="up-lede">
        {account.repName.split(' ')[0]} will come prepared with your Shuttle usage by region. Meanwhile, your questions renew on{' '}
        {day(renewalDate(), { month: 'long', day: 'numeric' })}.
      </p>
      <div className="up-actions">
        <button type="button" className="up-btn is-ghost" onClick={downloadIcs}>
          Add to calendar (.ics)
        </button>
        <button type="button" className="up-btn" onClick={onClose}>
          Done
        </button>
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// 2b. Checkout
// ---------------------------------------------------------------------------

type Receipt = { invoice: string; amount: number; last4: string; brand: string; email: string; date: Date; cycle: Cycle }

const digits = (s: string) => s.replace(/\D/g, '')

function cardBrand(num: string): 'Visa' | 'Mastercard' | 'Amex' | 'Discover' | null {
  const d = digits(num)
  if (/^4/.test(d)) return 'Visa'
  if (/^(5[1-5]|2[2-7])/.test(d)) return 'Mastercard'
  if (/^3[47]/.test(d)) return 'Amex'
  if (/^6(011|5)/.test(d)) return 'Discover'
  return null
}

function luhn(num: string) {
  const d = digits(num)
  if (d.length < 13) return false
  let sum = 0
  for (let i = 0; i < d.length; i++) {
    let n = Number(d[d.length - 1 - i])
    if (i % 2) {
      n *= 2
      if (n > 9) n -= 9
    }
    sum += n
  }
  return sum % 10 === 0
}

const formatCard = (v: string) => {
  const d = digits(v).slice(0, 19)
  return cardBrand(d) === 'Amex' ? d.replace(/^(\d{0,4})(\d{0,6})(\d{0,5}).*/, (_, a, b, c) => [a, b, c].filter(Boolean).join(' ')) : d.replace(/(\d{4})(?=\d)/g, '$1 ')
}

const formatExpiry = (v: string) => {
  const d = digits(v).slice(0, 4)
  return d.length > 2 ? `${d.slice(0, 2)} / ${d.slice(2)}` : d
}

function expiryValid(v: string) {
  const d = digits(v)
  if (d.length !== 4) return false
  const month = Number(d.slice(0, 2))
  const year = 2000 + Number(d.slice(2))
  if (month < 1 || month > 12) return false
  const now = new Date()
  return year > now.getFullYear() || (year === now.getFullYear() && month >= now.getMonth() + 1)
}

/** What's due today: the new plan for the rest of the period, minus unused time on the current one. */
function quote(current: Plan, target: Plan, cycle: Cycle) {
  const now = new Date()
  const renews = renewalDate(now)
  const periodDays = new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate()
  const daysLeft = Math.max(1, Math.ceil((renews.getTime() - now.getTime()) / 86_400_000))
  const share = daysLeft / periodDays
  const credit = Math.round((current.monthly ?? 0) * share * 100) / 100
  if (cycle === 'annual') {
    const annual = (target.annualMonthly ?? 0) * 12
    return {
      lines: [
        { label: `${target.name} · annual (12 months)`, amount: annual },
        { label: `Unused time on ${current.name} (${daysLeft} days)`, amount: -credit },
      ],
      total: Math.round((annual - credit) * 100) / 100,
      then: `Renews ${day(new Date(now.getFullYear() + 1, now.getMonth(), now.getDate()), { month: 'long', day: 'numeric', year: 'numeric' })} at ${usd(annual)}/year`,
    }
  }
  const charge = Math.round((target.monthly ?? 0) * share * 100) / 100
  return {
    lines: [
      { label: `${target.name} · ${day(now)} – ${day(new Date(renews.getTime() - 86_400_000))}`, amount: charge },
      { label: `Unused time on ${current.name} (${daysLeft} days)`, amount: -credit },
    ],
    total: Math.round((charge - credit) * 100) / 100,
    then: `Then ${usd(target.monthly ?? 0)}/month from ${day(renews, { month: 'long', day: 'numeric' })}`,
  }
}

function CheckoutStep({
  current,
  target,
  cycle,
  onCycle,
  processing,
  onBack,
  onPay,
}: {
  current: Plan
  target: Plan
  cycle: Cycle
  onCycle: (c: Cycle) => void
  processing: boolean
  onBack: () => void
  onPay: (r: Receipt) => void
}) {
  const { user } = useAuth()
  const account = useAccount()
  const q = quote(current, target, cycle)
  // Pre-filled with the standard test card, so nobody types a real one during a demo.
  const [card, setCard] = useState({
    email: user?.email ?? '',
    number: '4242 4242 4242 4242',
    expiry: '12 / 34',
    cvc: '123',
    name: user?.displayName ?? '',
    country: 'United States',
    zip: '94105',
    company: account.company,
    terms: false,
  })
  const [touched, setTouched] = useState(false)
  const brand = cardBrand(card.number)
  const errors = {
    email: /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(card.email) ? null : 'Enter a valid email',
    number: luhn(card.number) ? null : 'Your card number is incomplete or invalid',
    expiry: expiryValid(card.expiry) ? null : 'Your card’s expiration date is invalid',
    cvc: digits(card.cvc).length >= (brand === 'Amex' ? 4 : 3) ? null : 'Your card’s security code is incomplete',
    name: card.name.trim() ? null : 'Enter the name on the card',
    zip: card.zip.trim().length >= 3 ? null : 'Enter a postal code',
    terms: card.terms ? null : 'Accept the subscription terms to continue',
  }
  const invalid = Object.values(errors).some(Boolean)
  const set = (patch: Partial<typeof card>) => setCard((c) => ({ ...c, ...patch }))
  const err = (k: keyof typeof errors) => (touched && errors[k] ? <span className="up-err">{errors[k]}</span> : null)

  const submit = (e: FormEvent) => {
    e.preventDefault()
    setTouched(true)
    if (invalid) return
    onPay({
      invoice: `INV-${new Date().getFullYear()}-${String(Math.floor(10000 + Math.random() * 89999))}`,
      amount: q.total,
      last4: digits(card.number).slice(-4),
      brand: brand ?? 'Card',
      email: card.email,
      date: new Date(),
      cycle,
    })
  }

  return (
    <form className="up-body up-checkout" onSubmit={submit} noValidate>
      {processing && (
        <div className="up-processing" role="status" aria-live="polite">
          <span className="up-spinner" aria-hidden />
          <ProcessingSteps last4={digits(card.number).slice(-4)} plan={target.name} />
        </div>
      )}
      <button type="button" className="up-back" onClick={onBack} disabled={processing}>
        ← Plans
      </button>
      <span className="up-eyebrow">Upgrade to {target.name}</span>
      <h2 className="up-title">Checkout</h2>

      <div className="up-checkout-grid">
        <section className="up-summary" aria-label="Order summary">
          <div className="up-cycle is-small" role="radiogroup" aria-label="Billing cycle">
            {(['monthly', 'annual'] as Cycle[]).map((c) => (
              <button key={c} type="button" role="radio" aria-checked={cycle === c} className={cycle === c ? 'is-on' : ''} onClick={() => onCycle(c)}>
                {c === 'monthly' ? 'Monthly' : 'Annual · save 20%'}
              </button>
            ))}
          </div>
          <h3>{target.name}</h3>
          <ul className="up-features">
            {target.features.slice(0, 4).map((f) => (
              <li key={f}>{f}</li>
            ))}
          </ul>
          <dl className="up-lines">
            {q.lines.map((l) => (
              <div key={l.label}>
                <dt>{l.label}</dt>
                <dd>{l.amount < 0 ? `−${usd(-l.amount)}` : usd(l.amount)}</dd>
              </div>
            ))}
            <div>
              <dt>Tax</dt>
              <dd>Calculated on invoice</dd>
            </div>
            <div className="is-total">
              <dt>Due today</dt>
              <dd>{usd(q.total)}</dd>
            </div>
          </dl>
          <p className="up-then">{q.then}. Your new allowance applies immediately. Cancel or change plans anytime from Billing.</p>
        </section>

        <section className="up-pay" aria-label="Payment">
          <div className="up-pay-head">
            <strong>Payment</strong>
            <span className="up-testmode">Test mode</span>
          </div>

          <label className="up-field">
            <span>Email for receipt</span>
            <input type="email" value={card.email} onChange={(e) => set({ email: e.target.value })} autoComplete="off" />
            {err('email')}
          </label>

          <div className="up-field">
            <span>Card information</span>
            <div className={`up-card ${touched && (errors.number || errors.expiry || errors.cvc) ? 'is-invalid' : ''}`}>
              <div className="up-card-number">
                <input
                  inputMode="numeric"
                  aria-label="Card number"
                  value={card.number}
                  onChange={(e) => set({ number: formatCard(e.target.value) })}
                  placeholder="1234 1234 1234 1234"
                  autoComplete="off"
                  data-1p-ignore
                  data-lpignore="true"
                />
                <span className={`up-brand ${brand ? 'is-known' : ''}`}>{brand ?? 'Card'}</span>
              </div>
              <div className="up-card-row">
                <input
                  inputMode="numeric"
                  aria-label="Expiration date"
                  value={card.expiry}
                  onChange={(e) => set({ expiry: formatExpiry(e.target.value) })}
                  placeholder="MM / YY"
                  autoComplete="off"
                  data-1p-ignore
                  data-lpignore="true"
                />
                <input
                  inputMode="numeric"
                  aria-label="Security code"
                  value={card.cvc}
                  onChange={(e) => set({ cvc: digits(e.target.value).slice(0, 4) })}
                  placeholder="CVC"
                  autoComplete="off"
                  data-1p-ignore
                  data-lpignore="true"
                />
              </div>
            </div>
            {err('number') ?? err('expiry') ?? err('cvc')}
          </div>

          <label className="up-field">
            <span>Name on card</span>
            <input value={card.name} onChange={(e) => set({ name: e.target.value })} autoComplete="off" />
            {err('name')}
          </label>

          <div className="up-grid">
            <label className="up-field">
              <span>Country</span>
              <select value={card.country} onChange={(e) => set({ country: e.target.value })}>
                {['United States', 'Canada', 'United Kingdom', 'Ireland', 'Australia', 'Germany', 'France'].map((c) => (
                  <option key={c}>{c}</option>
                ))}
              </select>
            </label>
            <label className="up-field">
              <span>{card.country === 'United States' ? 'ZIP' : 'Postal code'}</span>
              <input value={card.zip} onChange={(e) => set({ zip: e.target.value })} autoComplete="off" />
              {err('zip')}
            </label>
          </div>

          <label className="up-field">
            <span>Company (on invoice)</span>
            <input value={card.company} onChange={(e) => set({ company: e.target.value })} autoComplete="off" />
          </label>

          <label className="up-terms">
            <input type="checkbox" checked={card.terms} onChange={(e) => set({ terms: e.target.checked })} />
            <span>
              I agree to the Storeloom Subscription Terms and authorise Storeloom to charge this card {cycle === 'annual' ? 'annually' : 'monthly'} until I
              cancel.
            </span>
          </label>
          {err('terms')}

          <button type="submit" className="up-btn is-pay" disabled={processing}>
            Pay {usd(q.total)} and upgrade
          </button>
          <p className="up-secure">
            <span aria-hidden>🔒</span> Payments are encrypted and processed securely. Test mode: no card is charged.
          </p>
        </section>
      </div>
    </form>
  )
}

function ProcessingSteps({ last4, plan }: { last4: string; plan: string }) {
  const steps = [`Authorising card ending ${last4}…`, 'Confirming with your bank…', `Activating ${plan}…`]
  const [i, setI] = useState(0)
  useEffect(() => {
    const t = setInterval(() => setI((n) => Math.min(n + 1, steps.length - 1)), 1050)
    return () => clearInterval(t)
  }, [steps.length])
  return <strong>{steps[i]}</strong>
}

function PaidStep({ plan, receipt, used, onClose }: { plan: Plan; receipt: Receipt; used: number; onClose: () => void }) {
  const available = plan.questions === null ? null : Math.max(0, plan.questions - used)
  return (
    <div className="up-body up-done">
      <span className="up-check" aria-hidden>
        ✓
      </span>
      <span className="up-eyebrow">Payment successful</span>
      <h2 className="up-title">Welcome to {plan.name}.</h2>
      <p className="up-lede">
        Shuttle is ready: <strong>{available === null ? 'unlimited questions' : `${available.toLocaleString('en-US')} questions`}</strong> available
        now, {formatQuestions(plan.questions)} every month.
      </p>
      <div className="up-ticket">
        <div>
          <span>Invoice</span>
          <strong>{receipt.invoice}</strong>
        </div>
        <div>
          <span>Amount paid</span>
          <strong>{usd(receipt.amount)}</strong>
        </div>
        <div>
          <span>Payment method</span>
          <strong>
            {receipt.brand} ending {receipt.last4}
          </strong>
        </div>
        <div>
          <span>Billing</span>
          <strong>{receipt.cycle === 'annual' ? 'Annual' : 'Monthly'}</strong>
        </div>
        <div>
          <span>Receipt sent to</span>
          <strong>{receipt.email}</strong>
        </div>
      </div>
      <div className="up-actions">
        <span className="up-hint">{day(receipt.date, { month: 'long', day: 'numeric', year: 'numeric' })}</span>
        <button type="button" className="up-btn" onClick={onClose}>
          Back to Shuttle →
        </button>
      </div>
    </div>
  )
}
