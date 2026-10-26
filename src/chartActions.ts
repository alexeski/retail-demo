import { Action, CustomActionsPosition, CustomActionTarget, type CustomAction } from '@thoughtspot/visual-embed-sdk'
import { HIDDEN_BRANDED_ACTIONS } from './thoughtspot'

// The ⋯ menu on the charts of a user's own dashboard. ThoughtSpot's own editing
// is hidden: a chart is edited in Studio's Search, which keeps it linked and
// writes edits back in place. Studio adds its own Edit and Remove items instead.

export const EDIT_CHART = 'storeloom-edit-chart'
export const REMOVE_CHART = 'storeloom-remove-chart'

/** ThoughtSpot's edit, copy-and-edit and delete, plus the vendor-branded actions. */
export const PINNED_CHART_HIDDEN_ACTIONS = [
  ...HIDDEN_BRANDED_ACTIONS,
  Action.Edit,
  Action.EditACopy,
  Action.CopyAndEdit,
  Action.DrillEdit,
  Action.Remove,
]

/** Code-based custom actions (SDK 1.43+, ThoughtSpot 10.14+), scoped to one dashboard's charts. */
export function chartMenu(liveboardId: string, items: { edit: string; remove?: string }): CustomAction[] {
  const scope = { metadataIds: { liveboardIds: [liveboardId] } }
  return [
    { id: EDIT_CHART, name: items.edit, position: CustomActionsPosition.MENU, target: CustomActionTarget.VIZ, ...scope },
    ...(items.remove
      ? [{ id: REMOVE_CHART, name: items.remove, position: CustomActionsPosition.MENU, target: CustomActionTarget.VIZ, ...scope }]
      : []),
  ]
}

type Chart = { id: string; name: string; created: number | null }

type ActionPayload = {
  id?: string
  vizId?: string
  data?: { id?: string; vizId?: string; embedAnswerData?: { name?: string; metadata?: { createdAt?: string } } }
}

/**
 * Which item was picked, on which of `charts`. A Liveboard's payload names the
 * chart's underlying Answer, not the tile, so when there's no `vizId` the tile is
 * the one with the same title, created at the same moment (titles can repeat).
 */
export function pickedChartAction(payload: unknown, charts: Chart[]): { action: string; vizId: string } | null {
  const p = (payload ?? {}) as ActionPayload
  const action = p.data?.id ?? p.id
  if (!action) return null
  const direct = p.data?.vizId ?? p.vizId
  if (direct) return { action, vizId: direct }
  const answer = p.data?.embedAnswerData
  const created = Number(answer?.metadata?.createdAt)
  const named = charts.filter((c) => c.name === answer?.name)
  const chart = named.find((c) => c.created === created) ?? (named.length === 1 ? named[0] : undefined)
  return chart ? { action, vizId: chart.id } : null
}
