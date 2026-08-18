// assets/tools.js
//
// Backs tools.html — real Search, AI Classify, and Landed Cost, calling the
// proxy's /web/* routes (see proxy-server/src/index.js). Those routes are
// intentionally secret-free (a client-side secret on a static site isn't
// one) and protected instead by CORS + per-IP rate limits server-side.

const API_BASE = 'https://tarifflogicx-africa-proxy-production.up.railway.app';

// Free-tier AI Classify tracking mirrors the app's device-based limit
// (FreemiumService) closely enough for a public demo — a random id
// persisted locally, not tied to identity. The real enforcement is the
// server's per-IP webClassifyLimiter; this id only lets the server's
// existing per-device FREE_AI_CALLS_PER_DAY counter work as designed.
function getDeviceId() {
  let id = localStorage.getItem('tlxa_web_device_id');
  if (!id) {
    id = 'web-' + crypto.randomUUID();
    localStorage.setItem('tlxa_web_device_id', id);
  }
  return id;
}

// ── Access token (admin login OR a redeemed Subscriber/Pro pass code) ──
// The token itself is only meaningful because the server re-verifies its
// signature on every request (see proxy-server auth.js) — storing it in
// localStorage is fine precisely because a *copy* of it is useless to
// anyone without also being able to forge a valid signature, unlike a
// plain "unlocked: true" flag would be. A redeemed code and an admin
// login are stored identically; the server tells us which one it was.
function getAccessToken() {
  const raw = localStorage.getItem('tlxa_access_token');
  if (!raw) return null;
  try {
    const { token, expiresAt } = JSON.parse(raw);
    if (Date.now() > expiresAt) { localStorage.removeItem('tlxa_access_token'); return null; }
    return token;
  } catch { return null; }
}
function hasAccess() { return getAccessToken() !== null; }
function accessHeaders() {
  const token = getAccessToken();
  return token ? { 'X-Access-Token': token } : {};
}
function storeAccessToken(token, expiresInMs) {
  localStorage.setItem('tlxa_access_token', JSON.stringify({ token, expiresAt: Date.now() + expiresInMs }));
}

const accessModal = document.getElementById('access-modal');
const accessLoggedInView = document.getElementById('access-logged-in-view');
const accessBuyView = document.getElementById('access-buy-view');
const accessRedeemView = document.getElementById('access-redeem-view');
const accessAdminView = document.getElementById('access-admin-view');
const redeemForm = document.getElementById('redeem-form');
const redeemError = document.getElementById('redeem-error');
const adminLoginForm = document.getElementById('admin-login-form');
const adminLoginError = document.getElementById('admin-login-error');
const buyError = document.getElementById('buy-error');

// Must match TIERS in proxy-server/src/routes/payfast.js exactly (label/price
// shown here is cosmetic only — the server is what actually enforces price).
const PRICING_TIERS = [
  { tier: '24h', label: '24-Hour Pro Pass', price: 'R36.00', sub: 'once-off' },
  { tier: '7d', label: '7-Day Pro Pass', price: 'R150.00', sub: 'once-off' },
  { tier: '14d', label: '14-Day Pro Pass', price: 'R300.00', sub: 'once-off' },
  { tier: 'individual_monthly', label: 'Subscriber — Individual', price: 'R540.00', sub: 'per month' },
  { tier: 'company_monthly', label: 'Subscriber — Company', price: 'R900.00', sub: 'per month' },
];

document.getElementById('buy-tiers').innerHTML = PRICING_TIERS.map((t) => `
  <div class="result-card" style="cursor:default; display:flex; align-items:center; justify-content:space-between; gap:10px; margin-top:8px;">
    <div>
      <div style="font-weight:600; font-size:13px;">${escapeHtml(t.label)}</div>
      <div class="hint" style="margin:0;">${escapeHtml(t.price)} ${escapeHtml(t.sub)}</div>
    </div>
    <button class="btn-primary" style="width:auto; padding:8px 16px; flex-shrink:0;" data-buy-tier="${t.tier}">Buy</button>
  </div>
`).join('');

function showAccessView(view) {
  accessLoggedInView.style.display = view === 'logged-in' ? 'block' : 'none';
  accessBuyView.style.display = view === 'buy' ? 'block' : 'none';
  accessRedeemView.style.display = view === 'redeem' ? 'block' : 'none';
  accessAdminView.style.display = view === 'admin' ? 'block' : 'none';
}

function refreshAccessModalView() {
  showAccessView(hasAccess() ? 'logged-in' : 'buy');
}

function openAccessModal() {
  redeemError.style.display = 'none';
  adminLoginError.style.display = 'none';
  buyError.style.display = 'none';
  refreshAccessModalView();
  accessModal.style.display = 'flex';
}

document.getElementById('access-link').addEventListener('click', (e) => { e.preventDefault(); openAccessModal(); });
document.getElementById('access-cancel-btn').addEventListener('click', () => { accessModal.style.display = 'none'; });
document.getElementById('admin-cancel-btn').addEventListener('click', () => { accessModal.style.display = 'none'; });
document.getElementById('buy-cancel-btn').addEventListener('click', () => { accessModal.style.display = 'none'; });
accessModal.addEventListener('click', (e) => { if (e.target === accessModal) accessModal.style.display = 'none'; });

document.getElementById('show-admin-login-link').addEventListener('click', (e) => { e.preventDefault(); showAccessView('admin'); });
document.getElementById('show-redeem-link').addEventListener('click', (e) => { e.preventDefault(); showAccessView('redeem'); });

document.getElementById('access-logout-btn').addEventListener('click', () => {
  localStorage.removeItem('tlxa_access_token');
  accessModal.style.display = 'none';
});

// ── Buy (PayFast) ────────────────────────────────────────────────────
document.getElementById('buy-tiers').addEventListener('click', async (e) => {
  const btn = e.target.closest('[data-buy-tier]');
  if (!btn) return;
  const email = document.getElementById('buy-email-input').value.trim();
  buyError.style.display = 'none';
  if (!email || !email.includes('@')) {
    buyError.textContent = 'Enter a valid email address first — PayFast sends your receipt there.';
    buyError.style.display = 'block';
    return;
  }
  btn.disabled = true;
  btn.textContent = 'Redirecting…';
  try {
    const res = await fetch(`${API_BASE}/web/payfast/initiate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ tier: btn.dataset.buyTier, email }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Could not start checkout.');
    // Build and auto-submit a real form POST — PayFast expects a form
    // submission (not a fetch/XHR body) so the buyer's browser actually
    // navigates to their hosted, secure payment page.
    const form = document.createElement('form');
    form.method = 'POST';
    form.action = data.action;
    Object.entries(data.fields).forEach(([k, v]) => {
      const input = document.createElement('input');
      input.type = 'hidden';
      input.name = k;
      input.value = v;
      form.appendChild(input);
    });
    document.body.appendChild(form);
    form.submit();
  } catch (err) {
    buyError.textContent = err.message || 'Something went wrong — try again.';
    buyError.style.display = 'block';
    btn.disabled = false;
    btn.textContent = 'Buy';
  }
});

// The app's TLXA3 promo (see freemium_service.dart) — a plain launch code,
// not a pre-signed token like admin-generated codes, so it needs its own
// server round-trip (POST /web/redeem-launch-code) to actually mint one,
// rather than being stored directly as if it already were a token.
const LAUNCH_CODE = 'TLXA3';

redeemForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  const code = document.getElementById('redeem-code-input').value.trim();
  redeemError.style.display = 'none';
  if (!code) {
    redeemError.textContent = 'Paste your access code first.';
    redeemError.style.display = 'block';
    return;
  }

  if (code.toUpperCase() === LAUNCH_CODE) {
    try {
      const res = await fetch(`${API_BASE}/web/redeem-launch-code`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ code, deviceId: getDeviceId() }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Could not redeem that code.');
      storeAccessToken(data.token, data.expiresInMs);
      document.getElementById('redeem-code-input').value = '';
      accessModal.style.display = 'none';
      if (typeof onAccessChanged === 'function') onAccessChanged();
    } catch (err) {
      redeemError.textContent = err.message || 'Could not redeem that code — try again.';
      redeemError.style.display = 'block';
    }
    return;
  }

  // Any other code IS the token itself (see webAdminLogin.js generate-code)
  // — nothing to look up server-side, just store it and let the next real
  // request prove whether it's valid (a garbage paste simply won't unlock
  // anything).
  storeAccessToken(code, 14 * 24 * 60 * 60 * 1000); // upper bound; server's own expiry inside the token is what actually governs
  document.getElementById('redeem-code-input').value = '';
  accessModal.style.display = 'none';
  if (typeof onAccessChanged === 'function') onAccessChanged();
});

adminLoginForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  const username = document.getElementById('admin-username').value.trim();
  const password = document.getElementById('admin-password').value;
  adminLoginError.style.display = 'none';
  try {
    const res = await fetch(`${API_BASE}/web/admin/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password }),
    });
    const data = await res.json();
    if (!res.ok || !data.granted) throw new Error(data.error || 'Login failed.');
    storeAccessToken(data.token, data.expiresInMs);
    document.getElementById('admin-password').value = '';
    accessModal.style.display = 'none';
    if (typeof onAccessChanged === 'function') onAccessChanged();
  } catch (err) {
    adminLoginError.textContent = err.message || 'Login failed — try again.';
    adminLoginError.style.display = 'block';
  }
});

