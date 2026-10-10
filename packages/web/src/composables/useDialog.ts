import { nextTick, onUnmounted, watch, type Ref } from 'vue'

export function useDialog(element: Ref<HTMLElement | null>, isOpen: () => boolean, canClose: () => boolean, close: () => void) {
  let previousFocus: HTMLElement | null = null
  const focusableSelector = 'button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [href], [tabindex="0"]'

  function handleKey(event: KeyboardEvent) {
    if (!isOpen() || !element.value) return
    if (event.key === 'Escape' && canClose()) { event.preventDefault(); close() }
    if (event.key !== 'Tab') return
    const controls = Array.from(element.value.querySelectorAll<HTMLElement>(focusableSelector))
    const first = controls[0]
    const last = controls.at(-1)
    if (!first || !last) { event.preventDefault(); element.value.focus(); return }
    if (event.shiftKey && (document.activeElement === first || document.activeElement === element.value)) { event.preventDefault(); last.focus() }
    if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus() }
  }

  watch(isOpen, async open => {
    if (open) {
      previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null
      document.addEventListener('keydown', handleKey)
      await nextTick()
      element.value?.querySelector<HTMLElement>(focusableSelector)?.focus()
    } else {
      document.removeEventListener('keydown', handleKey)
      previousFocus?.focus()
    }
  }, { immediate: true })
  onUnmounted(() => document.removeEventListener('keydown', handleKey))
}
