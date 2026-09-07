/**
 * `/paper.html` — `docs/PAPER.md` rendered at build time.
 *
 * The markdown is turned into HTML by a Vite plugin (`virtual:paper`, see `vite.config.ts`), so
 * no markdown parser ships to the browser. This module only mounts it, gives every heading a
 * stable id, builds the sticky table of contents, keeps the current section marked while you
 * scroll, and wraps wide tables so a phone scrolls them instead of the page.
 */
import '@fontsource-variable/jost';
import './styles/base.css';
import './styles/layout.css';
import './styles/paper.css';

import html from 'virtual:paper';
import { clear, el, maybe, qsa } from './dom';

/** `3.1 One scale for every benchmark` → `one-scale-for-every-benchmark` */
function slug(text: string): string {
  return (
    text
      .toLowerCase()
      .replace(/[‘’“”]/g, '')
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '') || 'section'
  );
}

function mount(): void {
  const host = maybe('[data-paper-body]');
  if (!host) return;
  host.innerHTML = html;

  /* --------------------------------------------------------------- headings */
  const seen = new Set<string>();
  // The h2 straight after the h1 is the paper's subtitle, not a section — it belongs on the page
  // but not in the contents.
  const headings = qsa<HTMLHeadingElement>('h2, h3', host).filter(
    (h) => !(h.tagName === 'H2' && h.previousElementSibling?.tagName === 'H1'),
  );
  for (const h of headings) {
    let id = slug(h.textContent ?? '');
    let n = 2;
    while (seen.has(id)) id = `${slug(h.textContent ?? '')}-${n++}`;
    seen.add(id);
    h.id = id;
  }

  /* ---------------------------------------------------------- external links */
  for (const a of qsa<HTMLAnchorElement>('a[href^="http"]', host)) {
    a.rel = 'noopener';
    a.target = '_blank';
  }

  /* --------------------------------------------------- tables scroll, not page */
  for (const table of qsa<HTMLTableElement>('table', host)) {
    if (table.parentElement?.classList.contains('paper__table')) continue;
    const wrap = el('div', { class: 'paper__table' });
    table.replaceWith(wrap);
    wrap.append(table);
  }

  /* ------------------------------------------------------------------- toc */
  const toc = maybe<HTMLOListElement>('[data-paper-toc]');
  if (!toc) return;
  clear(toc);
  const links = new Map<string, HTMLAnchorElement>();
  // This paper's sections are `###`, so "top level" is whatever the shallowest heading actually
  // is — hard-coding h2 would leave every entry marked as a sub-item (and hidden on a phone).
  const topLevel = Math.min(...headings.map((h) => Number(h.tagName.slice(1))));
  for (const h of headings) {
    const li = el('li', { class: Number(h.tagName.slice(1)) > topLevel ? 'paper-toc__sub' : 'paper-toc__top' });
    const a = el('a', { href: `#${h.id}`, text: h.textContent ?? '' });
    li.append(a);
    toc.append(li);
    links.set(h.id, a);
  }

  /* ------------------------------------------------------------- scrollspy */
  if (typeof IntersectionObserver !== 'function') return;
  let current = '';
  const visible = new Set<string>();
  const io = new IntersectionObserver(
    (entries) => {
      for (const e of entries) {
        const id = (e.target as HTMLElement).id;
        if (e.isIntersecting) visible.add(id);
        else visible.delete(id);
      }
      // The first heading still on screen, in document order, is "where you are".
      const next = headings.find((h) => visible.has(h.id))?.id ?? current;
      if (next === current) return;
      links.get(current)?.removeAttribute('aria-current');
      current = next;
      links.get(current)?.setAttribute('aria-current', 'true');
    },
    { rootMargin: '-72px 0px -68% 0px', threshold: 0 },
  );
  for (const h of headings) io.observe(h);
}

mount();