// ── PayFast return handling ──────────────────────────────────────────
// After paying (or cancelling), PayFast redirects the browser back here.
// The redirect itself proves nothing (no payment proof attached) — the
// real confirmation is the separate server-to-server ITN webhook, which
// may arrive slightly before or after this redirect. So: poll the status
// endpoint for a few seconds rather than trusting the URL alone.
async function handlePayfastReturn() {
  const params = new URLSearchParams(location.search);
  if (params.get('payfast_cancelled') === '1') {
    openAccessModal();
    buyError.textContent = 'Checkout was cancelled — no payment was made.';
    buyError.style.display = 'block';
    return;
  }
  const paymentId = params.get('m_payment_id');
  if (params.get('payfast_return') !== '1' || !paymentId) return;

  openAccessModal();
  showAccessView('buy');
  buyError.style.display = 'none';
  const banner = document.createElement('div');
  banner.className = 'loading-row';
  banner.innerHTML = '<span class="spinner"></span> Confirming your payment…';
  accessBuyView.prepend(banner);

  const deadline = Date.now() + 30000;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${API_BASE}/web/payfast/status/${encodeURIComponent(paymentId)}`);
      const data = await res.json();
      if (data.status === 'complete') {
        storeAccessToken(data.token, data.expiresInMs);
        banner.remove();
        refreshAccessModalView();
        if (typeof onAccessChanged === 'function') onAccessChanged();
        return;
      }
    } catch { /* keep polling */ }
    await new Promise((r) => setTimeout(r, 2000));
  }
  banner.remove();
  buyError.textContent = "Payment is taking longer than expected to confirm. If you completed checkout, this should unlock within a minute — try Redeem/refresh shortly, or contact support if it doesn't.";
  buyError.style.display = 'block';
}

// ── Tabs ──────────────────────────────────────────────────────────────
function showTab(name) {
  document.querySelectorAll('.tab-panel').forEach((p) => p.classList.toggle('active', p.dataset.tab === name));
  document.querySelectorAll('.tab-btn').forEach((b) => b.classList.toggle('active', b.dataset.tab === name));
  window.scrollTo({ top: document.querySelector('.tab-bar').offsetTop - 1, behavior: 'smooth' });
}
document.querySelectorAll('.tab-btn').forEach((btn) => {
  btn.addEventListener('click', () => showTab(btn.dataset.tab));
});

function fmtR(v) {
  return 'R ' + v.toFixed(2).replace(/\d(?=(\d{3})+\.)/g, '$&,');
}

function dutyDisplay(code) {
  const formula = (code.duty_formula || '').trim();
  if (!formula) return (!code.general_duty) ? 'Free' : `${code.general_duty.toFixed(0)}%`;
  if (formula.toLowerCase() === 'free') return 'Free';
  return formula;
}

// ══════════════════════════════════════════════════════════════════════
// FAVOURITES — client-side only (localStorage), mirrors the app's
// Favourites screen closely enough for a public demo: no account, just
// saved on this device/browser.
// ══════════════════════════════════════════════════════════════════════
function getFavourites() {
  try { return JSON.parse(localStorage.getItem('tlxa_favourites') || '[]'); } catch { return []; }
}
function isFavourited(hsCode) {
  return getFavourites().some((f) => f.hs_code === hsCode);
}
function toggleFavourite(code) {
  const favs = getFavourites();
  const idx = favs.findIndex((f) => f.hs_code === code.hs_code);
  if (idx >= 0) { favs.splice(idx, 1); }
  else { favs.unshift({ hs_code: code.hs_code, description: code.description, general_duty: code.general_duty, duty_formula: code.duty_formula, vat_applicable: code.vat_applicable, permit_required: code.permit_required, permit_authority: code.permit_authority }); }
  localStorage.setItem('tlxa_favourites', JSON.stringify(favs));
  return idx < 0; // true if now favourited
}
function starBtnHtml(hsCode) {
  const on = isFavourited(hsCode);
  return `<button type="button" class="fav-star ${on ? 'is-fav' : ''}" data-fav-code="${escapeHtml(hsCode)}" aria-label="Toggle favourite" title="Save to Favourites">${on ? '★' : '☆'}</button>`;
}
// Delegated click handler so it works for cards rendered anywhere/anytime.
document.addEventListener('click', (e) => {
  const btn = e.target.closest('.fav-star');
  if (!btn) return;
  e.stopPropagation();
  const hsCode = btn.dataset.favCode;
  const cached = getFavourites().find((f) => f.hs_code === hsCode);
  const nowOn = toggleFavourite(cached || { hs_code: hsCode, description: btn.dataset.favDesc || '' });
  document.querySelectorAll(`.fav-star[data-fav-code="${CSS.escape(hsCode)}"]`).forEach((el) => {
    el.classList.toggle('is-fav', nowOn);
    el.textContent = nowOn ? '★' : '☆';
  });
  if (document.querySelector('.tab-panel[data-tab="favourites"]')?.classList.contains('active')) renderFavourites();
});

const favouritesListEl = document.getElementById('favourites-list');
document.querySelector('.tab-btn[data-tab="favourites"]').addEventListener('click', renderFavourites);

function renderFavourites() {
  const favs = getFavourites();
  if (favs.length === 0) {
    favouritesListEl.innerHTML = '<div class="hint" style="margin-top:16px;">No favourites yet — tap the ☆ on any search result or code detail to save it here.</div>';
    return;
  }
  favouritesListEl.innerHTML = favs.map((c) => resultCardHtml(c)).join('');
  favouritesListEl.querySelectorAll('.result-card').forEach((el, i) => {
    el.addEventListener('click', (e) => { if (!e.target.closest('.fav-star')) openCodeDetailIn(favs[i].hs_code, favouritesListEl, 'favourites'); });
  });
}

// Opens a code's full detail inside an arbitrary container (Home chapter
// browse and Favourites both need this, not just the Search tab).
async function openCodeDetailIn(hsCode, container, backTab) {
  container.innerHTML = '<div class="loading-row"><span class="spinner"></span> Loading full detail…</div>';
  try {
    const code = await fetchCode(hsCode);
    renderCodeDetail(code, container, { showBackToSearch: true, backTab });
  } catch (err) {
    container.innerHTML = `<div class="error-box">${escapeHtml(err.message)}</div>`;
  }
}

// ══════════════════════════════════════════════════════════════════════
// HOME — chapter browse (98 HS chapters, sourced from
// mobile/lib/data/hs_chapters.dart / SARS Schedule 1 Part 1) plus a quick
// search shortcut that hands off to the Search tab.
// ══════════════════════════════════════════════════════════════════════
const HS_CHAPTERS = [
  [1,'Live animals'],[2,'Meat and edible meat offal'],[3,'Fish and crustaceans, molluscs and other aquatic invertebrates'],
  [4,"Dairy produce; birds' eggs; natural honey; edible products of animal origin, not elsewhere specified or included"],
  [5,'Products of animal origin, not elsewhere specified or included'],
  [6,'Live trees and other plants; bulbs, roots and the like; cut flowers and ornamental foliage'],
  [7,'Edible vegetables and certain roots and tubers'],[8,'Edible fruit and nuts; peel of citrus fruit or melons'],
  [9,'Coffee, tea, maté and spices'],[10,'Cereals'],
  [11,'Products of the milling industry; malt; starches; inulin; wheat gluten'],
  [12,'Oil seeds and oleaginous fruits; miscellaneous grains, seeds and fruit; industrial or medicinal plants; straw and fodder'],
  [13,'Lac; gums, resins and other vegetable saps and extracts'],
  [14,'Vegetable plaiting materials; vegetable products not elsewhere specified or included'],
  [15,'Animal, vegetable or microbial fats and oils and their cleavage products; prepared edible fats; animal or vegetable waxes'],
  [16,'Preparations of meat, of fish, of crustaceans, molluscs or other aquatic invertebrates, or of insects'],
  [17,'Sugars and sugar confectionery'],[18,'Cocoa and cocoa preparations'],
  [19,'Preparations of cereals, flour, starch or milk; pastrycooks products'],
  [20,'Preparations of vegetables, fruit, nuts or other parts of plants'],[21,'Miscellaneous edible preparations'],
  [22,'Beverages, spirits and vinegar'],[23,'Residues and waste from the food industries; prepared animal fodder'],
  [24,'Tobacco and manufactured tobacco substitutes; products, whether or not containing nicotine, intended for inhalation without combustion; other nicotine containing products intended for the intake of nicotine into the human body'],
  [25,'Salt; sulphur; earths and stone; plastering materials, lime and cement'],[26,'Ores, slag and ash'],
  [27,'Mineral fuels, mineral oils and products of their distillation; bituminous substances; mineral waxes'],
  [28,'Inorganic chemicals; organic or inorganic compounds of precious metals, of rare-earth metals, of radioactive elements or of isotopes'],
  [29,'Organic chemicals'],[30,'Pharmaceutical products'],[31,'Fertilizers'],
  [32,'Tanning or dyeing extracts; tannins and their derivatives; dyes, pigments and other colouring matter; paints and varnishes; putty and other mastics; inks'],
  [33,'Essential oils and resinoids; perfumery, cosmetic or toilet preparations'],
  [34,'Soap, organic surface-active agents, washing preparations, lubricating preparations, artificial waxes, prepared waxes, polishing or scouring preparations, candles and similar articles, modelling pastes, "dental waxes" and dental preparations with a basis of plaster'],
  [35,'Albuminoidal substances; modified starches; glues; enzymes'],
  [36,'Explosives; pyrotechnic products; matches; pyrophoric alloys; certain combustible preparations'],
  [37,'Photographic or cinematographic goods'],[38,'Miscellaneous chemical products'],
  [39,'Plastics and articles thereof'],[40,'Rubber and articles thereof'],
  [41,'Raw hides and skins (other than furskins) and leather'],
  [42,'Articles of leather; saddlery and harness; travel goods, handbags and similar containers; articles of animal gut (other than silk-worm gut)'],
  [43,'Furskins and artificial fur; manufactures thereof'],[44,'Wood and articles of wood; wood charcoal'],
  [45,'Cork and articles of cork'],
  [46,'Manufactures of straw, of esparto or of other plaiting materials; basketware and wickerwork'],
  [47,'Pulp of wood or of other fibrous cellulosic material; recovered (waste and scrap) paper or paperboard'],
  [48,'Paper and paperboard; articles of paper pulp, of paper or of paperboard'],
  [49,'Printed books, newspapers, pictures and other products of the printing industry; manuscripts, typescripts and plans'],
  [50,'Silk'],[51,'Wool, fine or coarse animal hair; horsehair yarn and woven fabric'],[52,'Cotton'],
  [53,'Other vegetable textile fibres; paper yarn and woven fabrics of paper yarn'],
  [54,'Man-made filaments; strip and the like of man-made textile materials'],[55,'Man-made staple fibres'],
  [56,'Wadding, felt and nonwovens; special yarns; twine, cordage, ropes and cables and articles thereof'],
  [57,'Carpets and other textile floor coverings'],
  [58,'Special woven fabrics; tufted textile fabrics; lace; tapestries; trimmings; embroidery'],
  [59,'Impregnated, coated, covered or laminated textile fabrics; textile articles of a kind suitable for industrial use'],
  [60,'Knitted or crocheted fabrics'],[61,'Articles of apparel and clothing accessories, knitted or crocheted'],
  [62,'Articles of apparel and clothing accessories, not knitted or crocheted'],
  [63,'Other made up textile articles; sets; worn clothing and worn textile articles; rags'],
  [64,'Footwear, gaiters and the like; parts of such articles'],[65,'Headgear and parts thereof'],
  [66,'Umbrellas, sun umbrellas, walking-sticks, seat-sticks, whips, riding-crops and parts thereof'],
  [67,'Prepared feathers and down and articles made of feathers or of down; artificial flowers; articles of human hair'],
  [68,'Articles of stone, plaster, cement, asbestos, mica or similar materials'],[69,'Ceramic products'],
  [70,'Glass and glassware'],
  [71,'Natural or cultured pearls, precious or semi-precious stones, precious metals, metals clad with precious metal and articles thereof; imitation jewelery; coin'],
  [72,'Iron and steel'],[73,'Articles of iron or steel'],[74,'Copper and articles thereof'],
  [75,'Nickel and articles thereof'],[76,'Aluminium and articles thereof'],[78,'Lead and articles thereof'],
  [79,'Zinc and articles thereof'],[80,'Tin and articles thereof'],[81,'Other base metals; cermets; articles thereof'],
  [82,'Tools, implements, cutlery, spoons and forks, of base metal; parts thereof of base metal'],
  [83,'Miscellaneous articles of base metal'],
  [84,'Nuclear reactors, boilers, machinery and mechanical appliances; parts thereof'],
  [85,'Electrical machinery and equipment and parts thereof; sound recorders and reproducers, television image and sound recorders and reproducers, and parts and accessories of such articles'],
  [86,'Railway or tramway locomotives, rolling-stock and parts thereof; railway or tramway track fixtures and fittings and parts thereof; mechanical (including electro-mechanical) traffic signalling equipment of all kinds'],
  [87,'Vehicles (excluding railway or tramway rolling-stock), and parts and accessories thereof'],
  [88,'Aircraft, spacecraft, and parts thereof'],[89,'Ships, boats and floating structures'],
  [90,'Optical, photographic, cinematographic, measuring, checking, precision, medical or surgical instruments and apparatus; parts and accessories thereof'],
  [91,'Clocks and watches and parts thereof'],[92,'Musical instruments; part and accessories of such articles'],
  [93,'Arms and ammunition; parts and accessories thereof'],
  [94,'Furniture; bedding, mattresses, mattress supports, cushions and similar stuffed furnishings; luminaires and lighting fittings, not elsewhere specified or included; illuminated signs, illuminated name-plates and the like; prefabricated buildings'],
  [95,'Toys, games and sports requisites; parts and accessories thereof'],[96,'Miscellaneous manufactured articles'],
  [97,'Works of art, collectors pieces and antiques'],[98,'Original equipment components'],
  [99,'Miscellaneous classification provisions'],
];

const homeSearchInput = document.getElementById('home-search-input');
const homeChapterList = document.getElementById('home-chapter-list');
const homeChapterDetail = document.getElementById('home-chapter-detail');

homeSearchInput.addEventListener('keydown', (e) => {
  if (e.key !== 'Enter') return;
  const q = homeSearchInput.value.trim();
  if (!q) return;
  showTab('search');
  searchInput.value = q;
  searchInput.dispatchEvent(new Event('input'));
});

function renderHomeChapterList() {
  homeChapterList.innerHTML = HS_CHAPTERS.map(([n, title]) => `
    <div class="chapter-row" data-chapter="${n}">
      <span class="chapter-num">${String(n).padStart(2, '0')}</span>
      <span class="chapter-title">${escapeHtml(title)}</span>
      <span class="chapter-arrow">›</span>
    </div>
  `).join('');
  homeChapterList.querySelectorAll('.chapter-row').forEach((el) => {
    el.addEventListener('click', () => openChapter(Number(el.dataset.chapter)));
  });
}
renderHomeChapterList();

async function openChapter(n) {
  homeChapterList.style.display = 'none';
  homeChapterDetail.style.display = 'block';
  const title = HS_CHAPTERS.find(([num]) => num === n)?.[1] || '';
  homeChapterDetail.innerHTML = `
    <button class="btn-secondary" id="chapter-back-btn">&larr; All chapters</button>
    <div class="lc-section-label" style="margin-top:14px;">Chapter ${String(n).padStart(2, '0')} — ${escapeHtml(title)}</div>
    <div class="loading-row"><span class="spinner"></span> Loading codes…</div>
  `;
  document.getElementById('chapter-back-btn').addEventListener('click', closeChapter);
  try {
    const res = await fetch(`${API_BASE}/web/chapter/${String(n).padStart(2, '0')}`);
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Could not load that chapter.');
    const results = data.results || [];
    homeChapterDetail.innerHTML = `
      <button class="btn-secondary" id="chapter-back-btn">&larr; All chapters</button>
      <div class="lc-section-label" style="margin-top:14px;">Chapter ${String(n).padStart(2, '0')} — ${escapeHtml(title)}</div>
      ${results.length === 0
        ? '<div class="hint" style="margin-top:10px;">No codes loaded for this chapter yet.</div>'
        : `<p class="hint" style="margin:2px 0 10px;">${results.length} code${results.length === 1 ? '' : 's'}</p>` + results.map((c) => resultCardHtml(c)).join('')}
    `;
    document.getElementById('chapter-back-btn').addEventListener('click', closeChapter);
    homeChapterDetail.querySelectorAll('.result-card').forEach((el, i) => {
      el.addEventListener('click', (e) => { if (!e.target.closest('.fav-star')) openCodeDetailIn(results[i].hs_code, homeChapterDetail, 'home'); });
    });
  } catch (err) {
    homeChapterDetail.innerHTML = `
      <button class="btn-secondary" id="chapter-back-btn">&larr; All chapters</button>
      <div class="error-box" style="margin-top:14px;">${escapeHtml(err.message)}</div>
    `;
    document.getElementById('chapter-back-btn').addEventListener('click', closeChapter);
  }
}
function closeChapter() {
  homeChapterDetail.style.display = 'none';
  homeChapterList.style.display = 'block';
}

// ══════════════════════════════════════════════════════════════════════
// SEARCH
// ══════════════════════════════════════════════════════════════════════
const searchInput = document.getElementById('search-input');
const searchResults = document.getElementById('search-results');
let searchDebounce = null;

searchInput.addEventListener('input', () => {
  clearTimeout(searchDebounce);
  const q = searchInput.value.trim();
  if (q.length < 2) { searchResults.innerHTML = ''; return; }
  searchDebounce = setTimeout(() => runSearch(q), 350);
});

async function runSearch(q) {
  searchResults.innerHTML = '<div class="loading-row"><span class="spinner"></span> Searching the real SARS schedule…</div>';
  try {
    const res = await fetch(`${API_BASE}/web/search?q=${encodeURIComponent(q)}&limit=30&deviceId=${encodeURIComponent(getDeviceId())}`, { headers: accessHeaders() });
    const data = await res.json();
    if (!res.ok) {
      if (res.status === 429) {
        searchResults.innerHTML = `<div class="error-box">${escapeHtml(data.error)} <a href="#" id="search-unlock-link">Unlock full access</a>.</div>`;
        document.getElementById('search-unlock-link')?.addEventListener('click', (e) => { e.preventDefault(); openAccessModal(); });
        return;
      }
      throw new Error(data.error || 'Search failed.');
    }
    renderSearchResults(data.results || []);
  } catch (err) {
    searchResults.innerHTML = `<div class="error-box">${escapeHtml(err.message || 'Something went wrong — try again.')}</div>`;
  }
}

function renderSearchResults(results) {
  if (results.length === 0) {
    searchResults.innerHTML = '<div class="hint" style="margin-top:16px;">No matches. Try a broader term, or use AI Classify to describe the product in plain language.</div>';
    return;
  }
  searchResults.innerHTML = results.slice(0, 20).map((c) => resultCardHtml(c)).join('');
  searchResults.querySelectorAll('.result-card').forEach((el, i) => {
    el.addEventListener('click', () => openCodeDetail(results[i].hs_code));
  });
}

function resultCardHtml(c) {
  const badges = [`<span class="badge badge-duty">Duty: ${escapeHtml(dutyDisplay(c))}</span>`];
  badges.push(`<span class="badge badge-vat">VAT: ${c.vat_applicable ? '15%' : 'Exempt'}</span>`);
  if (c.permit_required) badges.push(`<span class="badge badge-warn">Permit: ${escapeHtml(c.permit_authority || 'required')}</span>`);
  else badges.push('<span class="badge badge-ok">No permit</span>');
  return `<div class="result-card">
    <div class="result-card-top">
      <span class="result-code">${escapeHtml(c.hs_code)}</span>
      ${starBtnHtml(c.hs_code)}
    </div>
    <div class="result-desc">${escapeHtml(c.description)}</div>
    <div class="badge-row">${badges.join('')}</div>
  </div>`;
}

async function openCodeDetail(hsCode) {
  searchResults.innerHTML = '<div class="loading-row"><span class="spinner"></span> Loading full detail…</div>';
  try {
    const code = await fetchCode(hsCode);
    renderCodeDetail(code, searchResults, { showBackToSearch: true });
  } catch (err) {
    renderCodeLookupError(err, searchResults, () => runSearch(searchInput.value.trim()));
  }
}

// Shared by Search and AI Classify's "look up this code" click — when the
// requested code turns out to be a heading rather than a real dutiable
// line (see fetchCode), show the actual sibling lines instead of a dead
// end error.
function renderCodeLookupError(err, container, onBack) {
  if (err.siblings && err.siblings.length) {
    container.innerHTML = `
      <button class="btn-secondary" id="lookup-error-back">&larr; Back</button>
      <div class="hint" style="margin:14px 0 4px;">That's not a specific tariff line on its own — here's what SARS actually lists under it:</div>
      ${err.siblings.map((c) => resultCardHtml(c)).join('')}
    `;
    document.getElementById('lookup-error-back')?.addEventListener('click', onBack);
    container.querySelectorAll('.result-card').forEach((el, i) => {
      el.addEventListener('click', (e) => { if (!e.target.closest('.fav-star')) openCodeDetail(err.siblings[i].hs_code); });
    });
    return;
  }
  container.innerHTML = `<div class="error-box">${escapeHtml(err.message)}</div>`;
}

async function fetchCode(hsCode) {
  const res = await fetch(`${API_BASE}/web/tariff-data/${encodeURIComponent(hsCode)}`, { headers: accessHeaders() });
  const data = await res.json();
  if (!res.ok) {
    const err = new Error(data.error || 'Could not load that code.');
    // Set when the requested code is a heading (e.g. AI Classify suggesting
    // "0407.21") rather than one of the real dutiable leaf lines under it
    // ("0407.21.10"/"0407.21.90") — the real options, not a dead end.
    if (data.siblings) err.siblings = data.siblings;
    throw err;
  }
  return data;
}

function renderCodeDetail(code, container, opts) {
  const prefs = [];
  if (code.eu_uk_duty) prefs.push(['EU / UK', code.eu_uk_duty]);
  if (code.efta_duty) prefs.push(['EFTA', code.efta_duty]);
  if (code.sadc_duty) prefs.push(['SADC', code.sadc_duty]);
  if (code.mercosur_duty) prefs.push(['MERCOSUR', code.mercosur_duty]);
  if (code.afcfta_duty) prefs.push(['AfCFTA', code.afcfta_duty]);

  container.innerHTML = `
    ${opts?.showBackToSearch ? '<button class="btn-secondary" id="back-to-search">&larr; Back</button>' : ''}
    <div class="result-card" style="cursor:default; margin-top:14px;">
      <div class="result-card-top">
        <span class="result-code">${escapeHtml(code.hs_code)}</span>
        ${starBtnHtml(code.hs_code)}
      </div>
      <div class="result-desc">${escapeHtml(code.description)}</div>
      <div class="badge-row">
        <span class="badge badge-duty">General duty: ${escapeHtml(dutyDisplay(code))}</span>
        <span class="badge badge-vat">VAT: ${code.vat_applicable ? '15%' : 'Exempt'}</span>
        ${code.permit_required ? `<span class="badge badge-warn">Permit: ${escapeHtml(code.permit_authority || 'required')}</span>` : '<span class="badge badge-ok">No permit</span>'}
      </div>
      ${prefs.length ? `<div class="lc-section-label">Preferential trade agreement rates</div>
        <div class="badge-row">${prefs.map(([n, r]) => `<span class="badge badge-ok">${escapeHtml(n)}: ${escapeHtml(r)}</span>`).join('')}</div>` : ''}
      ${code.permit_note ? `<div class="hint" style="margin-top:10px;">${escapeHtml(code.permit_note)}</div>` : ''}

      <div class="lc-section-label">Reference &amp; compliance</div>
      <div class="detail-ref-links">
        <button type="button" class="detail-ref-link" data-topic="trade_agreements">📜 View all trade agreements</button>
        <button type="button" class="detail-ref-link" data-topic="documentation_checklist">📄 Import &amp; export documents</button>
        <button type="button" class="detail-ref-link" data-topic="hazchem">⚠️ Dangerous goods / HazChem check</button>
      </div>

      <div id="detail-itac-check" class="detail-check-row"><span class="spinner"></span> Checking ITAC control status…</div>
      <div id="detail-hazchem-check" class="detail-check-row" style="display:none;"></div>

      <div class="lc-section-label">Verify with SARS</div>
      <div class="detail-sars-links">
        <a href="https://www.sars.gov.za/wp-content/uploads/Legal/SCEA1964/Legal-LPrim-CE-Sch1P1Chpt1-to-99-Schedule-No-1-Part-1-Chapters-1-to-99.pdf" target="_blank" rel="noopener" class="detail-sars-link">
          <span class="detail-sars-icon">📕</span>
          <span><strong>Official SARS Tariff Book</strong><span class="hint" style="margin:1px 0 0;">Schedule 1, Part 1 — search for HS ${escapeHtml(code.hs_code)}</span></span>
        </a>
        <a href="https://www.sars.gov.za/legal-counsel/secondary-legislation/tariff-amendments/" target="_blank" rel="noopener" class="detail-sars-link">
          <span class="detail-sars-icon">🔄</span>
          <span><strong>Real-time tariff amendments</strong><span class="hint" style="margin:1px 0 0;">Published up to a day before each gazette</span></span>
        </a>
        <a href="https://www.sars.gov.za/legal-lprim-ce-schtb-index-to-tariff-book/" target="_blank" rel="noopener" class="detail-sars-link">
          <span class="detail-sars-icon">📖</span>
          <span><strong>Chapter ${escapeHtml(code.chapter || '')} index</strong><span class="hint" style="margin:1px 0 0;">Confirm this code's chapter placement</span></span>
        </a>
      </div>

      <button class="btn-primary" id="use-for-landed-cost" style="margin-top:16px;">🧮 Calculate landed cost for this code</button>
      <button class="btn-secondary" id="share-code-btn" style="width:100%; margin-top:8px;">📤 Share</button>
    </div>
  `;
  document.getElementById('use-for-landed-cost')?.addEventListener('click', () => {
    setLandedCostCode(code);
    showTab('landed-cost');
  });
  document.getElementById('back-to-search')?.addEventListener('click', () => {
    const backTab = opts?.backTab;
    if (backTab === 'favourites') renderFavourites();
    else if (backTab === 'home') closeChapter();
    else runSearch(searchInput.value.trim());
  });
  container.querySelectorAll('.detail-ref-link').forEach((btn) => {
    btn.addEventListener('click', () => {
      const topic = btn.dataset.topic;
      showTab('info');
      (infoIndexLoaded ? Promise.resolve() : loadInfoIndex()).then(() => openInfoTopic(topic));
    });
  });
  document.getElementById('share-code-btn')?.addEventListener('click', () => shareCode(code));
  loadItacAndHazchemChecks(code);
}

// Live checks shown on a tariff code's detail card — separate from the
// gated Important Information reference articles the nav buttons above
// link into; these are quick informational flags, free like the app's
// equivalent (ItacControlCard / the chapter-flag check), not paywalled.
async function loadItacAndHazchemChecks(code) {
  const itacEl = document.getElementById('detail-itac-check');
  const hazEl = document.getElementById('detail-hazchem-check');
  try {
    const res = await fetch(`${API_BASE}/web/itac-control/${encodeURIComponent(code.hs_code)}`);
    const data = await res.json();
    if (!itacEl) return;
    if (data.import_control || data.export_control) {
      const which = [data.import_control ? 'import' : null, data.export_control ? 'export' : null].filter(Boolean).join(' & ');
      itacEl.innerHTML = `<span class="badge badge-warn">⚠️ ITAC ${which} control applies</span>`;
    } else if (data.confirmed_exempt) {
      itacEl.innerHTML = '<span class="badge badge-ok">✅ Confirmed exempt from ITAC control</span>';
    } else {
      itacEl.innerHTML = '<span class="badge badge-ok">✅ No ITAC control on record</span>';
    }
  } catch {
    if (itacEl) itacEl.innerHTML = '';
  }

  if (!code.chapter) return;
  try {
    const res = await fetch(`${API_BASE}/web/hazchem-check/${encodeURIComponent(code.chapter)}`);
    const data = await res.json();
    if (hazEl && data.flagged) {
      hazEl.style.display = 'block';
      hazEl.innerHTML = `<span class="badge badge-warn">⚠️ Chapter ${escapeHtml(code.chapter)} is commonly flagged for HazChem${data.note ? ' — ' + escapeHtml(data.note) : ''}</span>`;
    }
  } catch { /* leave hidden */ }
}

function shareCode(code) {
  const lines = [
    `${code.hs_code} — ${code.description}`,
    `General duty: ${dutyDisplay(code)}`,
    `VAT: ${code.vat_applicable ? '15%' : 'Exempt'}`,
    code.permit_required ? `Permit required: ${code.permit_authority || 'yes'}` : 'No permit required',
    '',
    `Full detail: https://tarifflogicxafrica.co.za/tools.html?tab=search`,
  ];
  const text = lines.join('\n');
  if (navigator.share) {
    navigator.share({ title: `TariffLogicX Africa — ${code.hs_code}`, text }).catch(() => {});
    return;
  }
  navigator.clipboard?.writeText(text).then(() => {
    const btn = document.getElementById('share-code-btn');
    if (!btn) return;
    const original = btn.textContent;
    btn.textContent = '✓ Copied to clipboard';
    setTimeout(() => { btn.textContent = original; }, 1800);
  });
}

