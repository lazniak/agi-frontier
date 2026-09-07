/**
 * `virtual:paper` — the HTML of `docs/PAPER.md`, rendered by the Vite plugin in
 * `web/vite.config.ts` at build time (and re-read on change in dev). Nothing markdown-related
 * ships to the browser.
 */
declare module 'virtual:paper' {
  const html: string;
  export default html;
}
