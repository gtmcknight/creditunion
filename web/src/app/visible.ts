/// Pollers wait while the tab is hidden (each checks document.hidden before it reads). On coming back, a poller looks
/// once at once rather than at its next tick. `alive` false: the page it served is gone, and so is the listener.
export function onReturn(look: () => unknown, alive: () => boolean) {
  const back = () => {
    if (!alive()) return document.removeEventListener('visibilitychange', back);
    if (document.visibilityState === 'visible') void look();
  };
  document.addEventListener('visibilitychange', back);
}