function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// ══════════════════════════════════════════════════════════════════════
// AI CLASSIFY
// ══════════════════════════════════════════════════════════════════════
const classifyInput = document.getElementById('classify-input');
const classifyBtn = document.getElementById('classify-btn');
const classifyResults = document.getElementById('classify-results');

classifyBtn.addEventListener('click', async () => {
  const description = classifyInput.value.trim();
  if (description.length < 3) {
    classifyResults.innerHTML = '<div class="error-box">Describe the product in a bit more detail (a few words is enough).</div>';
    return;
  }
  classifyBtn.disabled = true;
  classifyResults.innerHTML = '<div class="loading-row"><span class="spinner"></span> Asking Claude for likely HS codes…</div>';
  try {
    const res = await fetch(`${API_BASE}/web/classify`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...accessHeaders() },
      body: JSON.stringify({ description, deviceId: getDeviceId() }),
    });
    const data = await res.json();
    if (!res.ok) {
      if (res.status === 429) {
        classifyResults.innerHTML = `<div class="error-box">${escapeHtml(data.error)} The app has its own separate free allowance — <a href="https://play.google.com/store/apps/details?id=za.co.tarifflogicxafrica.app" target="_blank" rel="noopener">get it on Google Play</a>.</div>`;
      } else {
        throw new Error(data.error || 'Classification failed.');
      }
      return;
    }
    renderClassifyResults(data.suggestions || [], data.disclaimer);
  } catch (err) {
    classifyResults.innerHTML = `<div class="error-box">${escapeHtml(err.message || 'Something went wrong — try again.')}</div>`;
  } finally {
    classifyBtn.disabled = false;
  }
});

