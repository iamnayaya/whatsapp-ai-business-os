import type { DashboardData } from '../../../../packages/analytics/src';
import { brand, brandCssVars, faviconDataUri } from '../../../../packages/shared/src';

const FONTS = `<link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin><link rel="stylesheet" href="${brand.fonts.googleStylesheet}">`;

const FAVICON = `<link rel="icon" type="image/svg+xml" href="${faviconDataUri()}">`;

const LOGO_IMG = '<img src="/assets/nayaya-logo.png" alt="NAYAYA &amp; CO." class="brand-logo">';

const CSS = `
  :root {
    ${brandCssVars()}
    color-scheme: light;
  }
  * { box-sizing: border-box; }
  body { margin:0; font-family: var(--brand-sans); background: var(--brand-base); color: var(--brand-ink); }
  header { background: var(--brand-surface); border-bottom: 1px solid var(--brand-line); padding: 12px 22px; display:flex; align-items:center; justify-content: space-between; gap: 12px; }
  header .brand { display:flex; align-items:center; gap: 12px; }
  header .brand .brand-logo { height: 40px; width: auto; display: block; }
  header .brand-title { font-family: var(--brand-serif); font-size: 18px; color: var(--brand-primary); margin: 0; letter-spacing: .02em; }
  header .meta { color: var(--brand-muted); font-size: 13px; }
  main { max-width: 1080px; margin: 20px auto 60px; padding: 0 16px; }
  .cards { display:grid; grid-template-columns: repeat(auto-fit, minmax(200px, 1fr)); gap: 14px; margin-bottom: 20px; }
  .card { background: var(--brand-surface); border:1px solid var(--brand-line); border-radius: 10px; padding: 14px 16px; }
  .card .label { color: var(--brand-muted); font-size: 12px; text-transform: uppercase; letter-spacing: .04em; }
  .card .value { font-size: 26px; font-weight: 700; margin-top: 4px; font-family: var(--brand-serif); color: var(--brand-secondary); }
  .card .sub { color: var(--brand-muted); font-size: 12px; margin-top: 4px; }
  section { background: var(--brand-surface); border:1px solid var(--brand-line); border-radius: 10px; padding: 16px; margin-bottom: 20px; }
  section h2 { margin: 0 0 12px; font-size: 15px; font-family: var(--brand-serif); color: var(--brand-secondary); }
  table { width: 100%; border-collapse: collapse; font-size: 14px; }
  th, td { text-align: left; padding: 8px 10px; border-bottom: 1px solid var(--brand-line); }
  th { color: var(--brand-muted); font-size: 12px; text-transform: uppercase; letter-spacing: .03em; }
  tr:last-child td { border-bottom: none; }
  .bar { height: 8px; background: var(--brand-accent); border-radius: 4px; min-width: 2px; }
  .row { display:flex; align-items:center; gap:10px; margin-bottom: 8px; font-size: 13px; }
  .row .hour { width: 64px; color: var(--brand-muted); }
  .row .track { flex:1; background: var(--brand-base); border-radius: 4px; }
  .chip { display:inline-block; padding: 2px 10px; border-radius: 999px; font-size: 12px; font-weight: 600; }
  .chip.positive { color: var(--brand-positive); background: var(--brand-positive-bg); }
  .chip.neutral { color: var(--brand-neutral); background: var(--brand-neutral-bg); }
  .chip.frustrated { color: var(--brand-frustrated); background: var(--brand-frustrated-bg); }
  .chip.none { color: var(--brand-muted); background: var(--brand-base); }
  .grid2 { display:grid; grid-template-columns: 1fr 1fr; gap: 20px; }
  @media (max-width: 760px) { .grid2 { grid-template-columns: 1fr; } }
  .muted { color: var(--brand-muted); }
  .login { max-width: 340px; margin: 90px auto; background: var(--brand-surface); border:1px solid var(--brand-line); border-radius: 12px; padding: 26px; }
  .login .brand .brand-logo { height: 56px; width: auto; display: block; margin: 0 auto 14px; }
  .login h1 { font-family: var(--brand-serif); font-size: 18px; margin: 0 0 4px; color: var(--brand-secondary); text-align:center; }
  .login p { color: var(--brand-muted); font-size: 13px; margin: 0 0 18px; text-align:center; }
  .login input { width: 100%; padding: 10px; border:1px solid var(--brand-line); border-radius: 8px; font-size: 14px; margin-bottom: 12px; background: var(--brand-base); color: var(--brand-ink); }
  .login button { width: 100%; padding: 10px; border:0; border-radius: 8px; background: var(--brand-primary); color: var(--brand-on-primary); font-size: 14px; font-weight: 600; cursor: pointer; font-family: var(--brand-sans); }
  .login button:hover { background: var(--brand-primary-hover); }
  .error { color: var(--brand-frustrated); font-size: 13px; margin-top: 10px; text-align:center; }
  a.logout { color: var(--brand-muted); font-size: 13px; text-decoration: none; }
  a.logout:hover { color: var(--brand-ink); }
  form.logout-form { display: inline; margin: 0; }
  button.logout { color: var(--brand-muted); font-size: 13px; text-decoration: none; background: none; border: 0; padding: 0; cursor: pointer; font-family: inherit; }
  button.logout:hover { color: var(--brand-ink); }
`;

