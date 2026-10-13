import { useEffect } from 'react'
import { hotkeyStore, type KeyCombo } from './demoConfig'

// Hotkey phrases (set on /config): pressing a saved combo anywhere in the app
// types its phrase into the focused field and copies it to the clipboard, so a
// presenter can "type" long questions instantly. Ported from the HR demo.

const MODIFIER_CODES = new Set(['ControlLeft', 'ControlRight', 'MetaLeft', 'MetaRight', 'AltLeft', 'AltRight', 'ShiftLeft', 'ShiftRight'])

export const isModifierKey = (code: string) => MODIFIER_CODES.has(code)

/** KeyboardEvent.code (not .key): stable across layouts, e.g. ⌥1 turning .key into "¡" on macOS. */
export const comboFromEvent = (e: KeyboardEvent): KeyCombo => ({
  code: e.code,
  ctrlKey: e.ctrlKey,
  metaKey: e.metaKey,
  altKey: e.altKey,
  shiftKey: e.shiftKey,
})

/** A real modifier is required, so a hotkey never collides with normal typing. */
export const hasModifier = (c: KeyCombo) => c.ctrlKey || c.metaKey || c.altKey

export const combosEqual = (a: KeyCombo, b: KeyCombo) =>
  a.code === b.code && a.ctrlKey === b.ctrlKey && a.metaKey === b.metaKey && a.altKey === b.altKey && a.shiftKey === b.shiftKey

const isMac = () => /Mac|iPhone|iPad|iPod/.test(navigator.userAgent)

const CODE_LABELS: Record<string, string> = {
  Space: 'Space', Comma: ',', Period: '.', Slash: '/', Semicolon: ';', Quote: "'", BracketLeft: '[', BracketRight: ']',
  Backslash: '\\', Minus: '-', Equal: '=', Backquote: '`',
}

export function formatCombo(c: KeyCombo): string {
  const mac = isMac()
  const key = CODE_LABELS[c.code] ?? c.code.replace(/^Key|^Digit/, '')
  const parts = [
    c.ctrlKey && (mac ? '⌃' : 'Ctrl'),
    c.altKey && (mac ? '⌥' : 'Alt'),
    c.shiftKey && (mac ? '⇧' : 'Shift'),
    c.metaKey && (mac ? '⌘' : 'Win'),
    key,
  ].filter(Boolean)
  return parts.join(mac ? '' : '+')
}

/** A heads-up (not a block) for combos browsers or the OS usually own. */
export function reservedWarning(c: KeyCombo): string | null {
  const primaryOnly = (c.ctrlKey || c.metaKey) && !c.altKey
  return primaryOnly && /^(Digit[1-9]|Key[TWNRLQ])$/.test(c.code) ? 'This combo may collide with a browser shortcut.' : null
}

/** Inserts text at the caret of the focused field, in a way React-controlled inputs notice. */
function pasteIntoFocused(text: string) {
  const el = document.activeElement
  if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) {
    if (el.disabled || el.readOnly) return
    const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype
    const setValue = Object.getOwnPropertyDescriptor(proto, 'value')?.set
    const start = el.selectionStart ?? el.value.length
    const end = el.selectionEnd ?? el.value.length
    const next = el.value.slice(0, start) + text + el.value.slice(end)
    // The native setter, so React's tracked value changes, then a real input event.
    if (setValue) setValue.call(el, next)
    else el.value = next
    el.dispatchEvent(new Event('input', { bubbles: true }))
    const caret = start + text.length
    requestAnimationFrame(() => el.setSelectionRange?.(caret, caret))
  } else if (el instanceof HTMLElement && el.isContentEditable) {
    document.execCommand('insertText', false, text)
  }
}

/** Mount once (App): watches keydowns in the capture phase, so it wins over a field's own handling. */
export function useHotkeyListener() {
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (isModifierKey(e.code) || !hasModifier(comboFromEvent(e))) return
      // The /config recorder is capturing a new combo: let it have the keys.
      if (document.querySelector('[data-recording-hotkey]')) return
      const combo = comboFromEvent(e)
      const match = hotkeyStore.get().hotkeys.find((h) => combosEqual(h.combo, combo))
      if (!match) return
      e.preventDefault()
      navigator.clipboard?.writeText(match.phrase).catch(() => {})
      pasteIntoFocused(match.phrase)
    }
    window.addEventListener('keydown', onKeyDown, true)
    return () => window.removeEventListener('keydown', onKeyDown, true)
  }, [])
}