function renderClassifyResults(suggestions, disclaimer) {
  if (suggestions.length === 0) {
    classifyResults.innerHTML = '<div class="hint" style="margin-top:14px;">No confident suggestions for that description — try adding more detail (material, purpose, form).</div>';
    return;
  }
  classifyResults.innerHTML = suggestions.map((s, i) => `
    <div class="suggestion-card">
      <div class="suggestion-top">
        <span class="result-code">${escapeHtml(s.hs_code)}</span>
        <span class="badge confidence-${s.confidence}">${escapeHtml(s.confidence)} confidence</span>
      </div>
      <div class="result-desc">${escapeHtml(s.description)}</div>
      <div class="suggestion-reasoning">${escapeHtml(s.reasoning)}</div>
      <span class="use-code-link" data-code="${escapeHtml(s.hs_code)}">Look up full duty &amp; VAT for this code &rarr;</span>
    </div>
  `).join('') + `<div class="hint" style="margin-top:14px;">${escapeHtml(disclaimer || '')}</div>`;

  classifyResults.querySelectorAll('.use-code-link').forEach((el) => {
    el.addEventListener('click', async () => {
      el.textContent = 'Loading…';
      try {
        const code = await fetchCode(el.dataset.code);
        showTab('search');
        renderCodeDetail(code, searchResults, { showBackToSearch: false });
      } catch (err) {
        if (err.siblings && err.siblings.length) {
          showTab('search');
          renderCodeLookupError(err, searchResults, () => runSearch(searchInput.value.trim()));
        } else {
          el.textContent = 'Could not load — try Search instead.';
        }
      }
    });
  });
}

