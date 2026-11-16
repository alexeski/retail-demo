import { useMemo } from 'react'
import { Action } from '@thoughtspot/visual-embed-sdk'
import { FEATURE_ORDER, FEATURES, PLAN_ORDER, planHasFeature, planLabel, useGating, useUsage, type FeatureId, type PlanId } from './demoConfig'

// Which ThoughtSpot actions an embedded dashboard shows, by pricing plan.
//
// An allowlist (`visibleActions`): anything not named here is hidden, so the
// dashboards offer only what matters to the demo, and a ThoughtSpot upgrade
// can't surface new menu items unannounced. Features a plan doesn't include
// stay in the list but are also `disabledActions`, so they show greyed out as a
// reason to upgrade. (A disabled action can't be clicked: the upgrade flow
// opens from Storeloom's own buttons instead, see GatedButton.)

/** In every pricing plan: asking Shuttle, exploring and drilling, presenting. */
const ALWAYS: Action[] = [
  Action.AskAi,
  Action.AIHighlights,
  Action.Explore,
  Action.DrillDown,
  Action.DrillInclude,
  Action.DrillExclude,
  Action.CopyToClipboard,
  Action.ShowUnderlyingData,
  Action.CrossFilter,
  Action.RemoveCrossFilter,
  Action.AllLiveboardFilters,
  Action.Separator,
  Action.Present,
  Action.ToggleSize,
]

/** What each feature controls in ThoughtSpot. 'storeActions' is Storeloom's own (custom actions), so none. */
const GATED: Record<FeatureId, Action[]> = {
  export: [
    Action.Download,
    Action.DownloadAsPng,
    Action.DownloadAsCsv,
    Action.DownloadAsXlsx,
    Action.DownloadAsPdf,
    Action.DownloadLiveboard,
    Action.DownloadLiveboardAsContinuousPDF,
    Action.DownloadLiveboardAsA4Pdf,
    Action.DownloadLiveboardAsXlsx,
    Action.DownloadLiveboardAsCsv,
  ],
  // Copy link is left out of the allowlist altogether: hidden on every pricing plan.
  share: [Action.Share, Action.ShareViz],
  schedule: [Action.Schedule, Action.SchedulesList],
  storeActions: [],
  sync: [Action.SyncToSheets, Action.SyncToOtherApps, Action.SyncToSlack, Action.SyncToTeams, Action.ManagePipelines],
  spotiq: [Action.SpotIQAnalyze],
}

const VISIBLE: Action[] = [...ALWAYS, ...FEATURE_ORDER.flatMap((f) => GATED[f])]

/** The embed props for a pricing plan. `key` changes with them, to key the embed on (it re-renders with the new menus). */
export function actionPolicy(plan: PlanId, gating: boolean) {
  const locked = FEATURE_ORDER.filter((f) => !planHasFeature(plan, f, gating))
  const disabledActions = locked.flatMap((f) => GATED[f])
  // One tooltip for every disabled action: name the first pricing plan that opens things up.
  const next = locked.reduce<PlanId | null>((lowest, f) => {
    const needed = FEATURES[f].plan
    return lowest === null || PLAN_ORDER.indexOf(needed) < PLAN_ORDER.indexOf(lowest) ? needed : lowest
  }, null)

  return {
    key: `${plan}:${gating ? 'gated' : 'open'}`,
    props: {
      visibleActions: VISIBLE,
      ...(disabledActions.length
        ? {
            disabledActions,
            disabledActionReason: `Upgrade to the ${planLabel(next ?? plan)} (or higher) to unlock this.`,
          }
        : {}),
    },
  }
}

/** `actionPolicy` for the current pricing plan, stable until the plan or gating changes. */
export function useActionPolicy() {
  const { plan } = useUsage()
  const gating = useGating()
  return useMemo(() => actionPolicy(plan, gating), [plan, gating])
}
