import { useEffect, useState } from 'react'
import { Brand } from '../components/Brand'
import {
  accountStore,
  ACCOUNT_DEFAULTS,
  DISPLAY_SCALES,
  displayStore,
  formatQuestions,
  hotkeyStore,
  PLANS,
  usageStore,
  useAccount,
  useDisplay,
  useHotkeys,
  useUsage,
  type Account,
  type Hotkey,
  type KeyCombo,
  type PlanId,
} from '../demoConfig'
import { combosEqual, comboFromEvent, formatCombo, hasModifier, isModifierKey, reservedWarning } from '../hotkeys'
import './Config.css'

const count = (v: string) => {
  const n = Number(v)
  return v.trim() === '' || Number.isNaN(n) || n < 0 ? null : Math.floor(n)
}

/**
 * Demo controls, intentionally not linked from the app (open /config directly,
 * no sign-in needed). Settings live in this browser and apply to open tabs live.
 */
export function Config() {
  return (
    <div className="cfg">
      <header className="cfg-head">
        <Brand to="/home" />
        <span className="mono-label">Internal · not linked from the app</span>
      </header>
      <main className="cfg-main">
        <h1 className="display cfg-title">Demo config</h1>
        <p className="cfg-lede">
          Controls for running the Storeloom demo. They’re saved in this browser and apply instantly to any open tab.
        </p>
        <DisplaySection />
        <MeteringSection />
        <AccountSection />
        <HotkeysSection />
      </main>
    </div>
  )
}

function DisplaySection() {
  const { scale } = useDisplay()
  return (
    <section className="cfg-card">
      <div className="cfg-card-head">
        <div>
          <h2 className="mono-label">Display size</h2>
          <p>
            Scales the whole app, embedded dashboards included, like the browser’s zoom. Auto is 80% on laptop screens (under 1,600 px wide) and
            100% on larger ones.
          </p>
        </div>
      </div>
      <div className="cfg-seg" role="radiogroup" aria-label="Display size">
        {DISPLAY_SCALES.map((s) => (
          <button
            key={String(s.value)}
            type="button"
            role="radio"
            aria-checked={scale === s.value}
            className={scale === s.value ? 'is-active' : undefined}
            onClick={() => displayStore.set({ scale: s.value })}
          >
            {s.label}
          </button>
        ))}
      </div>
    </section>
  )
}

function MeteringSection() {
  const usage = useUsage()
  const plan = PLANS[usage.plan]
  const pct = usage.total > 0 ? Math.min(100, (usage.used / usage.total) * 100) : 100
  const left = Math.max(0, usage.total - usage.used)

  return (
    <section className="cfg-card">
      <div className="cfg-card-head">
        <div>
          <h2 className="mono-label">Shuttle metering</h2>
          <p>When on, every Shuttle question uses one from the plan’s allowance, and the upgrade flow appears at the limit.</p>
        </div>
        <Toggle checked={usage.enabled} onChange={(enabled) => usageStore.set({ enabled })} label="Metering" />
      </div>

      <div className="cfg-grid">
        <label className="cfg-field">
          <span className="mono-label">Current plan</span>
          <select
            value={usage.plan}
            onChange={(e) => {
              const p = PLANS[e.target.value as PlanId]
              usageStore.set({ plan: p.id, total: p.questions ?? Number.MAX_SAFE_INTEGER })
            }}
          >
            {Object.values(PLANS).map((p) => (
              <option key={p.id} value={p.id}>
                {p.name} · {formatQuestions(p.questions)} questions
              </option>
            ))}
          </select>
        </label>
        <label className="cfg-field">
          <span className="mono-label">Questions used</span>
          <input
            type="number"
            min={0}
            value={usage.used}
            onChange={(e) => {
              const n = count(e.target.value)
              if (n !== null) usageStore.set({ used: n })
            }}
          />
        </label>
        <label className="cfg-field">
          <span className="mono-label">Questions in plan</span>
          <input
            type="number"
            min={0}
            value={plan.questions === null ? '' : usage.total}
            placeholder="Unlimited"
            disabled={plan.questions === null}
            onChange={(e) => {
              const n = count(e.target.value)
              if (n !== null) usageStore.set({ total: n })
            }}
          />
        </label>
      </div>

      <div className="cfg-meter" aria-hidden>
        <span style={{ width: `${plan.questions === null ? 0 : pct}%` }} className={left === 0 ? 'is-full' : ''} />
      </div>
      <div className="cfg-row">
        <span className="mono-label">
          {plan.questions === null
            ? `${usage.used.toLocaleString('en-US')} used · unlimited on ${plan.name}`
            : `${usage.used.toLocaleString('en-US')} of ${usage.total.toLocaleString('en-US')} used · ${left.toLocaleString('en-US')} left`}
        </span>
        <div className="cfg-actions">
          <button type="button" className="btn-outline" onClick={() => usageStore.set((u) => ({ used: Math.max(0, u.total - 1) }))}>
            One left
          </button>
          <button type="button" className="btn-outline" onClick={() => usageStore.set((u) => ({ used: u.total }))}>
            At limit
          </button>
          <button type="button" className="btn-outline" onClick={() => usageStore.reset()}>
            Reset to defaults
          </button>
        </div>
      </div>
    </section>
  )
}