// ══════════════════════════════════════════════════════════════════════
// LANDED COST — mirrors mobile/lib/screens/landed_cost_screen.dart exactly:
//   Customs Value (CIF) = Goods + Freight + Insurance
//   Customs Duty        = Customs Value × duty rate
//   Ad Valorem           = Customs Value × ad valorem rate (optional)
//   ATV                  = Customs Value + 10% uplift (skip if BLNS) + Duty + Ad Valorem
//   Import VAT           = ATV × 15% (if applicable)
//   Total                = Customs Value + Duty + Ad Valorem + VAT + Clearing fee
// Source: SARS "Duties and Taxes for Importers". ZAR only on the website —
// the app additionally supports live multi-currency conversion.
// ══════════════════════════════════════════════════════════════════════
let lcCode = null; // currently selected TariffCode-shaped object, or null

const lcHeader = document.getElementById('lc-code-header');
const lcNoCode = document.getElementById('lc-no-code');
const lcForm = document.getElementById('lc-form');
const lcResults = document.getElementById('lc-results');
const lcDutyRateInput = document.getElementById('lc-duty-rate');

function setLandedCostCode(code) {
  lcCode = code;
  lcHeader.innerHTML = `<span class="result-code">${escapeHtml(code.hs_code)}</span><p class="result-desc">${escapeHtml(code.description)}</p>`;
  lcHeader.style.display = 'flex';
  lcNoCode.style.display = 'none';
  lcDutyRateInput.value = (code.general_duty ?? 0);
  document.getElementById('lc-vat-applicable').value = code.vat_applicable ? '1' : '0';
  if (code.ad_valorem_duty) document.getElementById('lc-ad-valorem').value = code.ad_valorem_duty;
}

