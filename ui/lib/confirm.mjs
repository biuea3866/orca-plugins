// Two-step "click again to confirm" for the panel.
//
// The panel is a srcdoc iframe with sandbox="allow-scripts" (no allow-modals), so window.confirm() does nothing there
// and returns false: a delete button guarded by confirm() never deletes. Instead the first click arms the button
// (label changes), a second click within the timeout confirms, and the button disarms itself after the timeout.

const DEFAULT_TTL_MS = 4000

/**
 * @param {{ dataset: Record<string, string>, textContent: string, title: string }} button
 * @param {{ armedLabel?: string, message?: string, ttlMs?: number, onConfirm?: () => void, setTimer?: Function, clearTimer?: Function }} [options]
 * @returns {'armed' | 'confirmed'}
 */
export function armConfirm(button, { armedLabel = '정말 삭제', message = '', ttlMs = DEFAULT_TTL_MS, onConfirm, setTimer = setTimeout, clearTimer = clearTimeout } = {}) {
  if (button.dataset.armed === '1') {
    clearTimer(button.armTimer)
    restore(button)
    if (onConfirm) onConfirm()
    return 'confirmed'
  }
  button.dataset.armed = '1'
  button.armedFrom = { label: button.textContent, title: button.title }
  button.textContent = armedLabel
  button.title = message
  button.armTimer = setTimer(() => restore(button), ttlMs)
  return 'armed'
}

function restore(button) {
  if (button.dataset.armed !== '1') return
  button.dataset.armed = ''
  if (button.armedFrom) {
    button.textContent = button.armedFrom.label
    button.title = button.armedFrom.title
  }
  button.armedFrom = null
  button.armTimer = null
}
