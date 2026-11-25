/** Debug flag (hamburger "Debug" item): persisted + broadcast so open pages react. */

const KEY = "einring:debug";
export const DEBUG_EVENT = "einring-debug";

export function isDebug(): boolean {
  return localStorage.getItem(KEY) === "1";
}

export function toggleDebug(): boolean {
  const next = !isDebug();
  localStorage.setItem(KEY, next ? "1" : "0");
  window.dispatchEvent(new Event(DEBUG_EVENT));
  return next;
}