document.getElementById('lc-calc-btn').addEventListener('click', () => {
  const goodsValue = parseFloat(document.getElementById('lc-goods-value').value.replace(/,/g, '')) || 0;
  if (goodsValue <= 0) {
    lcResults.innerHTML = '<div class="error-box">Enter a valid goods value first.</div>';
    return;
  }
  const freight = parseFloat(document.getElementById('lc-freight').value) || 0;
  const insurance = parseFloat(document.getElementById('lc-insurance').value) || 0;
  const dutyRatePct = parseFloat(lcDutyRateInput.value) || 0;
  const adValoremPct = parseFloat(document.getElementById('lc-ad-valorem').value) || 0;
  const clearingFee = parseFloat(document.getElementById('lc-clearing').value) || 0;
  const isBlns = document.getElementById('lc-blns').checked;
  const vatApplicable = document.getElementById('lc-vat-applicable').value === '1';

  const customsValue = goodsValue + freight + insurance;
  const dutyAmount = customsValue * (dutyRatePct / 100);
  const adValoremAmount = customsValue * (adValoremPct / 100);
  const upliftAmount = isBlns ? 0 : customsValue * 0.10;
  const atv = customsValue + upliftAmount + dutyAmount + adValoremAmount;
  const vatAmount = vatApplicable ? atv * 0.15 : 0;
  const total = customsValue + dutyAmount + adValoremAmount + vatAmount + clearingFee;

  lcResults.innerHTML = `
    <div class="lc-section-label">Customs value</div>
    <div class="lc-results-table">
      <div class="lc-row"><span>Goods value (FOB)</span><span>${fmtR(goodsValue)}</span></div>
      ${freight > 0 ? `<div class="lc-row"><span>+ Freight</span><span>${fmtR(freight)}</span></div>` : ''}
      ${insurance > 0 ? `<div class="lc-row"><span>+ Insurance</span><span>${fmtR(insurance)}</span></div>` : ''}
      <div class="lc-row total"><span>Customs value (CIF)</span><span>${fmtR(customsValue)}</span></div>
    </div>
    <div class="lc-section-label">Duty, uplift &amp; VAT</div>
    <div class="lc-results-table">
      <div class="lc-row"><span>Customs duty (${dutyRatePct}%)</span><span class="lc-val-duty">${fmtR(dutyAmount)}</span></div>
      ${adValoremAmount > 0 ? `<div class="lc-row"><span>Ad valorem excise (${adValoremPct}%)</span><span class="lc-val-duty">${fmtR(adValoremAmount)}</span></div>` : ''}
      <div class="lc-row"><span>${isBlns ? '10% ATV uplift (N/A — BLNS origin)' : '10% ATV uplift'}</span><span>${fmtR(upliftAmount)}</span></div>
      <div class="lc-row"><span>Added Tax Value (ATV)</span><span>${fmtR(atv)}</span></div>
      <div class="lc-row"><span>Import VAT (${vatApplicable ? '15% of ATV' : 'exempt'})</span><span class="lc-val-vat">${fmtR(vatAmount)}</span></div>
    </div>
    <div class="lc-section-label">Total</div>
    <div class="lc-results-table">
      <div class="lc-row"><span>Customs value</span><span>${fmtR(customsValue)}</span></div>
      <div class="lc-row"><span>Duty + ad valorem</span><span>${fmtR(dutyAmount + adValoremAmount)}</span></div>
      <div class="lc-row"><span>Import VAT</span><span>${fmtR(vatAmount)}</span></div>
      ${clearingFee > 0 ? `<div class="lc-row"><span>Clearing &amp; forwarding fee</span><span>${fmtR(clearingFee)}</span></div>` : ''}
      <div class="lc-row total"><span>Total landed cost</span><span>${fmtR(total)}</span></div>
    </div>
    <div class="lc-disclaimer">
      Reference estimate only, per SARS' published ATV formula (Customs Value + 10% uplift + Duty, then VAT on that total) — not a bill. Not included: anti-dumping/countervailing duties, environmental levies, ITAC permit fees, port/terminal handling, demurrage. The actual amount SARS charges is only finalised once your clearing agent submits the EDI customs declaration — always confirm before paying or invoicing a client.
    </div>
  `;
});

