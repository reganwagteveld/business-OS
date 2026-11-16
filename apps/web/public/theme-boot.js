// Applies the stored theme before first paint, so the splash and the app open in the theme the
// person chose on this device, not the OS one. Same key and classes as
// packages/app/src/shell/preferences.ts (`bos.theme`: 'light' | 'dark'; anything else follows the OS).
// A classic script from 'self', so the CSP needs no change. Keep identical in apps/web and apps/desktop.
(function () {
  try {
    var theme = globalThis.localStorage.getItem('bos.theme');
    if (theme === 'light' || theme === 'dark') globalThis.document.documentElement.classList.add(theme);
  } catch {
    /* storage blocked: follow the OS */
  }
})();