function escapeHtml(value: string | null | undefined): string {
  if (value === null || value === undefined) return '';
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function formatMoney(n: number, currency = 'NGN'): string {
  try {
    return new Intl.NumberFormat('en-NG', { style: 'currency', currency, maximumFractionDigits: 0 }).format(n);
  } catch {
    return `${currency} ${n.toFixed(2)}`;
  }
}

function percent(rate: number): string {
  return `${Math.round(rate * 100)}%`;
}

function sentimentChip(sentiment: string | null): string {
  if (sentiment === 'POSITIVE') return '<span class="chip positive">Positive</span>';
  if (sentiment === 'FRUSTRATED') return '<span class="chip frustrated">Frustrated</span>';
  if (sentiment === 'NEUTRAL') return '<span class="chip neutral">Neutral</span>';
  return '<span class="chip none">—</span>';
}

function relativeTime(date: Date | null): string {
  if (!date) return '—';
  const diff = Date.now() - date.getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days}d ago`;
  return date.toISOString().slice(0, 10);
}

function truncate(text: string | null, max = 70): string {
  if (!text) return '—';
  const clean = text.replace(/\s+/g, ' ').trim();
  return clean.length > max ? `${clean.slice(0, max)}…` : clean;
}

export function renderLogin(error?: string): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
${FAVICON}
${FONTS}
<title>Owner Dashboard — Sign in</title>
<style>${CSS}</style>
</head>
<body>
<form class="login" method="post" action="/admin/login">
  <div class="brand">${LOGO_IMG}</div>
  <h1>Owner Dashboard</h1>
  <p>Internal use only. Sign in to view the daily 2-minute check.</p>
  <input type="password" name="password" placeholder="Password" autofocus autocomplete="current-password">
  <button type="submit">Sign in</button>
  ${error ? `<div class="error">${escapeHtml(error)}</div>` : ''}
</form>
</body>
</html>`;
}