// ══════════════════════════════════════════════════════════════════════
// IMPORTANT INFORMATION — topic index is always free to browse; opening a
// topic's actual content requires access (Subscriber/Pro/redeemed code),
// no free quota — matches ReferenceSectionGate in the app exactly.
// ══════════════════════════════════════════════════════════════════════
const infoIndexEl = document.getElementById('info-index');
let infoIndexLoaded = false;
let infoIndexData = null;
let currentInfoKey = null; // so onAccessChanged can retry the topic just unlocked

document.querySelector('.tab-btn[data-tab="info"]').addEventListener('click', () => {
  if (!infoIndexLoaded) loadInfoIndex();
});

async function loadInfoIndex() {
  infoIndexEl.innerHTML = '<div class="loading-row"><span class="spinner"></span> Loading topic list…</div>';
  try {
    const res = await fetch(`${API_BASE}/web/reference-index`);
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Could not load the topic list.');
    infoIndexData = data.sections;
    infoIndexLoaded = true;
    renderInfoIndex();
  } catch (err) {
    infoIndexEl.innerHTML = `<div class="error-box">${escapeHtml(err.message || 'Something went wrong — try again.')}</div>`;
  }
}

function renderInfoIndex() {
  infoIndexEl.innerHTML = infoIndexData.map((section) => `
    <div class="lc-section-label" style="margin-top:20px;">${escapeHtml(section.header)}</div>
    ${section.items.map((item) => `
      <div class="result-card" data-key="${escapeHtml(item.key)}" data-type="${item.type}" ${item.type === 'external' ? `data-url="${escapeHtml(item.url)}"` : ''}>
        <div class="result-desc" style="font-weight:600; color:var(--text); margin-bottom:2px;">${escapeHtml(item.title)}</div>
        <div class="hint" style="margin:0;">${escapeHtml(item.subtitle)}</div>
        <div class="badge-row" style="margin-top:8px;">
          ${item.type === 'external' ? '<span class="badge badge-ok">Official link ↗</span>' : ''}
          ${item.type === 'free' ? '<span class="badge badge-ok">Free</span>' : ''}
          ${item.type === 'gated' ? '<span class="badge badge-warn">Subscriber/Pro</span>' : ''}
        </div>
      </div>
    `).join('')}
  `).join('');

  infoIndexEl.querySelectorAll('.result-card').forEach((el) => {
    el.addEventListener('click', () => {
      if (el.dataset.type === 'external') {
        window.open(el.dataset.url, '_blank', 'noopener');
      } else {
        openInfoTopic(el.dataset.key);
      }
    });
  });
}

async function openInfoTopic(key) {
  currentInfoKey = key;
  infoIndexEl.innerHTML = '<button class="btn-secondary" id="info-back-btn">&larr; Back to topics</button><div class="loading-row" style="margin-top:14px;"><span class="spinner"></span> Loading…</div>';
  document.getElementById('info-back-btn').addEventListener('click', () => renderInfoIndex());
  try {
    const res = await fetch(`${API_BASE}/web/reference/${encodeURIComponent(key)}`, { headers: accessHeaders() });
    const data = await res.json();
    if (res.status === 402) {
      renderInfoPaywall(key);
      return;
    }
    if (!res.ok) throw new Error(data.error || 'Could not load that section.');
    renderInfoContent(key, data);
  } catch (err) {
    infoIndexEl.innerHTML = `<button class="btn-secondary" id="info-back-btn">&larr; Back to topics</button><div class="error-box" style="margin-top:14px;">${escapeHtml(err.message)}</div>`;
    document.getElementById('info-back-btn').addEventListener('click', () => renderInfoIndex());
  }
}

function renderInfoPaywall(key) {
  infoIndexEl.innerHTML = `
    <button class="btn-secondary" id="info-back-btn">&larr; Back to topics</button>
    <div class="lc-no-code" style="margin-top:14px;">
      This section needs a Subscriber plan or Pro pass to open — same as in the app, no free quota on Important Information topics.
      <div style="margin-top:10px;"><button class="btn-primary" id="info-unlock-btn">Unlock full access</button></div>
    </div>
  `;
  document.getElementById('info-back-btn').addEventListener('click', () => renderInfoIndex());
  document.getElementById('info-unlock-btn').addEventListener('click', () => openAccessModal());
}

// Generic renderer: these 39 topics come from many differently-shaped JSON
// structures (arrays of {title, body}, keyed objects, nested lists, etc.)
// — rather than hand-building 39 bespoke layouts, walk whatever comes back
// and render it reasonably. Good enough to be genuinely useful; a future
// pass could give the highest-traffic topics bespoke layouts.
function renderInfoContent(key, data) {
  const title = infoIndexData.flatMap((s) => s.items).find((i) => i.key === key)?.title || key;
  infoIndexEl.innerHTML = `
    <button class="btn-secondary" id="info-back-btn">&larr; Back to topics</button>
    <div class="result-card" style="cursor:default; margin-top:14px;">
      <div class="result-desc" style="font-weight:700; font-size:15px; color:var(--app-primary-dark); margin-bottom:10px;">${escapeHtml(title)}</div>
      ${key === 'forex' ? renderForexContent(data) : renderJsonAsHtml(data)}
    </div>
  `;
  document.getElementById('info-back-btn').addEventListener('click', () => renderInfoIndex());
}

// Real flag image, not emoji — Windows browsers don't render flag emoji as
// pictures at all (Segoe UI Emoji shows the raw two-letter code instead),
// unlike iOS/Android where the app's own emoji-based flags work fine. SVGs
// bundled locally from the flag-icons package (MIT), assets/flags/{iso2}.svg.
function flagImgHtml(iso2) {
  if (!iso2 || iso2.length !== 2) return '<span class="forex-flag forex-flag-fallback">🌍</span>';
  return `<img class="forex-flag" src="assets/flags/${iso2.toLowerCase()}.svg" alt="" width="26" height="26">`;
}

// forex gets its own layout rather than the generic JSON walk below: that
// walk would flatten its {code, currency_name, ...} list into ~185 bare
// paragraphs of currency codes and country names with no visual hierarchy
// — exactly the "bland, hard to spot the rate" complaint. A real per-
// currency row with a flag and a large, prominent rate value fixes that.
function renderForexContent(data) {
  const groupLabels = { africa: 'Africa', international: 'Major International', other: 'Other' };
  const groups = {};
  (data.currencies || []).forEach((c) => { (groups[c.group] ??= []).push(c); });

  const groupsHtml = Object.entries(groupLabels).map(([groupKey, label]) => {
    const items = groups[groupKey];
    if (!items || !items.length) return '';
    return `
      <div class="lc-section-label" style="margin-top:18px;">${label}</div>
      ${items.map((c) => `
        <div class="forex-row">
          ${flagImgHtml(c.country_iso2)}
          <div class="forex-info">
            <div class="forex-code">${escapeHtml(c.code)}</div>
            <div class="forex-name">${escapeHtml(c.currency_name)} &middot; ${escapeHtml(c.country_name)}</div>
          </div>
          <div class="forex-rate">
            <span class="forex-rate-zar">ZAR 1.00 =</span>
            <span class="forex-rate-val">${escapeHtml(c.code.toUpperCase())} ${Number(c.rate_per_zar).toFixed(c.rate_per_zar < 1 ? 4 : 2)}</span>
          </div>
        </div>
      `).join('')}
    `;
  }).join('');

  const rest = { ...data };
  delete rest.currencies; delete rest.base; delete rest.fetched_at; delete rest.source_date; delete rest.version; delete rest.disclaimer;

  return `
    <div class="forex-live-banner">🔄 <strong>Live rates</strong> as of ${escapeHtml(data.source_date ?? '')} — refreshed automatically. 1 ZAR equals:</div>
    ${groupsHtml}
    <div class="lc-section-label" style="margin-top:20px;">More on invoicing &amp; cross-border payments</div>
    ${renderJsonAsHtml(rest)}
  `;
}

