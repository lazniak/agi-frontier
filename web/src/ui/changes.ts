/** "What changed" — the tail of the append-only audit log. */
import type { Ctx } from '../data';
import { clear, qs } from '../dom';
import { esc, fmtAgo, fmtTimestamp } from './format';

const KIND_LABEL: Record<string, string> = {
  release_added: 'release added',
  release_updated: 'release updated',
  score_added: 'score added',
  score_updated: 'score updated',
  status_changed: 'status changed',
  verified: 'verified',
};

export function renderChanges(ctx: Ctx, limit = 20): void {
  const host = qs('[data-changes]');
  clear(host);

  const rows = ctx.bundle.recent_changes.slice(0, limit);
  if (rows.length === 0) {
    const li = document.createElement('li');
    li.className = 'change';
    li.innerHTML = `<span class="change__at"></span><span class="change__lab"></span>
      <span class="change__summary">Nothing recorded yet — the audit log is empty.</span>`;
    host.append(li);
    return;
  }

  for (const ev of rows) {
    const lab = ctx.labs.get(ev.lab);
    const li = document.createElement('li');
    li.className = 'change';
    const link = ev.source_url
      ? ` <a href="${esc(ev.source_url)}" rel="noopener nofollow">source</a>`
      : '';
    li.innerHTML =
      `<time class="change__at" datetime="${esc(ev.at)}" title="${esc(fmtTimestamp(ev.at))}">${esc(fmtAgo(ev.at))}</time>` +
      `<span class="change__lab"><span class="rank-dot" style="background:${esc(lab?.color ?? '#111')}"></span>${esc(lab?.short ?? ev.lab)}</span>` +
      `<span class="change__summary">${esc(ev.summary)} <span class="badge badge--off">${esc(KIND_LABEL[ev.kind] ?? ev.kind)}</span>${link}</span>`;
    host.append(li);
  }
}