export function renderDashboard(data: DashboardData, businessName: string): string {
  const generatedAt = data.generatedAt.toISOString();
  const salesCards = data.sales
    .map(
      (b) => `<div class="card"><div class="label">Sales — ${b.label}</div><div class="value">${formatMoney(b.revenue)}</div><div class="sub">${b.orders} order${b.orders === 1 ? '' : 's'}</div></div>`,
    )
    .join('');

  const topProducts = data.topProducts.length
    ? `<table><thead><tr><th>#</th><th>Product</th><th style="text-align:right">Units</th><th style="text-align:right">Revenue</th></tr></thead><tbody>${data.topProducts
        .map(
          (p, i) =>
            `<tr><td>${i + 1}</td><td>${escapeHtml(p.name)}</td><td style="text-align:right">${p.quantity}</td><td style="text-align:right">${formatMoney(p.revenue)}</td></tr>`,
        )
        .join('')}</tbody></table>`
    : '<p class="muted">No paid orders yet.</p>';

  const maxHour = Math.max(1, ...data.peakHours.map((h) => h.count));
  const peakHours = data.peakHours.length
    ? data.peakHours
        .map(
          (h) =>
            `<div class="row"><span class="hour">${String(h.hour).padStart(2, '0')}:00</span><span class="track"><div class="bar" style="width:${Math.round((h.count / maxHour) * 100)}%"></div></span><span>${h.count}</span></div>`,
        )
        .join('')
    : '<p class="muted">No inbound messages in the last 30 days.</p>';

  const recovery = data.recovery
    .map(
      (r) =>
        `<tr><td>${r.type === 'OVERALL' ? 'Overall' : r.type === 'CART' ? 'Cart nudges' : 'Payment nudges'}</td><td>${r.sent}</td><td>${r.recovered}</td><td><strong>${percent(r.rate)}</strong></td></tr>`,
    )
    .join('');

  const escalations = data.escalations;
  const escalationCats = Object.entries(escalations.byCategory)
    .map(([cat, n]) => `<tr><td>${escapeHtml(cat)}</td><td>${n}</td></tr>`)
    .join('');

  const recent = data.recentConversations.length
    ? `<table><thead><tr><th>Customer</th><th>Last message</th><th>When</th><th>Sentiment</th></tr></thead><tbody>${data.recentConversations
        .map(
          (c) =>
            `<tr><td>${escapeHtml(c.name ?? c.waId)}</td><td>${escapeHtml(truncate(c.lastInbound))}</td><td>${relativeTime(c.lastMessageAt)}</td><td>${sentimentChip(c.sentiment)}</td></tr>`,
        )
        .join('')}</tbody></table>`
    : '<p class="muted">No conversations yet.</p>';

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="refresh" content="120">
${FAVICON}
${FONTS}
<title>Owner Dashboard — ${escapeHtml(businessName)}</title>
<style>${CSS}</style>
</head>
<body>
<header>
  <div class="brand">
    ${LOGO_IMG}
    <span class="brand-title">Owner Dashboard</span>
  </div>
  <div class="meta">Updated ${generatedAt} · <form class="logout-form" method="post" action="/admin/logout"><button type="submit" class="logout">Sign out</button></form></div>
</header>
<main>
  <div class="cards">${salesCards}
    <div class="card"><div class="label">Conversion rate</div><div class="value">${percent(data.conversion.rate)}</div><div class="sub">${data.conversion.converted} paid of ${data.conversion.chatted} chatted (this month)</div></div>
  </div>
  <div class="grid2">
    <section>
      <h2>Top-selling products</h2>
      ${topProducts}
    </section>
    <section>
      <h2>Peak conversation hours (30d)</h2>
      ${peakHours}
    </section>
  </div>
  <div class="grid2">
    <section>
      <h2>Abandoned cart recovery</h2>
      <table><thead><tr><th>Nudge type</th><th>Sent</th><th>Recovered</th><th>Rate</th></tr></thead><tbody>${recovery}</tbody></table>
    </section>
    <section>
      <h2>Escalations this month</h2>
      <table>
        <tbody>
          <tr><td>Total</td><td><strong>${escalations.total}</strong></td></tr>
          <tr><td>Open (awaiting you)</td><td><strong>${escalations.open}</strong></td></tr>
          <tr><td>Angry customers</td><td><strong>${escalations.angry}</strong></td></tr>
          <tr><td>Refund requests</td><td><strong>${escalations.refundRequests}</strong></td></tr>
        </tbody>
      </table>
      ${escalationCats ? `<table><thead><tr><th>Category</th><th>Count</th></tr></thead><tbody>${escalationCats}</tbody></table>` : ''}
    </section>
  </div>
  <section>
    <h2>Recent conversations</h2>
    ${recent}
  </section>
</main>
</body>
</html>`;
}