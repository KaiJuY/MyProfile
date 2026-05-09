/**
 * Trailing-edge debounce. Returns a function that, after each call, waits `wait` ms
 * of silence before invoking `fn` once. Used for window resize.
 */
export function debounce<TArgs extends unknown[]>(
  fn: (...args: TArgs) => void,
  wait: number
): (...args: TArgs) => void {
  let timer: number | undefined;
  return (...args: TArgs) => {
    if (timer !== undefined) {
      window.clearTimeout(timer);
    }
    timer = window.setTimeout(() => {
      timer = undefined;
      fn(...args);
    }, wait);
  };
}

/**
 * Leading-edge throttle. Invokes `fn` immediately, then suppresses subsequent
 * calls for `wait` ms. Useful for scroll listeners that we don't want firing
 * 200x/second.
 */
export function throttle<TArgs extends unknown[]>(
  fn: (...args: TArgs) => void,
  wait: number
): (...args: TArgs) => void {
  let last = 0;
  return (...args: TArgs) => {
    const now = performance.now();
    if (now - last >= wait) {
      last = now;
      fn(...args);
    }
  };
}
