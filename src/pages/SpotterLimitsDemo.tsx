import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Action, HostEvent, SpotterExperienceVersion, SpotterUsageCounterDisplayMode } from '@thoughtspot/visual-embed-sdk'
import { SpotterEmbed, useEmbedRef } from '@thoughtspot/visual-embed-sdk/react'
import { SHUTTLE_SUGGESTIONS } from '../components/Shuttle'
import { useUpgrade } from '../components/UpgradeProvider'
import { applyPlan, formatQuestions, PLANS, PLAN_ORDER, usageStore, useUsage, type PlanId } from '../demoConfig'
import { RETAIL_MODEL_ID, setEmbedPersona, THOUGHTSPOT_HOST } from '../thoughtspot'
import { useFillHeight } from '../useFillHeight'
import {
  currentUserId,
  deletePools,
  getUserUsage,
  onApiCall,
  provisionUser,
  UsageApiError,
  type ApiCall,
  type PoolKey,
  type UserUsage,
} from '../spotterUsage'
import './SpotterLimitsDemo.css'

// The native Spotter experience as its own section of Storeloom, white-labelled
// (strings, icons and theme come from initThoughtSpot in src/thoughtspot.ts),
// with its conversation history on and Spotter usage limits switched on. The
// panel beside it is for the demo: it drives the real usage-limit APIs against
// the dedicated demo user and shows the code behind each step.

type Counter = 'alwaysVisible' | 'visibleAfterWarning' | 'visibleAfterLimit' | 'alwaysHidden'
type EmbedSettings = {
  enabled: boolean
  counter: Counter
  warningBanner: boolean
  limitBanner: boolean
  upgradeButton: boolean
  history: boolean
  /** The updated Spotter experience (Spotter 3, ThoughtSpot 26.11). */
  spotter3: boolean
}
const EMBED_DEFAULTS: EmbedSettings = { enabled: true, counter: 'alwaysVisible', warningBanner: true, limitBanner: true, upgradeButton: true, history: true, spotter3: true }

const COUNTER_MODES: { value: Counter; label: string; mode: SpotterUsageCounterDisplayMode }[] = [
  { value: 'alwaysVisible', label: 'Always visible', mode: SpotterUsageCounterDisplayMode.AlwaysVisible },
  { value: 'visibleAfterWarning', label: 'After the warning', mode: SpotterUsageCounterDisplayMode.VisibleAfterWarning },
  { value: 'visibleAfterLimit', label: 'After the limit', mode: SpotterUsageCounterDisplayMode.VisibleAfterLimit },
  { value: 'alwaysHidden', label: 'Hidden', mode: SpotterUsageCounterDisplayMode.AlwaysHidden },
]

type Tab = 'scenario' | 'settings' | 'code' | 'log'
type SnippetId = 'embed' | 'wording' | 'upgrade' | 'provision' | 'monitor' | 'reset' | 'unmeter'

/** The sidebar footer's "Best practices" link: a vendor doc link the app doesn't need. */
const HIDDEN_SPOTTER_ACTIONS = [Action.SpotterDocs]

/** `?stringids` shows ThoughtSpot's string IDs inside the embed, to find the ID of the limit banner's text. */
const SHOW_STRING_IDS = new URLSearchParams(window.location.search).has('stringids')

const DOCS_ROOT = 'https://developers.thoughtspot.com/docs'
/** The ThoughtSpot developer docs behind this page, shown under the presenter panel. */
const DOCS: { label: string; href: string; hint: string }[] = [
  { label: 'Guide', href: `${DOCS_ROOT}/spotter-usage-limits`, hint: 'Manage Spotter usage limits: scopes, pools, banners, counter, upgrade flow' },
  { label: 'Usage API', href: `${DOCS_ROOT}/spotter-usage-data-api`, hint: 'REST v2 endpoints under /ai/usage-data' },
  { label: 'Embed config', href: `${DOCS_ROOT}/Interface_SpotterUsageLimitConfig`, hint: 'SpotterUsageLimitConfig: isEnabled, banners, upgrade button, counter mode' },
  { label: 'Events', href: `${DOCS_ROOT}/Enumeration_EmbedEvent#_spotterusagelimitupgrade`, hint: 'EmbedEvent.SpotterUsageLimitUpgrade and SpotterResponseComplete' },
  { label: 'Styling', href: `${DOCS_ROOT}/customize-spotter-embed`, hint: 'Customizing the Spotter embed: CSS variables, text strings, chat history sidebar' },
]

const PANEL_MIN = 0.25
const PANEL_MAX = 0.7
/** The panel's default share of the page: a third, as first designed. */
const PANEL_DEFAULT = 0.33

const warningFor = (limit: number) => Math.round(limit * 0.8)
const loadSettings = (): EmbedSettings => {
  try {
    return { ...EMBED_DEFAULTS, ...JSON.parse(localStorage.getItem('storeloom.spotter.embed') ?? '{}') }
  } catch {
    return EMBED_DEFAULTS
  }
}

type UpgradeEvent = { at: number; usageCount: number; usageLimit: number; status: string }