function renderJsonAsHtml(value, depth = 0) {
  if (value === null || value === undefined) return '';
  if (typeof value === 'string') return `<p style="font-size:13px; line-height:1.6; margin:4px 0;">${escapeHtml(value)}</p>`;
  if (typeof value === 'number' || typeof value === 'boolean') return `<span>${escapeHtml(String(value))}</span>`;
  if (Array.isArray(value)) {
    return value.map((v) => `<div style="margin:${depth === 0 ? '14px' : '6px'} 0 ${depth === 0 ? '14px' : '6px'} ${depth > 0 ? '14px' : '0'}; ${depth === 0 ? 'padding-top:12px; border-top:1px solid #F1EEE8;' : ''}">${renderJsonAsHtml(v, depth + 1)}</div>`).join('');
  }
  if (typeof value === 'object') {
    const looksLikeALink = typeof value.url === 'string';
    return Object.entries(value).map(([k, v]) => {
      if (k === 'url' || k === 'source_url') {
        return v ? `<p style="margin:4px 0;"><a href="${escapeHtml(v)}" target="_blank" rel="noopener" style="font-size:12px;">Official source ↗</a></p>` : '';
      }
      if (v === null || v === undefined || v === '') return '';
      const label = k.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
      const isTitleish = /title|heading|name/i.test(k) && typeof v === 'string';
      if (isTitleish) {
        return `<div style="font-weight:700; font-size:${depth <= 1 ? '13.5px' : '13px'}; margin-top:${depth === 0 ? '0' : '8px'};">${escapeHtml(v)}</div>`;
      }
      if (typeof v === 'object') {
        return `<div style="margin-top:6px;"><span style="font-size:10.5px; font-weight:700; text-transform:uppercase; color:var(--muted); letter-spacing:0.4px;">${escapeHtml(label)}</span>${renderJsonAsHtml(v, depth + 1)}</div>`;
      }
      return `<p style="font-size:12.5px; margin:3px 0; line-height:1.5;"><strong>${escapeHtml(label)}:</strong> ${escapeHtml(String(v))}</p>`;
    }).join('');
  }
  return '';
}

// Called after a successful admin login or code redemption — if the user
// was looking at a paywalled topic, retry it now that access may unlock it.
function onAccessChanged() {
  if (currentInfoKey) openInfoTopic(currentInfoKey);
}

// ══════════════════════════════════════════════════════════════════════
// FAQ — searches this site's own content (curated FAQ + Important
// Information topic index) first; only falls back to Claude when nothing
// here actually answers the question. Each answer is prepended as its own
// card so a short back-and-forth session reads like a simple Q&A log.
// ══════════════════════════════════════════════════════════════════════
const faqInput = document.getElementById('faq-input');
const faqAskBtn = document.getElementById('faq-ask-btn');
const faqResults = document.getElementById('faq-results');

faqAskBtn.addEventListener('click', askFaq);
faqInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') askFaq(); });

// Separate from the mailto: link next to it (which contact.js already
// intercepts into the professional contact-form modal) — this just covers
// the case where someone would rather paste the address into their own
// mail client than use the on-site form.
document.getElementById('faq-copy-email-btn')?.addEventListener('click', async (e) => {
  const btn = e.currentTarget;
  try {
    await navigator.clipboard.writeText('support@tarifflogicxafrica.co.za');
    const original = btn.textContent;
    btn.textContent = '✓';
    setTimeout(() => { btn.textContent = original; }, 1500);
  } catch {
    // Clipboard API unavailable (very old browser) — the mailto: link right
    // next to this button still works as a fallback either way.
  }
});

async function askFaq() {
  const query = faqInput.value.trim();
  if (query.length < 3) return;
  faqAskBtn.disabled = true;
  const card = document.createElement('div');
  card.className = 'suggestion-card';
  card.innerHTML = `<div class="result-desc" style="font-weight:700;">${escapeHtml(query)}</div><div class="loading-row"><span class="spinner"></span> Checking the site, then AI if needed…</div>`;
  faqResults.prepend(card);
  try {
    const res = await fetch(`${API_BASE}/web/faq/ask`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...accessHeaders() },
      body: JSON.stringify({ query, deviceId: getDeviceId() }),
    });
    const data = await res.json();
    if (!res.ok) {
      if (res.status === 429) {
        card.innerHTML = `<div class="result-desc" style="font-weight:700;">${escapeHtml(query)}</div><div class="error-box">${escapeHtml(data.error)} <a href="#" class="faq-unlock-link">Unlock full access</a>.</div>`;
        card.querySelector('.faq-unlock-link')?.addEventListener('click', (e) => { e.preventDefault(); openAccessModal(); });
      } else {
        throw new Error(data.error || 'Could not get an answer — try again.');
      }
      return;
    }
    renderFaqAnswer(card, query, data);
  } catch (err) {
    card.innerHTML = `<div class="result-desc" style="font-weight:700;">${escapeHtml(query)}</div><div class="error-box">${escapeHtml(err.message || 'Something went wrong — try again.')}</div>`;
  } finally {
    faqAskBtn.disabled = false;
    faqInput.value = '';
  }
}

function renderFaqAnswer(card, query, data) {
  if (data.source === 'faq') {
    card.innerHTML = `
      <div class="result-desc" style="font-weight:700;">${escapeHtml(query)}</div>
      <div class="badge-row"><span class="badge badge-ok">From this site's FAQ</span></div>
      <div class="suggestion-reasoning" style="font-size:13px; color:var(--text); margin-top:8px;">${escapeHtml(data.answer)}</div>
      ${data.sourceUrl ? `<p style="margin-top:8px;"><a href="${escapeHtml(data.sourceUrl)}" target="_blank" rel="noopener" style="font-size:12px;">Official source ↗</a></p>` : ''}
    `;
  } else if (data.source === 'topic') {
    card.innerHTML = `
      <div class="result-desc" style="font-weight:700;">${escapeHtml(query)}</div>
      <div class="badge-row"><span class="badge badge-ok">From Important Information</span>${data.isFree ? '' : '<span class="badge badge-warn">Subscriber/Pro</span>'}</div>
      <div class="suggestion-reasoning" style="font-size:13px; color:var(--text); margin-top:8px;">This is covered in the <strong>${escapeHtml(data.title)}</strong> topic — ${escapeHtml(data.subtitle)}</div>
      <span class="use-code-link" id="faq-topic-link">Open this topic &rarr;</span>
    `;
    card.querySelector('#faq-topic-link')?.addEventListener('click', () => {
      showTab('info');
      (infoIndexLoaded ? Promise.resolve() : loadInfoIndex()).then(() => openInfoTopic(data.key));
    });
  } else {
    card.innerHTML = `
      <div class="result-desc" style="font-weight:700;">${escapeHtml(query)}</div>
      <div class="badge-row"><span class="badge confidence-medium">✨ AI-answered</span></div>
      <div class="suggestion-reasoning" style="font-size:13px; color:var(--text); margin-top:8px;">${escapeHtml(data.answer)}</div>
      <div class="hint" style="margin-top:8px;">${escapeHtml(data.disclaimer || '')}</div>
    `;
  }
}

// ── Init ──────────────────────────────────────────────────────────────
// ?tab=info&topic=hazchem deep-links here from the static SEO preview
// pages (info/<key>.html "Open in the free tools" button) straight into
// that specific topic, instead of just the generic tab.
(async () => {
  const params = new URLSearchParams(location.search);
  const initialTab = params.get('tab');
  const initialTopic = params.get('topic');
  if (initialTab && document.querySelector(`.tab-btn[data-tab="${initialTab}"]`)) showTab(initialTab);
  if (initialTab === 'info' && initialTopic) {
    await loadInfoIndex();
    openInfoTopic(initialTopic);
  }
  handlePayfastReturn();
})();