function AccountSection() {
  const account = useAccount()
  const field = (key: keyof Account, label: string, type = 'text') => (
    <label className="cfg-field">
      <span className="mono-label">{label}</span>
      <input type={type} value={account[key]} onChange={(e) => accountStore.set({ [key]: e.target.value })} />
    </label>
  )
  return (
    <section className="cfg-card">
      <div className="cfg-card-head">
        <div>
          <h2 className="mono-label">Account & rep</h2>
          <p>Shown in the upgrade flow: the customer’s company, and the account rep they can book a meeting with.</p>
        </div>
      </div>
      <div className="cfg-grid is-two">
        {field('company', 'Customer company')}
        {field('repName', 'Account rep name')}
        {field('repTitle', 'Rep title')}
        {field('repEmail', 'Rep email', 'email')}
      </div>
      <div className="cfg-row is-end">
        <button type="button" className="btn-outline" onClick={() => accountStore.set(ACCOUNT_DEFAULTS)}>
          Reset to defaults
        </button>
      </div>
    </section>
  )
}

function HotkeysSection() {
  const hotkeys = useHotkeys()
  const [editing, setEditing] = useState<string | 'new' | null>(null)
  const [combo, setCombo] = useState<KeyCombo | null>(null)
  const [phrase, setPhrase] = useState('')
  const [error, setError] = useState<string | null>(null)

  const open = (h?: Hotkey) => {
    setEditing(h?.id ?? 'new')
    setCombo(h?.combo ?? null)
    setPhrase(h?.phrase ?? '')
    setError(null)
  }
  const close = () => setEditing(null)
  const save = () => {
    if (!combo) return setError('Record a key combo first.')
    if (!phrase.trim()) return setError('Enter the phrase this hotkey should type.')
    if (hotkeys.some((h) => h.id !== editing && combosEqual(h.combo, combo))) {
      return setError(`${formatCombo(combo)} is already used by another hotkey.`)
    }
    hotkeyStore.set(({ hotkeys: list }) => ({
      hotkeys:
        editing === 'new'
          ? [...list, { id: crypto.randomUUID(), combo, phrase: phrase.trim() }]
          : list.map((h) => (h.id === editing ? { ...h, combo, phrase: phrase.trim() } : h)),
    }))
    close()
  }

  const form = (
    <div className="cfg-hotkey-form">
      <ComboRecorder value={combo} onChange={setCombo} />
      <textarea
        rows={2}
        value={phrase}
        onChange={(e) => setPhrase(e.target.value)}
        placeholder="e.g. Which regions and stores had the worst profit margins in the last 12 months?"
      />
      {combo && reservedWarning(combo) && <span className="cfg-warn">{reservedWarning(combo)}</span>}
      {error && <span className="cfg-error">{error}</span>}
      <div className="cfg-actions">
        <button type="button" className="btn-outline" onClick={close}>
          Cancel
        </button>
        <button type="button" className="cfg-primary" onClick={save}>
          Save hotkey
        </button>
      </div>
    </div>
  )

  return (
    <section className="cfg-card">
      <div className="cfg-card-head">
        <div>
          <h2 className="mono-label">Hotkeys</h2>
          <p>Press a saved combo anywhere in the app to type its phrase into the focused field (it’s also copied to the clipboard).</p>
        </div>
        {editing === null && (
          <button type="button" className="cfg-link" onClick={() => open()}>
            + Add hotkey
          </button>
        )}
      </div>
      <ul className="cfg-hotkeys">
        {hotkeys.length === 0 && editing !== 'new' && <li className="cfg-empty">No hotkeys yet.</li>}
        {hotkeys.map((h) =>
          editing === h.id ? (
            <li key={h.id}>{form}</li>
          ) : (
            <li key={h.id} className="cfg-hotkey">
              <kbd>{formatCombo(h.combo)}</kbd>
              <span className="cfg-phrase">{h.phrase}</span>
              <button type="button" className="cfg-link" onClick={() => open(h)} disabled={editing !== null}>
                Edit
              </button>
              <button
                type="button"
                className="cfg-link is-danger"
                onClick={() => hotkeyStore.set(({ hotkeys: list }) => ({ hotkeys: list.filter((x) => x.id !== h.id) }))}
                disabled={editing !== null}
              >
                Remove
              </button>
            </li>
          ),
        )}
        {editing === 'new' && <li>{form}</li>}
      </ul>
    </section>
  )
}

function ComboRecorder({ value, onChange }: { value: KeyCombo | null; onChange: (c: KeyCombo) => void }) {
  const [recording, setRecording] = useState(false)
  const [error, setError] = useState<string | null>(null)
  useEffect(() => {
    if (!recording) return
    const onKey = (e: KeyboardEvent) => {
      e.preventDefault()
      e.stopPropagation()
      if (isModifierKey(e.code)) return
      if (e.code === 'Escape') return setRecording(false)
      const c = comboFromEvent(e)
      if (!hasModifier(c)) return setError('Include at least one modifier key (⌘ / Ctrl / ⌥).')
      setError(null)
      setRecording(false)
      onChange(c)
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [recording, onChange])
  return (
    <div className="cfg-recorder">
      <button
        type="button"
        className={recording ? 'cfg-combo is-recording' : 'cfg-combo'}
        data-recording-hotkey={recording ? '' : undefined}
        onClick={() => {
          setError(null)
          setRecording(true)
        }}
      >
        {recording ? 'Press keys…' : value ? formatCombo(value) : 'Set combo'}
      </button>
      {error && <span className="cfg-error">{error}</span>}
    </div>
  )
}

function Toggle({ checked, onChange, label }: { checked: boolean; onChange: (v: boolean) => void; label: string }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      className={checked ? 'cfg-toggle is-on' : 'cfg-toggle'}
      onClick={() => onChange(!checked)}
    >
      <span />
    </button>
  )
}