export function SpotterLimitsDemo() {
  const embedRef = useEmbedRef<typeof SpotterEmbed>()
  const upgrade = useUpgrade()
  const usage = useUsage()
  // This page reads and writes the real usage pool and mirrors it into the demo's plan badge. Leaving puts the
  // simulated plan and question count back exactly as they were on arrival, so the rest of the demo is unaffected.
  const arrival = useRef(usageStore.get())
  useEffect(() => {
    const before = arrival.current
    return () => usageStore.set(before)
  }, [])
  const [frameRef, frameHeight] = useFillHeight<HTMLDivElement>(560, 16)

  const [settings, setSettings] = useState(loadSettings)
  const [panelOpen, setPanelOpen] = useState(true)
  /** The presenter panel's share of the page width; drag its left edge to change it. */
  const [panelShare, setPanelShare] = useState(() => {
    try {
      const n = Number(localStorage.getItem('storeloom.spotter.panel.v2'))
      return n >= PANEL_MIN && n <= PANEL_MAX ? n : PANEL_DEFAULT
    } catch {
      return PANEL_DEFAULT
    }
  })
  const bodyRef = useRef<HTMLDivElement>(null)
  const resize = (share: number) => {
    const next = Math.min(PANEL_MAX, Math.max(PANEL_MIN, share))
    setPanelShare(next)
    try {
      localStorage.setItem('storeloom.spotter.panel.v2', String(next))
    } catch {
      // Private mode: it still applies for this visit.
    }
  }
  const startDrag = (e: React.PointerEvent<HTMLDivElement>) => {
    const body = bodyRef.current
    if (!body) return
    e.preventDefault()
    // The iframe would swallow the pointer: let the page, not the embed, receive the drag.
    body.classList.add('is-dragging')
    const move = (ev: PointerEvent) => {
      const box = body.getBoundingClientRect()
      resize((box.right - ev.clientX) / box.width)
    }
    const up = () => {
      body.classList.remove('is-dragging')
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
  }
  const tabRef = useRef<Tab>('scenario')
  const [tab, setTab] = useState<Tab>('scenario')
  tabRef.current = tab
  const [snippet, setSnippet] = useState<SnippetId>('embed')
  const [userId, setUserId] = useState<string | null>(null)
  const [status, setStatus] = useState<UserUsage | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [calls, setCalls] = useState<ApiCall[]>([])
  const [events, setEvents] = useState<UpgradeEvent[]>([])
  /** Bumped when an embed-level setting changes: those are read once, when the embed loads. */
  const [embedKey, setEmbedKey] = useState(0)
  const [limitDraft, setLimitDraft] = useState('')
  const [usedDraft, setUsedDraft] = useState('')

  useEffect(() => onApiCall((c) => setCalls((all) => [c, ...all].slice(0, 40))), [])

  const poolKey: PoolKey | null = useMemo(() => (userId ? { entity_type: 'USER', entity_identifier: userId } : null), [userId])
  // An unmetered user comes back as an empty `pools` array with every total at 0.
  const metered = !!status && status.pools.length > 0
  const plan = PLANS[usage.plan]
  /** Usage is known (or can't be read): the embed waits for this so it never opens ahead of its limit. */
  const usageKnown = status !== null || error !== null

  // --- usage status ---------------------------------------------------------
  const refreshStatus = useCallback(async () => {
    try {
      const s = await getUserUsage()
      setStatus(s)
      setError(null)
      // The top bar's plan badge follows what ThoughtSpot says is left.
      usageStore.set({ enabled: s.pools.length > 0, used: s.total_usage, total: s.total_limit ?? Number.MAX_SAFE_INTEGER })
      return s
    } catch (err) {
      setError((err as Error).message)
      return null
    }
  }, [])

  useEffect(() => {
    let live = true
    // The embed and every usage call run as the dedicated demo user; leaving the page puts the signed-in user back.
    setEmbedPersona('spotter-demo')
    currentUserId()
      .then((id) => live && setUserId(id))
      .catch((err: Error) => live && setError(err.message))
    void refreshStatus()
    // No polling timer: the counter in the embed updates itself, and this page re-reads ThoughtSpot only when something
    // changed (an answer finished, below) or when the tab comes back into view.
    const onVisible = () => {
      if (document.visibilityState === 'visible') void refreshStatus()
    }
    document.addEventListener('visibilitychange', onVisible)
    return () => {
      live = false
      document.removeEventListener('visibilitychange', onVisible)
      clearTimeout(settleTimer.current)
      setEmbedPersona(undefined)
    }
  }, [refreshStatus])

  /** A finished answer is when a question has been counted: re-read the user's usage once, a moment later (answers can arrive in a burst). */
  const settleTimer = useRef<ReturnType<typeof setTimeout>>(undefined)
  const answered = useCallback(() => {
    clearTimeout(settleTimer.current)
    settleTimer.current = setTimeout(() => void refreshStatus(), 1200)
  }, [refreshStatus])
  const answeredRef = useRef(answered)
  answeredRef.current = answered
  /** Passed as the `onSpotterResponseComplete` prop, so it is registered when the embed is built (like the Upgrade listener). */
  const responseListener = useCallback(() => answeredRef.current(), [])

  /** Makes the embed re-read the pool (the host's job after changing it out of band). */
  const refreshEmbed = useCallback(() => {
    void embedRef.current?.trigger(HostEvent.SpotterRefreshUsageLimit).catch(() => {})
  }, [embedRef])

  /** Runs a step against ThoughtSpot, then refreshes the status and the embed. */
  const run = useCallback(
    async (label: string, show: SnippetId | null, step: () => Promise<unknown>) => {
      setBusy(label)
      if (show) setSnippet(show)
      try {
        await step()
        await refreshStatus()
        refreshEmbed()
      } catch (err) {
        setError(err instanceof UsageApiError ? err.message : (err as Error).message)
      } finally {
        setBusy(null)
      }
    },
    [refreshEmbed, refreshStatus],
  )

  const setPool = (limit: number | null, usageNow?: number) => {
    if (!poolKey) return Promise.resolve()
    return provisionUser(poolKey, {
      limit,
      warning_limit: limit === null ? undefined : warningFor(limit),
      usage: usageNow,
    })
  }

  // The plan in the demo's top bar and upgrade flow drives the pool's size: choosing a plan, or buying one, changes the limit.
  const syncedPlan = useRef<PlanId | null>(null)
  useEffect(() => {
    if (!poolKey || !status) return
    if (syncedPlan.current === null) {
      syncedPlan.current = usage.plan
      return
    }
    if (syncedPlan.current === usage.plan) return
    syncedPlan.current = usage.plan
    // A plan bought in the upgrade flow shouldn't move the viewer off the sample they are reading.
    void run(`Moving to ${PLANS[usage.plan].name}`, tabRef.current === 'code' ? null : 'provision', () => setPool(PLANS[usage.plan].questions, status.total_usage))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [usage.plan, poolKey, status === null])

  // --- scenarios (the demo script) -----------------------------------------
  const limit = plan.questions
  const scenario = (kind: 'fresh' | 'almost' | 'limit' | 'reset') => {
    if (limit === null) return
    const used = { fresh: Math.round(limit * 0.04), almost: limit - 3, limit, reset: 0 }[kind]
    void run(
      { fresh: 'Starting a fresh cycle', almost: 'Almost out of questions', limit: 'At the limit', reset: 'Resetting usage' }[kind],
      kind === 'reset' ? 'reset' : 'provision',
      () => setPool(limit, used),
    )
  }
  const choosePlan = (id: PlanId) => {
    // The effect above moves the pool.
    applyPlan(id)
  }
  const removePool = () => poolKey && run('Removing the pool', 'unmeter', () => deletePools([poolKey]))
  const applyCustom = () => {
    const l = Number(limitDraft)
    const u = usedDraft === '' ? undefined : Number(usedDraft)
    if (!Number.isFinite(l) || l <= 0) return setError('Enter a limit above 0.')
    void run('Applying your limit', 'provision', () => setPool(Math.round(l), u === undefined || !Number.isFinite(u) ? undefined : Math.round(u)))
  }

  // --- the embed ------------------------------------------------------------
  const change = (patch: Partial<EmbedSettings>) => {
    const next = { ...settings, ...patch }
    setSettings(next)
    setSnippet('embed')
    try {
      localStorage.setItem('storeloom.spotter.embed', JSON.stringify(next))
    } catch {
      // Private mode: the setting still applies for this visit.
    }
    setEmbedKey((k) => k + 1)
  }

  /** A value clicked in the embed sample: flips a switch, or steps the counter mode. */
  const toggleSetting = (key: string) => {
    if (key === 'counter') {
      const at = COUNTER_MODES.findIndex((c) => c.value === settings.counter)
      change({ counter: COUNTER_MODES[(at + 1) % COUNTER_MODES.length]!.value })
    } else if (key in EMBED_DEFAULTS) {
      change({ [key]: !settings[key as keyof EmbedSettings] } as Partial<EmbedSettings>)
    }
  }

  /** A new key remounts the embed when a setting changes. */
  const frameKey = String(embedKey)

  const onUpgrade = useRef<(e: UpgradeEvent) => void>(() => {})
  onUpgrade.current = (e) => {
    setEvents((all) => [e, ...all].slice(0, 10))
    setSnippet('upgrade')
    upgrade.open()
  }
  /**
   * The Upgrade button/link in the embed. Passed as the `onSpotterUsageLimitUpgrade` prop, so the SDK registers it when the embed
   * is built. (Attaching with embed.on() afterwards was timing dependent: after a remount the links did nothing.)
   */
  const upgradeListener = useCallback((payload: unknown) => {
    const d = payload as { data?: Partial<UpgradeEvent> } & Partial<UpgradeEvent>
    const data = d.data ?? d
    onUpgrade.current({ at: Date.now(), usageCount: data.usageCount ?? 0, usageLimit: data.usageLimit ?? 0, status: String(data.status ?? '') })
  }, [])

  const counter = COUNTER_MODES.find((c) => c.value === settings.counter)!
  // A question sent to the embed programmatically (SpotterSearch) isn't stopped by the usage limit, so the starter chips are off at the limit.
  const atLimit = !!status?.is_at_limit

  // --- render ---------------------------------------------------------------
  const left = status?.total_remaining
  const pct = status?.total_limit ? Math.min(100, (status.total_usage / status.total_limit) * 100) : 0
  const state = !metered ? 'off' : status?.is_at_limit ? 'limit' : status?.is_at_warning ? 'warn' : 'ok'

  return (
    <div className={panelOpen ? 'spg' : 'spg is-wide'}>
      <header className="spg-head">
        <div className="spg-title">
          <h1 className="spg-h1">Ask anything about your stores.</h1>
          <p>
            Questions run on Storeloom’s retail data. Every plan includes a set number of questions a month; the counter in the question bar shows what is left.
          </p>
        </div>
        <button type="button" className="btn-outline spg-toggle" aria-pressed={panelOpen} onClick={() => setPanelOpen((o) => !o)}>
          {panelOpen ? 'Hide presenter panel' : 'Presenter panel'}
        </button>
      </header>

      <div className="spg-chipsrow" aria-label="Starter questions">
        {SHUTTLE_SUGGESTIONS.map((s) => (
          <button
            key={s.q}
            type="button"
            disabled={atLimit}
            title={atLimit ? 'You have used every question on this plan' : s.q}
            // HostEvent.SpotterSearch sends the question into the open conversation.
            onClick={() => void embedRef.current?.trigger(HostEvent.SpotterSearch, { query: s.q, executeSearch: true }).catch(() => {})}
          >
            <span className="mono-label">{s.topic}</span> {s.q}
          </button>
        ))}
      </div>

      <div className="spg-body" ref={bodyRef} style={{ ["--spg-panel" as string]: `${panelShare * 100}%` }}>
        <div className="spg-frame" ref={frameRef} style={{ height: frameHeight }}>
          {usageKnown && (
          <SpotterEmbed
            key={frameKey}
            ref={embedRef}
            frameParams={{ width: '100%', height: '100%' }}
            style={{ height: '100%', width: '100%' }}
            worksheetId={RETAIL_MODEL_ID}
            // Spotter 3: the updated chat, and the 26.11 surface (which sends older clusters to the home page).
            {...(settings.spotter3 ? { updatedSpotterChatPrompt: true, spotterExperienceVersion: SpotterExperienceVersion.SPOTTER_2026_11 } : {})}
            hideSourceSelection
            // ?stringids on the URL shows each text's string ID (<text[id]>), for the stringIDs overrides in src/thoughtspot.ts.
            {...(SHOW_STRING_IDS ? { exposeTranslationIDs: true } : {})}
            hiddenActions={HIDDEN_SPOTTER_ACTIONS}
            {...{ onSpotterUsageLimitUpgrade: upgradeListener, onSpotterResponseComplete: responseListener }}
            hideSampleQuestions
            spotterSidebarConfig={{ enablePastConversationsSidebar: settings.history, spotterSidebarTitle: 'Chat history', spotterSidebarDefaultExpanded: false }}
            spotterUsageLimitConfig={{
              isEnabled: settings.enabled,
              isUpgradeButtonVisible: settings.upgradeButton,
              isWarningBannerEnabled: settings.warningBanner,
              isLimitBannerEnabled: settings.limitBanner,
              usageCounterDisplayMode: counter.mode,
            }}
          />
        )}
        </div>

        {panelOpen && (
          <aside className="spg-panel" aria-label="Presenter panel" style={{ maxHeight: frameHeight }}>
            <div className="spg-resize" role="separator" aria-orientation="vertical" aria-label="Resize the presenter panel" onPointerDown={startDrag} />
            <div className="spg-tabs" role="tablist">
              {(
                [
                  ['scenario', 'Scenario'],
                  ['settings', 'Settings'],
                  ['code', 'Code'],
                  ['log', `API log${calls.length ? ` · ${calls.length}` : ''}`],
                ] as [Tab, string][]
              ).map(([id, label]) => (
                <button key={id} type="button" role="tab" aria-selected={tab === id} className={tab === id ? 'is-on' : ''} onClick={() => setTab(id)}>
                  {label}
                </button>
              ))}
            </div>

            <div className="spg-scroll">
              <div className={`spg-status is-${state}`} aria-live="polite">
                <div className="spg-status-top">
                  <span className="mono-label">Your pool, from ThoughtSpot</span>
                  <button type="button" className="spg-link" onClick={() => void run('Refreshing', 'monitor', async () => {})}>
                    Refresh
                  </button>
                </div>
                {!status ? (
                  <strong>{error ? 'Not available' : 'Reading usage…'}</strong>
                ) : !metered ? (
                  <strong>Not metered · unlimited questions</strong>
                ) : (
                  <>
                    <strong>
                      {status.total_usage.toLocaleString('en-US')}
                      {status.has_unlimited_pool ? ' used · unlimited' : ` of ${(status.total_limit ?? 0).toLocaleString('en-US')} used`}
                    </strong>
                    {!status.has_unlimited_pool && (
                      <div className="spg-bar" aria-hidden>
                        <span style={{ width: `${pct}%` }} />
                      </div>
                    )}
                    <span className="spg-flags">
                      {status.is_at_limit ? 'At the limit: questions are blocked' : status.is_at_warning ? `Warning: ${left ?? 0} left` : left !== undefined ? `${left.toLocaleString('en-US')} left` : 'No cap'}
                    </span>
                  </>
                )}
              </div>

              {error && (
                <p className="spg-error" role="alert">
                  {error}
                </p>
              )}

              {tab === 'scenario' && (
                <div className="spg-section">
                  <h2 className="mono-label">Pricing plan</h2>
                  <div className="spg-plans" role="radiogroup" aria-label="Pricing plan">
                    {PLAN_ORDER.map((id) => (
                      <button key={id} type="button" role="radio" aria-checked={usage.plan === id} className={usage.plan === id ? 'is-on' : ''} onClick={() => choosePlan(id)}>
                        <strong>{PLANS[id].name}</strong>
                        <span>{formatQuestions(PLANS[id].questions)}</span>
                      </button>
                    ))}
                  </div>
                  <p className="spg-note">A plan is a usage pool: choosing one sets this user’s limit in ThoughtSpot.</p>

                  <h2 className="mono-label">Walk the customer through</h2>
                  <ol className="spg-steps">
                    <li>
                      <button type="button" disabled={!poolKey || !!busy || limit === null} onClick={() => scenario('fresh')}>
                        <b>1</b>
                        <span>
                          <strong>A healthy plan</strong>
                          <em>Counter in the question bar, plenty left</em>
                        </span>
                      </button>
                    </li>
                    <li>
                      <button type="button" disabled={!poolKey || !!busy || limit === null} onClick={() => scenario('almost')}>
                        <b>2</b>
                        <span>
                          <strong>Almost out</strong>
                          <em>3 left: the warning banner shows; ask a question</em>
                        </span>
                      </button>
                    </li>
                    <li>
                      <button type="button" disabled={!poolKey || !!busy || limit === null} onClick={() => scenario('limit')}>
                        <b>3</b>
                        <span>
                          <strong>At the limit</strong>
                          <em>Questions are blocked; the Upgrade button appears</em>
                        </span>
                      </button>
                    </li>
                    <li>
                      <button type="button" disabled={!!busy} onClick={() => upgrade.open()}>
                        <b>4</b>
                        <span>
                          <strong>Upgrade</strong>
                          <em>Opens Storeloom’s own checkout (what Upgrade does); a new plan raises the limit</em>
                        </span>
                      </button>
                    </li>
                    <li>
                      <button type="button" disabled={!poolKey || !!busy || limit === null} onClick={() => scenario('reset')}>
                        <b>5</b>
                        <span>
                          <strong>New billing cycle</strong>
                          <em>Reset usage to 0, keep the limit</em>
                        </span>
                      </button>
                    </li>
                  </ol>
                  {limit === null && <p className="spg-note">Enterprise is unlimited: pick Growth or Scale to step through the limits.</p>}
                  {busy && <p className="spg-note">{busy}…</p>}
                </div>
              )}

              {tab === 'settings' && (
                <div className="spg-section">
                  <h2 className="mono-label">In the embed</h2>
                  <p className="spg-note">Read when the embed loads: changing one reloads the conversation view.</p>
                  <Switch label="New Spotter experience (Spotter 3)" hint="updatedSpotterChatPrompt + spotterExperienceVersion (26.11+ clusters)" checked={settings.spotter3} onChange={(spotter3) => change({ spotter3 })} />
                  <Switch label="Usage limits" hint="spotterUsageLimitConfig.isEnabled" checked={settings.enabled} onChange={(enabled) => change({ enabled })} />
                  <label className="spg-field">
                    <span className="mono-label">Counter</span>
                    <select value={settings.counter} onChange={(e) => change({ counter: e.target.value as Counter })} disabled={!settings.enabled}>
                      {COUNTER_MODES.map((c) => (
                        <option key={c.value} value={c.value}>
                          {c.label}
                        </option>
                      ))}
                    </select>
                  </label>
                  <Switch label="Warning banner" hint="isWarningBannerEnabled" checked={settings.warningBanner} onChange={(warningBanner) => change({ warningBanner })} disabled={!settings.enabled} />
                  <Switch label="Limit banner" hint="isLimitBannerEnabled · questions stay blocked without it" checked={settings.limitBanner} onChange={(limitBanner) => change({ limitBanner })} disabled={!settings.enabled} />
                  <Switch label="Upgrade button" hint="isUpgradeButtonVisible" checked={settings.upgradeButton} onChange={(upgradeButton) => change({ upgradeButton })} disabled={!settings.enabled} />
                  <Switch label="Conversation history" hint="spotterSidebarConfig.enablePastConversationsSidebar" checked={settings.history} onChange={(history) => change({ history })} />

                  <h2 className="mono-label">The pool</h2>
                  <div className="spg-grid">
                    <label className="spg-field">
                      <span className="mono-label">Limit</span>
                      <input inputMode="numeric" placeholder={status?.total_limit?.toString() ?? '500'} value={limitDraft} onChange={(e) => setLimitDraft(e.target.value.replace(/\D/g, ''))} />
                    </label>
                    <label className="spg-field">
                      <span className="mono-label">Used</span>
                      <input inputMode="numeric" placeholder={status?.total_usage.toString() ?? '0'} value={usedDraft} onChange={(e) => setUsedDraft(e.target.value.replace(/\D/g, ''))} />
                    </label>
                  </div>
                  <div className="spg-actions">
                    <button type="button" className="btn-outline" disabled={!poolKey || !!busy || !limitDraft} onClick={applyCustom}>
                      Apply
                    </button>
                    <button type="button" className="btn-outline" disabled={!poolKey || !!busy || !metered} onClick={() => void removePool()}>
                      Remove the pool
                    </button>
                  </div>
                  <p className="spg-note">Pools are metered per user here; ThoughtSpot also supports user groups and orgs (one scope per cluster). The warning shows at 80%.</p>
                </div>
              )}

              {tab === 'code' && (
                <CodePanel
                  snippet={snippet}
                  onSnippet={setSnippet}
                  settings={settings}
                  counter={counter.value}
                  limit={status?.total_limit ?? limit ?? 500}
                  userId={userId ?? '{user-guid}'}
                  events={events}
                  onToggle={toggleSetting}
                />
              )}

              {tab === 'log' && <ApiLog calls={calls} onClear={() => setCalls([])} />}
            </div>

            <footer className="spg-docs" aria-label="Documentation">
              <span className="mono-label">Docs</span>
              {DOCS.map((d) => (
                <a key={d.href} href={d.href} target="_blank" rel="noopener noreferrer" title={d.hint}>
                  {d.label}
                </a>
              ))}
            </footer>
          </aside>
        )}
      </div>

    </div>
  )
}

function Switch({ label, hint, checked, onChange, disabled }: { label: string; hint: string; checked: boolean; onChange: (v: boolean) => void; disabled?: boolean }) {
  return (
    <label className={disabled ? 'spg-switch is-disabled' : 'spg-switch'}>
      <span>
        <strong>{label}</strong>
        <em>{hint}</em>
      </span>
      <input type="checkbox" role="switch" checked={checked} disabled={disabled} onChange={(e) => onChange(e.target.checked)} />
    </label>
  )
}

// ---------------------------------------------------------------------------
// Code samples, written from the page's current settings.
// ---------------------------------------------------------------------------

const SNIPPETS: { id: SnippetId; label: string; blurb: string }[] = [
  { id: 'embed', label: 'Embed', blurb: 'Turn on usage limits in the embed and choose what end users see.' },
  { id: 'wording', label: 'Wording', blurb: 'The banner and Upgrade text have string IDs you can override; the standard CSS variables carry your colors.' },
  { id: 'provision', label: 'Set a limit', blurb: 'From your backend: give a user, group or org a pool of questions.' },
  { id: 'monitor', label: 'Monitor', blurb: 'Read what a user has used and what is left.' },
  { id: 'upgrade', label: 'Upgrade', blurb: 'The Upgrade button emits an event; you run billing, then raise the limit and refresh.' },
  { id: 'reset', label: 'New cycle', blurb: 'ThoughtSpot never resets usage on its own: reset each pool on your billing cycle.' },
  { id: 'unmeter', label: 'Remove', blurb: 'Deleting a pool removes its limit: the user becomes unmetered, not blocked.' },
]

/** Marks the part of a sample that is specific to Spotter usage limits (shown highlighted). */
const HL = (code: string) => `${HL_OPEN}${code}${HL_CLOSE}`
const HL_OPEN = '⟦'
/** A value the viewer can click to change: `key=text`, inside a highlight (usage-limit) or on its own (other embed options). */
const IX = (key: string, text: string) => `\u27ea${key}=${text}\u27eb`
const HX = (key: string, text: string) => HL(`@${key}=${text}`)
const HL_CLOSE = '⟧'

function snippetCode(id: SnippetId, o: { settings: EmbedSettings; counter: Counter; limit: number; userId: string }): { lang: string; code: string }[] {
  const mode = COUNTER_MODES.find((c) => c.value === o.counter)!.mode
  const modeName = Object.entries(SpotterUsageCounterDisplayMode).find(([, v]) => v === mode)?.[0] ?? 'AlwaysVisible'
  const key = `{ entity_type: 'USER', entity_identifier: '${o.userId}' }`
  const curlKey = `{"entity_type":"USER","entity_identifier":"${o.userId}"}`
  const host = THOUGHTSPOT_HOST
  const warn = warningFor(o.limit)
  const api = (path: string) => `${host}/api/rest/2.0${HL(`/ai/usage-data/${path}`)}`
  switch (id) {
    case 'embed':
      return [
        {
          lang: 'tsx · Visual Embed SDK 1.53+ · click a value to change it',
          code: `import { SpotterEmbed } from '@thoughtspot/visual-embed-sdk/react'
import { SpotterExperienceVersion, ${HL('SpotterUsageCounterDisplayMode')} } from '@thoughtspot/visual-embed-sdk'

<SpotterEmbed
  worksheetId="${RETAIL_MODEL_ID}"
  updatedSpotterChatPrompt={${IX('spotter3', String(o.settings.spotter3))}}${o.settings.spotter3 ? '\n  spotterExperienceVersion={SpotterExperienceVersion.SPOTTER_2026_11}  // 26.11+ only: older clusters redirect home' : ''}
  hideSourceSelection
  hideSampleQuestions
  spotterSidebarConfig={{
    enablePastConversationsSidebar: ${IX('history', String(o.settings.history))},
    spotterSidebarDefaultExpanded: false,
  }}
  ${HL('spotterUsageLimitConfig={{')}
    ${HL('isEnabled')}: ${HX('enabled', String(o.settings.enabled))},
    ${HL('usageCounterDisplayMode')}: SpotterUsageCounterDisplayMode.${HX('counter', modeName)},
    ${HL('isWarningBannerEnabled')}: ${HX('warningBanner', String(o.settings.warningBanner))},
    ${HL('isLimitBannerEnabled')}: ${HX('limitBanner', String(o.settings.limitBanner))},
    ${HL('isUpgradeButtonVisible')}: ${HX('upgradeButton', String(o.settings.upgradeButton))},
  ${HL('}}')}
/>`,
        },
      ]
    case 'provision':
      return [
        {
          lang: 'bash · REST v2, admin token',
          code: `curl -X POST '${api('update')}' \\
  -H 'Authorization: Bearer {ADMIN_TOKEN}' \\
  -H 'Content-Type: application/json' \\
  --data-raw '{"updates":[{
    "key": ${HL(curlKey)},
    ${HL(`"limit": ${o.limit}`)},
    ${HL(`"warning_limit": ${warn}`)}
  }]}'`,
        },
        {
          lang: 'ts · from your backend',
          code: `// A plan is a pool. A missing pool is created; omitted fields keep their value.
await fetch(\`\${TS_HOST}/api/rest/2.0${HL('/ai/usage-data/update')}\`, {
  method: 'POST',
  headers: { Authorization: \`Bearer \${adminToken}\`, 'Content-Type': 'application/json' },
  body: JSON.stringify({
    updates: [{ key: ${HL(key)}, ${HL(`limit: ${o.limit}`)}, ${HL(`warning_limit: ${warn}`)} }],
  }),
})`,
        },
      ]
    case 'monitor':
      return [
        {
          lang: 'bash · the demo user (no admin needed)',
          code: `curl '${api('user')}' \\
  -H 'Authorization: Bearer {USER_TOKEN}'

# → { "summary": { ${HL('"total_usage"')}: …, ${HL('"total_limit"')}: …, ${HL('"total_remaining"')}: …,
#                  ${HL('"is_at_warning"')}: false, ${HL('"is_at_limit"')}: false, ${HL('"has_unlimited_pool"')}: false,
#                  "pools": [ … ] } }`,
        },
        {
          lang: 'bash · every pool (admin)',
          code: `curl -X POST '${api('search')}' \\
  -H 'Authorization: Bearer {ADMIN_TOKEN}' -H 'Content-Type: application/json' \\
  --data-raw '{"keys":[${HL(curlKey)}]}'   # {} returns all pools`,
        },
      ]
    case 'wording':
      return [
        {
          lang: 'ts · init() · the banner text is yours',
          code: `init({
  // ...
  customizations: {
    content: {
      ${HL('stringIDs')}: {
        ${HL("'spotter.usageLimit.almostReachedMessage'")}: 'You are nearly out of questions this month.',
        ${HL("'spotter.usageLimit.reachedMessage'")}: 'You have used all your questions this month.',
        ${HL("'spotter.usageLimit.upgradePlan'")}: 'See plans',   // the Upgrade link (avoid apostrophes: they come out HTML-escaped)
      },
    },
    style: { customCSS: { variables: { '--ts-var-root-background': '#fffdf8' /* your colors */ } } },
  },
})`,
        },
        {
          lang: 'tsx · find the ID of any text',
          code: `// Renders every string as <text[id]> so you can copy the ID. For admins and developers only.
<SpotterEmbed ${HL('exposeTranslationIDs')} ... />    // on this page: add ?stringids to the URL`,
        },
      ]
    case 'upgrade':
      return [
        {
          lang: 'tsx · the Upgrade button',
          code: `embed.on(${HL('EmbedEvent.SpotterUsageLimitUpgrade')}, async ({ data }) => {
  // data: { ${HL('usageCount, usageLimit, status')}: ${HL("'withinLimit' | 'almostReached' | 'limitReached'")} }
  const bought = await openYourCheckout(data)      // your billing, not ThoughtSpot's
  if (!bought) return

  await fetch('/api/spotter/raise-limit', { method: 'POST' })  // your backend → ${HL('usage-data/update')}
  embed.trigger(${HL('HostEvent.SpotterRefreshUsageLimit')})            // the counter updates without a reload
})`,
        },
        {
          lang: 'ts · keep your own UI in sync, without polling',
          code: `// The counter inside the embed updates itself. For your own UI, re-read once per answer:
embed.on(${HL('EmbedEvent.SpotterResponseComplete')}, () => {
  fetch('/api/spotter/usage')   // your backend → GET ${HL('/ai/usage-data/user')}
})`,
        },
        {
          lang: 'ts · refresh with session-only overrides',
          code: `// Overrides last for the session and don't touch the stored pool.
embed.trigger(${HL('HostEvent.SpotterRefreshUsageLimit')}, {
  ${HL('isUpgradeButtonVisible: false')},   // e.g. the top plan has nothing to upgrade to
  ${HL('isUnlimited: false')},
})`,
        },
      ]
    case 'reset':
      return [
        {
          lang: 'bash · on each billing cycle',
          code: `curl -X POST '${api('update')}' \\
  -H 'Authorization: Bearer {ADMIN_TOKEN}' -H 'Content-Type: application/json' \\
  --data-raw '{"updates":[{"key":${HL(curlKey)},${HL('"usage":0')}}]}'   # omit "limit" to keep it`,
        },
      ]
    case 'unmeter':
      return [
        {
          lang: 'bash · delete the pool',
          code: `curl -X POST '${api('delete')}' \\
  -H 'Authorization: Bearer {ADMIN_TOKEN}' -H 'Content-Type: application/json' \\
  --data-raw '{"keys":[${HL(curlKey)}]}'

# Permanent. A recreated pool starts at 0. To make a user unlimited in a metered
# cluster, create their USER pool with no "limit".`,
        },
      ]
  }
}

function CodePanel({
  snippet,
  onSnippet,
  settings,
  counter,
  limit,
  userId,
  events,
  onToggle,
}: {
  snippet: SnippetId
  onSnippet: (id: SnippetId) => void
  settings: EmbedSettings
  counter: Counter
  limit: number
  userId: string
  events: UpgradeEvent[]
  onToggle: (key: string) => void
}) {
  const current = SNIPPETS.find((s) => s.id === snippet)!
  const blocks = snippetCode(snippet, { settings, counter, limit, userId })
  return (
    <div className="spg-section">
      <div className="spg-chips" role="tablist" aria-label="Code samples">
        {SNIPPETS.map((s) => (
          <button key={s.id} type="button" role="tab" aria-selected={snippet === s.id} className={snippet === s.id ? 'is-on' : ''} onClick={() => onSnippet(s.id)}>
            {s.label}
          </button>
        ))}
      </div>
      <p className="spg-note">{current.blurb}</p>
      <p className="spg-legend"><mark>Highlighted</mark> = specific to Spotter usage limits; the rest is your normal embed or REST setup.{snippet === 'embed' && ' Underlined values are live: click one and the embed reloads with it.'}</p>
      {blocks.map((b) => (
        <CodeBlock key={b.lang} lang={b.lang} code={b.code} onToggle={snippet === 'embed' ? onToggle : undefined} />
      ))}
      {snippet === 'upgrade' && (
        <div className="spg-events">
          <h2 className="mono-label">Upgrade events received</h2>
          {events.length === 0 ? (
            <p className="spg-note">None yet. Reach the limit, then press Upgrade in the question bar.</p>
          ) : (
            events.map((e) => (
              <pre key={e.at} className="spg-code">
                {JSON.stringify({ usageCount: e.usageCount, usageLimit: e.usageLimit, status: e.status }, null, 2)}
              </pre>
            ))
          )}
        </div>
      )}
    </div>
  )
}

function CodeBlock({ lang, code, onToggle }: { lang: string; code: string; onToggle?: (key: string) => void }) {
  const [copied, setCopied] = useState(false)
  const plain = code
    .replace(/\u27ea[^=\u27eb]*=([^\u27eb]*)\u27eb/g, '$1')
    .replace(/\u27e6@[^=\u27e7]*=([^\u27e7]*)\u27e7/g, '$1')
    .replaceAll(HL_OPEN, '')
    .replaceAll(HL_CLOSE, '')
  // Pieces: plain text, ⟦usage-limit specific⟧ and ⟪other clickable value⟫. A highlight starting with @ is clickable too.
  const pieces = code.split(/(\u27e6[^\u27e7]*\u27e7|\u27ea[^\u27eb]*\u27eb)/)
  const value = (key: string, text: string, usage: boolean, at: number) =>
    onToggle ? (
      <button key={at} type="button" className={usage ? 'spg-ix is-usage' : 'spg-ix'} title="Click to change" onClick={() => onToggle(key)}>
        {text}
      </button>
    ) : usage ? (
      <mark key={at}>{text}</mark>
    ) : (
      text
    )
  return (
    <figure className="spg-codeblock">
      <figcaption>
        <span className="mono-label">{lang}</span>
        <button
          type="button"
          className="spg-link"
          onClick={() => {
            void navigator.clipboard?.writeText(plain).then(() => {
              setCopied(true)
              setTimeout(() => setCopied(false), 1500)
            })
          }}
        >
          {copied ? 'Copied' : 'Copy'}
        </button>
      </figcaption>
      <pre className="spg-code">
        <code>
          {pieces.map((piece, i) => {
            if (piece.startsWith('\u27ea')) {
              const [key, ...rest] = piece.slice(1, -1).split('=')
              return value(key!, rest.join('='), false, i)
            }
            if (piece.startsWith('\u27e6')) {
              const inner = piece.slice(1, -1)
              if (inner.startsWith('@')) {
                const [key, ...rest] = inner.slice(1).split('=')
                return value(key!, rest.join('='), true, i)
              }
              return <mark key={i}>{inner}</mark>
            }
            return piece
          })}
        </code>
      </pre>
    </figure>
  )
}

const clock = (at: number) => new Date(at).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', second: '2-digit' })

function ApiLog({ calls, onClear }: { calls: ApiCall[]; onClear: () => void }) {
  if (calls.length === 0) return <p className="spg-note">Calls to the usage-data APIs appear here as the demo makes them.</p>
  return (
    <div className="spg-section">
      <div className="spg-logbar">
        <span className="mono-label">
          {calls.length} {calls.length === 1 ? 'call' : 'calls'} · newest first
        </span>
        <button type="button" className="btn-outline spg-clear" onClick={onClear}>
          Clear log
        </button>
      </div>
      {calls.map((c) => (
        <details key={c.id} className="spg-call">
          <summary>
            <time dateTime={new Date(c.at).toISOString()}>{clock(c.at)}</time>
            <span className={c.status < 400 ? 'spg-ok' : 'spg-bad'}>{c.status}</span>
            <b>{c.method}</b>
            <span className="spg-path">{c.path.replace('/api/rest/2.0', '')}</span>
            <em>{c.ms} ms</em>
          </summary>
          {c.body !== undefined && <pre className="spg-code">{JSON.stringify(c.body, null, 2)}</pre>}
          <pre className="spg-code">{JSON.stringify(c.response, null, 2)}</pre>
        </details>
      ))}
    </div>
  )
}
