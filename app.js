const SUPABASE_URL = 'https://ckaraszxheilemmynemi.supabase.co';
const SUPABASE_PUBLISHABLE_KEY = 'sb_publishable_oXQ75pz8KR1fv_FGyLkzBA_jk-oORDh';

const STORAGE = {
  legacyUsers: 'qingzhang_users_v1',
  legacySession: 'qingzhang_session_v1',
  bookCache: 'qingzhang_book_cache_v2'
};

const assetMeta = {
  cash: { label: '現金', icon: '現', className: 'cash' },
  tw: { label: '台股', icon: '台', className: 'tw' },
  us: { label: '美股', icon: '＄', className: 'us' },
  crypto: { label: '加密貨幣', icon: '₿', className: 'crypto' }
};

const expenseIcons = ['⌂', '◒', '⌁', '⌁', '◉'];
const DEFAULT_PERIOD_START_DAY = 5;
const app = document.querySelector('#app');
const supabaseClient = window.supabase?.createClient(SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY, {
  auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true }
});
let currentModal = null;
let toastTimer;
let activeUser = null;
let viewMonth = todayMonth();
let cloudSyncTimer;
let twQuoteRequestInFlight = false;
let twAutoRefreshAttemptedAt = 0;
let usQuoteRequestInFlight = false;
let usAutoRefreshAttemptedAt = 0;
let cryptoQuoteRequestInFlight = false;
let cryptoAutoRefreshAttemptedAt = 0;
let marketQuoteRefreshTimer;
let marketQuoteStartupTimer;
let marketQuoteRefreshInFlight = false;
let lastMarketQuoteRefreshAt = 0;
let marketQuoteRefreshGeneration = 0;
let monthPageDirection = 0;
const MARKET_QUOTE_REFRESH_MS = 5 * 60 * 1000;

function getLegacyUsers() {
  try { return JSON.parse(localStorage.getItem(STORAGE.legacyUsers) || '{}'); }
  catch { return {}; }
}
function cacheKey(userId) { return `${STORAGE.bookCache}:${userId}`; }
function getCachedBook(userId) {
  try { return JSON.parse(localStorage.getItem(cacheKey(userId)) || 'null'); }
  catch { return null; }
}
function cacheBook(user) { if (user?.id) localStorage.setItem(cacheKey(user.id), JSON.stringify(user)); }
function normalizeUser(user) {
  if (!user) return null;
  user.periodStartDay = normalizePeriodStartDay(user.periodStartDay);
  user.incomes ||= {};
  user.monthlyExpenses ||= [];
  user.assets ||= emptyAssets();
  user.expenses ||= [];
  user.history ||= [];
  promoteScheduledMonthData(user);
  user.cashMode ||= 'manual';
  if (!Number.isFinite(Number(user.cashManualTotal))) user.cashManualTotal = Number(user.assets.cash || 0);
  migrateLegacyCashData(user);
  user.twHoldings ||= [];
  user.twStockMode ||= 'manual';
  if (!Number.isFinite(Number(user.twManualTotal))) user.twManualTotal = Number(user.assets.tw || 0);
  migrateLegacyTwStockData(user);
  user.usHoldings ||= [];
  user.usStockMode ||= 'manual';
  if (!Number.isFinite(Number(user.usManualTotal))) user.usManualTotal = Number(user.assets.us || 0);
  migrateLegacyUsStockData(user);
  user.cryptoHoldings ||= [];
  user.cryptoMode ||= 'manual';
  if (!Number.isFinite(Number(user.cryptoManualTotal))) user.cryptoManualTotal = Number(user.assets.crypto || 0);
  migrateLegacyCryptoData(user);
  return user;
}
function getUser() { return normalizeUser(activeUser); }
function localDateISO() { const date = new Date(); return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`; }
function normalizePeriodStartDay(value) {
  const day = Math.trunc(Number(value));
  return day >= 1 && day <= 28 ? day : DEFAULT_PERIOD_START_DAY;
}
function periodStartDay(user = activeUser) { return normalizePeriodStartDay(user?.periodStartDay); }
function periodMonthForDate(dateString, startDay = periodStartDay()) {
  const [year, month, day] = String(dateString).split('-').map(Number);
  const normalizedStartDay = normalizePeriodStartDay(startDay);
  const date = new Date(year, month - 1, 1);
  if (day < normalizedStartDay) date.setMonth(date.getMonth() - 1);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`;
}
function todayMonth(user = activeUser) { return periodMonthForDate(localDateISO(), periodStartDay(user)); }
function todayDate() { return localDateISO(); }
function money(value) { return new Intl.NumberFormat('zh-TW', { maximumFractionDigits: 0 }).format(Number(value || 0)); }
function inputAmount(value) { return Number(value || 0) === 0 ? '' : String(Number(value)); }
function stockPrice(value) { return new Intl.NumberFormat('zh-TW', { minimumFractionDigits: 0, maximumFractionDigits: 2 }).format(Number(value || 0)); }
function cryptoAmount(value) { return new Intl.NumberFormat('zh-TW', { minimumFractionDigits: 0, maximumFractionDigits: 8 }).format(Number(value || 0)); }
function cryptoPrice(value) {
  const price = Number(value || 0);
  return new Intl.NumberFormat('zh-TW', { minimumFractionDigits: 0, maximumFractionDigits: price > 0 && price < 1 ? 8 : 2 }).format(price);
}
function normalizeStockSymbol(value) {
  const normalized = String(value || '').trim().toUpperCase();
  return normalized.match(/^[0-9A-Z]{4,6}/)?.[0] || '';
}
function holdingMarketValue(holding) { return Number(holding.shares || 0) * Number(holding.price || 0); }
function cloneTwHoldings(holdings) { return Array.isArray(holdings) ? holdings.map(holding => ({ ...holding })) : []; }
function normalizeTwStockState(state, fallbackManualTotal = 0) {
  const normalized = state && typeof state === 'object' ? state : {};
  if (!Array.isArray(normalized.holdings)) normalized.holdings = [];
  normalized.mode = normalized.mode === 'holdings' ? 'holdings' : 'manual';
  normalized.holdingsCustomized = normalized.holdingsCustomized === true;
  normalized.modeCustomized = normalized.modeCustomized === true;
  if (!Number.isFinite(Number(normalized.manualTotal))) normalized.manualTotal = Number(fallbackManualTotal || 0);
  return normalized;
}
function syncLegacyTwStockData(user, month = todayMonth(user)) {
  if (month !== todayMonth(user)) return;
  const state = user.twStockByMonth?.[month];
  if (!state) return;
  user.twHoldings = state.holdings;
  user.twStockMode = state.mode;
  user.twManualTotal = state.manualTotal;
}
function migrateLegacyTwStockData(user) {
  if (!user.twStockByMonth || typeof user.twStockByMonth !== 'object' || Array.isArray(user.twStockByMonth)) user.twStockByMonth = {};
  const currentMonth = todayMonth(user);
  const currentState = user.twStockByMonth[currentMonth];
  const shouldMigrateLegacy = !currentState || Number(user.twStockDataVersion || 0) < 1;
  if (shouldMigrateLegacy) {
    user.twStockByMonth[currentMonth] = normalizeTwStockState({
      holdings: cloneTwHoldings(user.twHoldings),
      mode: user.twStockMode,
      manualTotal: user.twManualTotal
    }, user.assets?.tw);
  }
  Object.entries(user.twStockByMonth).forEach(([month, state]) => {
    user.twStockByMonth[month] = normalizeTwStockState(state, month === currentMonth ? user.assets?.tw : 0);
  });
  const activeState = user.twStockByMonth[currentMonth];
  user.assets.tw = activeState.mode === 'holdings'
    ? Math.round(activeState.holdings.reduce((sum, holding) => sum + holdingMarketValue(holding), 0))
    : Number(activeState.manualTotal || 0);
  user.twStockDataVersion = 1;
  syncLegacyTwStockData(user, currentMonth);
}
function twStockState(user, month = viewMonth, { create = true } = {}) {
  migrateLegacyTwStockData(user);
  let state = user.twStockByMonth[month];
  const sourceMonth = Object.keys(user.twStockByMonth).filter(item => item < month).sort().pop();
  const source = sourceMonth ? user.twStockByMonth[sourceMonth] : null;
  let inherited = false;
  if (!state && create) {
    const monthlyAssets = month === todayMonth(user) ? user.assets : monthSnapshot(user, month)?.assets;
    state = normalizeTwStockState({
      holdings: cloneTwHoldings(source?.holdings),
      mode: source?.mode || 'manual',
      manualTotal: Number(monthlyAssets?.tw || 0),
      inheritedFrom: sourceMonth || ''
    }, monthlyAssets?.tw);
    user.twStockByMonth[month] = state;
    inherited = true;
  } else if (state && create && !state.holdings?.length && state.holdingsCustomized !== true && source?.holdings?.length) {
    state.holdings = cloneTwHoldings(source.holdings);
    if (state.modeCustomized !== true) state.mode = source.mode || 'manual';
    state.inheritedFrom = sourceMonth;
    inherited = true;
  }
  if (state) state = normalizeTwStockState(state, month === todayMonth(user) ? user.assets?.tw : monthSnapshot(user, month)?.assets?.tw);
  if (inherited && state?.mode === 'holdings') {
    const assets = month === todayMonth(user) ? user.assets : ensureMonthSnapshot(user, month).assets;
    assets.tw = Math.round(state.holdings.reduce((sum, holding) => sum + holdingMarketValue(holding), 0));
    refreshMonthSnapshotTotal(user, month);
  }
  syncLegacyTwStockData(user, month);
  return state;
}
function twHoldingsTotal(user, month = viewMonth) {
  const state = twStockState(user, month);
  return Math.round((state?.holdings || []).reduce((sum, holding) => sum + holdingMarketValue(holding), 0));
}
function nearestSavedTwHolding(user, symbol, month = viewMonth) {
  const candidates = Object.entries(user.twStockByMonth || {})
    .filter(([savedMonth]) => savedMonth !== month)
    .map(([savedMonth, state]) => ({ savedMonth, holding: state?.holdings?.find(item => item.symbol === symbol && Number(item.price) > 0) }))
    .filter(item => item.holding);
  const previous = candidates.filter(item => item.savedMonth < month).sort((a, b) => b.savedMonth.localeCompare(a.savedMonth))[0];
  const following = candidates.filter(item => item.savedMonth > month).sort((a, b) => a.savedMonth.localeCompare(b.savedMonth))[0];
  return (previous || following)?.holding || null;
}
function normalizeUsStockSymbol(value) {
  const normalized = String(value || '').trim().toUpperCase();
  return /^[A-Z][A-Z0-9.-]{0,9}$/.test(normalized) ? normalized : '';
}
function usHoldingMarketValue(holding) {
  return Number(holding.shares || 0) * Number(holding.price || 0) * Number(holding.exchangeRate || 0);
}
function cloneUsHoldings(holdings) { return Array.isArray(holdings) ? holdings.map(holding => ({ ...holding })) : []; }
function normalizeUsStockState(state, fallbackManualTotal = 0) {
  const normalized = state && typeof state === 'object' ? state : {};
  if (!Array.isArray(normalized.holdings)) normalized.holdings = [];
  normalized.mode = normalized.mode === 'holdings' ? 'holdings' : 'manual';
  normalized.holdingsCustomized = normalized.holdingsCustomized === true;
  normalized.modeCustomized = normalized.modeCustomized === true;
  if (!Number.isFinite(Number(normalized.manualTotal))) normalized.manualTotal = Number(fallbackManualTotal || 0);
  return normalized;
}
function syncLegacyUsStockData(user, month = todayMonth(user)) {
  if (month !== todayMonth(user)) return;
  const state = user.usStockByMonth?.[month];
  if (!state) return;
  user.usHoldings = state.holdings;
  user.usStockMode = state.mode;
  user.usManualTotal = state.manualTotal;
}
function migrateLegacyUsStockData(user) {
  if (!user.usStockByMonth || typeof user.usStockByMonth !== 'object' || Array.isArray(user.usStockByMonth)) user.usStockByMonth = {};
  const currentMonth = todayMonth(user);
  const currentState = user.usStockByMonth[currentMonth];
  const shouldMigrateLegacy = !currentState || Number(user.usStockDataVersion || 0) < 1;
  if (shouldMigrateLegacy) {
    user.usStockByMonth[currentMonth] = normalizeUsStockState({
      holdings: cloneUsHoldings(user.usHoldings),
      mode: user.usStockMode,
      manualTotal: user.usManualTotal
    }, user.assets?.us);
  }
  Object.entries(user.usStockByMonth).forEach(([month, state]) => {
    user.usStockByMonth[month] = normalizeUsStockState(state, month === currentMonth ? user.assets?.us : 0);
  });
  const activeState = user.usStockByMonth[currentMonth];
  user.assets.us = activeState.mode === 'holdings'
    ? Math.round(activeState.holdings.reduce((sum, holding) => sum + usHoldingMarketValue(holding), 0))
    : Number(activeState.manualTotal || 0);
  user.usStockDataVersion = 1;
  syncLegacyUsStockData(user, currentMonth);
}
function usStockState(user, month = viewMonth, { create = true } = {}) {
  migrateLegacyUsStockData(user);
  let state = user.usStockByMonth[month];
  const sourceMonth = Object.keys(user.usStockByMonth).filter(item => item < month).sort().pop();
  const source = sourceMonth ? user.usStockByMonth[sourceMonth] : null;
  let inherited = false;
  if (!state && create) {
    const monthlyAssets = month === todayMonth(user) ? user.assets : monthSnapshot(user, month)?.assets;
    state = normalizeUsStockState({
      holdings: cloneUsHoldings(source?.holdings),
      mode: source?.mode || 'manual',
      manualTotal: Number(monthlyAssets?.us || 0),
      inheritedFrom: sourceMonth || ''
    }, monthlyAssets?.us);
    user.usStockByMonth[month] = state;
    inherited = true;
  } else if (state && create && !state.holdings?.length && state.holdingsCustomized !== true && source?.holdings?.length) {
    state.holdings = cloneUsHoldings(source.holdings);
    if (state.modeCustomized !== true) state.mode = source.mode || 'manual';
    state.inheritedFrom = sourceMonth;
    inherited = true;
  }
  if (state) state = normalizeUsStockState(state, month === todayMonth(user) ? user.assets?.us : monthSnapshot(user, month)?.assets?.us);
  if (inherited && state?.mode === 'holdings') {
    const assets = month === todayMonth(user) ? user.assets : ensureMonthSnapshot(user, month).assets;
    assets.us = Math.round(state.holdings.reduce((sum, holding) => sum + usHoldingMarketValue(holding), 0));
    refreshMonthSnapshotTotal(user, month);
  }
  syncLegacyUsStockData(user, month);
  return state;
}
function usHoldingsTotal(user, month = viewMonth) {
  const state = usStockState(user, month);
  return Math.round((state?.holdings || []).reduce((sum, holding) => sum + usHoldingMarketValue(holding), 0));
}
function nearestSavedUsHolding(user, symbol, month = viewMonth) {
  const candidates = Object.entries(user.usStockByMonth || {})
    .filter(([savedMonth]) => savedMonth !== month)
    .map(([savedMonth, state]) => ({ savedMonth, holding: state?.holdings?.find(item => item.symbol === symbol && Number(item.price) > 0 && Number(item.exchangeRate) > 0) }))
    .filter(item => item.holding);
  const previous = candidates.filter(item => item.savedMonth < month).sort((a, b) => b.savedMonth.localeCompare(a.savedMonth))[0];
  const following = candidates.filter(item => item.savedMonth > month).sort((a, b) => a.savedMonth.localeCompare(b.savedMonth))[0];
  return (previous || following)?.holding || null;
}
function normalizeCryptoSymbol(value) {
  const normalized = String(value || '').trim().toUpperCase();
  return /^[A-Z0-9]{2,10}$/.test(normalized) ? normalized : '';
}
function cryptoHoldingMarketValue(holding) {
  return Number(holding.amount || 0) * Number(holding.price || 0) * Number(holding.exchangeRate || 0);
}
function cloneCryptoHoldings(holdings) { return Array.isArray(holdings) ? holdings.map(holding => ({ ...holding })) : []; }
function normalizeCryptoState(state, fallbackManualTotal = 0) {
  const normalized = state && typeof state === 'object' ? state : {};
  if (!Array.isArray(normalized.holdings)) normalized.holdings = [];
  normalized.mode = normalized.mode === 'holdings' ? 'holdings' : 'manual';
  normalized.holdingsCustomized = normalized.holdingsCustomized === true;
  normalized.modeCustomized = normalized.modeCustomized === true;
  if (!Number.isFinite(Number(normalized.manualTotal))) normalized.manualTotal = Number(fallbackManualTotal || 0);
  return normalized;
}
function syncLegacyCryptoData(user, month = todayMonth(user)) {
  if (month !== todayMonth(user)) return;
  const state = user.cryptoByMonth?.[month];
  if (!state) return;
  user.cryptoHoldings = state.holdings;
  user.cryptoMode = state.mode;
  user.cryptoManualTotal = state.manualTotal;
}
function migrateLegacyCryptoData(user) {
  if (!user.cryptoByMonth || typeof user.cryptoByMonth !== 'object' || Array.isArray(user.cryptoByMonth)) user.cryptoByMonth = {};
  const currentMonth = todayMonth(user);
  const currentState = user.cryptoByMonth[currentMonth];
  const shouldMigrateLegacy = !currentState || Number(user.cryptoDataVersion || 0) < 1;
  if (shouldMigrateLegacy) {
    user.cryptoByMonth[currentMonth] = normalizeCryptoState({
      holdings: cloneCryptoHoldings(user.cryptoHoldings),
      mode: user.cryptoMode,
      manualTotal: user.cryptoManualTotal
    }, user.assets?.crypto);
  }
  Object.entries(user.cryptoByMonth).forEach(([month, state]) => {
    user.cryptoByMonth[month] = normalizeCryptoState(state, month === currentMonth ? user.assets?.crypto : 0);
  });
  const activeState = user.cryptoByMonth[currentMonth];
  user.assets.crypto = activeState.mode === 'holdings'
    ? Math.round(activeState.holdings.reduce((sum, holding) => sum + cryptoHoldingMarketValue(holding), 0))
    : Number(activeState.manualTotal || 0);
  user.cryptoDataVersion = 1;
  syncLegacyCryptoData(user, currentMonth);
}
function cryptoState(user, month = viewMonth, { create = true } = {}) {
  migrateLegacyCryptoData(user);
  let state = user.cryptoByMonth[month];
  const sourceMonth = Object.keys(user.cryptoByMonth).filter(item => item < month).sort().pop();
  const source = sourceMonth ? user.cryptoByMonth[sourceMonth] : null;
  let inherited = false;
  if (!state && create) {
    const monthlyAssets = month === todayMonth(user) ? user.assets : monthSnapshot(user, month)?.assets;
    state = normalizeCryptoState({
      holdings: cloneCryptoHoldings(source?.holdings),
      mode: source?.mode || 'manual',
      manualTotal: Number(monthlyAssets?.crypto || 0),
      inheritedFrom: sourceMonth || ''
    }, monthlyAssets?.crypto);
    user.cryptoByMonth[month] = state;
    inherited = true;
  } else if (state && create && !state.holdings?.length && state.holdingsCustomized !== true && source?.holdings?.length) {
    state.holdings = cloneCryptoHoldings(source.holdings);
    if (state.modeCustomized !== true) state.mode = source.mode || 'manual';
    state.inheritedFrom = sourceMonth;
    inherited = true;
  }
  if (state) state = normalizeCryptoState(state, month === todayMonth(user) ? user.assets?.crypto : monthSnapshot(user, month)?.assets?.crypto);
  if (inherited && state?.mode === 'holdings') {
    const assets = month === todayMonth(user) ? user.assets : ensureMonthSnapshot(user, month).assets;
    assets.crypto = Math.round(state.holdings.reduce((sum, holding) => sum + cryptoHoldingMarketValue(holding), 0));
    refreshMonthSnapshotTotal(user, month);
  }
  syncLegacyCryptoData(user, month);
  return state;
}
function cryptoHoldingsTotal(user, month = viewMonth) {
  const state = cryptoState(user, month);
  return Math.round((state?.holdings || []).reduce((sum, holding) => sum + cryptoHoldingMarketValue(holding), 0));
}
function nearestSavedCryptoHolding(user, symbol, month = viewMonth) {
  const candidates = Object.entries(user.cryptoByMonth || {})
    .filter(([savedMonth]) => savedMonth !== month)
    .map(([savedMonth, state]) => ({ savedMonth, holding: state?.holdings?.find(item => item.symbol === symbol && Number(item.price) > 0 && Number(item.exchangeRate) > 0) }))
    .filter(item => item.holding);
  const previous = candidates.filter(item => item.savedMonth < month).sort((a, b) => b.savedMonth.localeCompare(a.savedMonth))[0];
  const following = candidates.filter(item => item.savedMonth > month).sort((a, b) => a.savedMonth.localeCompare(b.savedMonth))[0];
  return (previous || following)?.holding || null;
}
function normalizeCashMode(mode) {
  return ['manual', 'income', 'ending'].includes(mode) ? mode : 'manual';
}
function normalizeCashState(state, fallbackManualTotal = 0) {
  const normalized = state && typeof state === 'object' ? state : {};
  normalized.mode = normalizeCashMode(normalized.mode);
  if (!Number.isFinite(Number(normalized.manualTotal))) normalized.manualTotal = Number(fallbackManualTotal || 0);
  return normalized;
}
function syncLegacyCashData(user, month = todayMonth(user)) {
  if (month !== todayMonth(user)) return;
  const state = user.cashByMonth?.[month];
  if (!state) return;
  user.cashMode = state.mode;
  user.cashManualTotal = state.manualTotal;
}
function migrateLegacyCashData(user) {
  if (!user.cashByMonth || typeof user.cashByMonth !== 'object' || Array.isArray(user.cashByMonth)) user.cashByMonth = {};
  const currentMonth = todayMonth(user);
  const currentState = user.cashByMonth[currentMonth];
  const shouldMigrateLegacy = !currentState || Number(user.cashDataVersion || 0) < 1;
  if (shouldMigrateLegacy) {
    user.cashByMonth[currentMonth] = normalizeCashState({
      mode: user.cashMode,
      manualTotal: user.cashManualTotal
    }, user.assets?.cash);
  }
  Object.entries(user.cashByMonth).forEach(([month, state]) => {
    const monthlyAssets = month === currentMonth ? user.assets : monthSnapshot(user, month)?.assets;
    user.cashByMonth[month] = normalizeCashState(state, monthlyAssets?.cash);
  });
  const activeState = user.cashByMonth[currentMonth];
  if (activeState.mode === 'manual') user.assets.cash = Number(activeState.manualTotal || 0);
  user.cashDataVersion = 1;
  syncLegacyCashData(user, currentMonth);
}
function cashState(user, month = viewMonth, { create = true } = {}) {
  migrateLegacyCashData(user);
  let state = user.cashByMonth[month];
  if (!state && create) {
    const sourceMonth = Object.keys(user.cashByMonth).filter(item => item < month).sort().pop();
    const source = sourceMonth ? user.cashByMonth[sourceMonth] : null;
    const monthlyAssets = rawAssetsForMonth(user, month);
    state = normalizeCashState({
      mode: source?.mode || 'manual',
      manualTotal: Number(monthlyAssets?.cash ?? source?.manualTotal ?? 0)
    }, monthlyAssets?.cash);
    user.cashByMonth[month] = state;
  }
  if (state) state = normalizeCashState(state, rawAssetsForMonth(user, month)?.cash);
  syncLegacyCashData(user, month);
  return state;
}
function quoteTimeText(value) {
  if (!value) return '';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? '' : date.toLocaleString('zh-TW', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false });
}
function calculateAmount(expression) {
  const normalized = String(expression ?? '').replace(/[，,\s]/g, '').replace(/×/g, '*').replace(/÷/g, '/');
  if (!normalized || !/^[0-9+\-*/().]+$/.test(normalized)) return null;
  try {
    const result = Function(`"use strict"; return (${normalized})`)();
    return Number.isFinite(result) && result >= 0 ? Math.round(result) : null;
  } catch { return null; }
}
function enableAmountCalculator(form) {
  form.querySelectorAll('[data-calculator]').forEach(input => {
    const preview = document.createElement('p');
    preview.className = 'calculation-preview';
    input.insertAdjacentElement('afterend', preview);
    const updatePreview = (commit = false) => {
      const result = calculateAmount(input.value);
      if (!input.value) { preview.textContent = ''; input.setCustomValidity(''); return; }
      if (result === null) { preview.textContent = '請使用數字與 + − × ÷ ( )'; input.setCustomValidity('請輸入可計算的非負金額'); return; }
      input.setCustomValidity('');
      preview.textContent = `= NT$ ${money(result)}`;
      if (commit) input.value = String(result);
    };
    input.addEventListener('input', () => updatePreview());
    input.addEventListener('blur', () => updatePreview());
    updatePreview();
  });
}
function amountFromForm(form, field) {
  const input = form.elements[field];
  const result = calculateAmount(input.value);
  if (result === null) { input.setCustomValidity('請輸入可計算的非負金額'); input.reportValidity(); input.focus(); return null; }
  input.value = String(result);
  input.setCustomValidity('');
  return result;
}
function monthText(month) { const [year, mon] = month.split('-'); return `${year} 年 ${Number(mon)} 月`; }
function periodRangeText(month, user = activeUser) {
  const [year, mon] = month.split('-').map(Number);
  const startDay = periodStartDay(user);
  const end = new Date(year, mon, startDay - 1);
  return `${mon}/${startDay} - ${end.getMonth() + 1}/${end.getDate()}`;
}
function periodEndDate(month, user = activeUser) {
  const [year, mon] = month.split('-').map(Number);
  const end = new Date(year, mon, periodStartDay(user) - 1);
  return `${end.getFullYear()}-${String(end.getMonth() + 1).padStart(2, '0')}-${String(end.getDate()).padStart(2, '0')}`;
}
function dateText(date) { const [, month, day] = date.split('-'); return `${Number(month)}/${Number(day)}`; }
function initials(name) { return (name || '我').trim().slice(0, 1).toUpperCase(); }
function escapeHTML(text) { const el = document.createElement('div'); el.textContent = text; return el.innerHTML; }
function emptyAssets() { return { cash: 0, tw: 0, us: 0, crypto: 0 }; }
function monthSnapshot(user, month = viewMonth) { return user.history.find(item => item.month === month); }
function cloneFixedExpenses(expenses) { return expenses.map(item => ({ ...item })); }
function promoteScheduledMonthData(user) {
  const currentMonth = todayMonth(user);
  if (!user.activeAssetMonth) { user.activeAssetMonth = currentMonth; return; }
  if (user.activeAssetMonth === currentMonth) return;
  const scheduled = user.history.find(item => item.month === currentMonth);
  if (scheduled?.assets) user.assets = { ...scheduled.assets };
  if (scheduled?.fixedExpenses) user.expenses = cloneFixedExpenses(scheduled.fixedExpenses);
  user.activeAssetMonth = currentMonth;
}
function carriedAssetsForFutureMonth(user, month) {
  let sourceMonth = todayMonth(user);
  let sourceAssets = user.assets;
  user.history.forEach(item => {
    if (item.assets && item.month > sourceMonth && item.month < month) {
      sourceMonth = item.month;
      sourceAssets = item.assets;
    }
  });
  return { ...sourceAssets };
}
function ensureMonthSnapshot(user, month = viewMonth) {
  let snapshot = monthSnapshot(user, month);
  if (!snapshot) {
    const assets = month === todayMonth(user) ? { ...user.assets } : month > todayMonth(user) ? carriedAssetsForFutureMonth(user, month) : emptyAssets();
    snapshot = { month, total: 0, assets, fixedExpenses: cloneFixedExpenses(user.expenses) };
    user.history.push(snapshot);
  }
  snapshot.assets ||= emptyAssets();
  snapshot.fixedExpenses ||= cloneFixedExpenses(user.expenses);
  return snapshot;
}
function refreshMonthSnapshotTotal(user, month) {
  const snapshot = monthSnapshot(user, month);
  if (snapshot) snapshot.total = totalAssets(user, month);
}
function rawAssetsForMonth(user, month = viewMonth) {
  if (month === todayMonth(user)) return user.assets;
  return monthSnapshot(user, month)?.assets || emptyAssets();
}
function assetsForMonth(user, month = viewMonth) {
  return { ...rawAssetsForMonth(user, month), cash: cashValueForMonth(user, month) };
}
function fixedExpensesForMonth(user, month = viewMonth) {
  if (month === todayMonth(user)) return user.expenses;
  return monthSnapshot(user, month)?.fixedExpenses || user.expenses;
}
function hasManualExpenseOrder(expenses) { return expenses.some(expense => Number.isFinite(Number(expense.sortOrder))); }
function orderedFixedExpenses(expenses) {
  const manuallyOrdered = hasManualExpenseOrder(expenses);
  return expenses.slice().sort((a, b) => {
    if (manuallyOrdered) {
      const orderA = Number.isFinite(Number(a.sortOrder)) ? Number(a.sortOrder) : Number.MAX_SAFE_INTEGER;
      const orderB = Number.isFinite(Number(b.sortOrder)) ? Number(b.sortOrder) : Number.MAX_SAFE_INTEGER;
      if (orderA !== orderB) return orderA - orderB;
    }
    return Number(a.day || 0) - Number(b.day || 0);
  });
}
function grossAssets(user, month = viewMonth) { return Object.values(assetsForMonth(user, month)).reduce((total, amount) => total + Number(amount || 0), 0); }
function incomeForMonth(user, month = todayMonth(user)) { return { salary: 0, other: 0, otherNote: '', ...(user.incomes[month] || {}) }; }
function expensesForMonth(user, month = todayMonth(user)) { return user.monthlyExpenses.filter(item => item.date && periodMonthForDate(item.date, periodStartDay(user)) === month); }
function fixedExpenseTotal(user, month = viewMonth) { return fixedExpensesForMonth(user, month).reduce((sum, item) => sum + Number(item.amount || 0), 0); }
function cashExpenseTotal(user, month = viewMonth) { return expensesForMonth(user, month).filter(item => item.payment === 'cash').reduce((sum, item) => sum + Number(item.amount || 0), 0); }
function creditCardSpendTotal(user, month = viewMonth) { return expensesForMonth(user, month).filter(item => item.payment === 'card').reduce((sum, item) => sum + Number(item.amount || 0), 0); }
function creditCardPaymentDue(user, month = viewMonth) { return creditCardSpendTotal(user, previousMonth(month)); }
function incomeTotalForMonth(user, month = viewMonth) {
  const income = incomeForMonth(user, month);
  return Number(income.salary || 0) + Number(income.other || 0);
}
function actualMonthlyOutgoingsForMonth(user, month = viewMonth) {
  return cashExpenseTotal(user, month) + creditCardPaymentDue(user, month) + fixedExpenseTotal(user, month);
}
function cashValueForMonth(user, month = viewMonth, visited = new Set()) {
  const state = cashState(user, month);
  if (!state || state.mode === 'manual') return Number(state?.manualTotal ?? rawAssetsForMonth(user, month)?.cash ?? 0);
  if (visited.has(month)) return Number(state.manualTotal || 0);
  const nextVisited = new Set(visited);
  nextVisited.add(month);
  const previousEnding = endingCashForMonth(user, previousMonth(month), nextVisited);
  const availableCash = previousEnding + incomeTotalForMonth(user, month);
  return state.mode === 'ending' ? availableCash - actualMonthlyOutgoingsForMonth(user, month) : availableCash;
}
function endingCashForMonth(user, month = viewMonth, visited = new Set()) {
  const cash = cashValueForMonth(user, month, visited);
  return cashState(user, month)?.mode === 'ending' ? cash : cash - actualMonthlyOutgoingsForMonth(user, month);
}
function cashFormulaParts(user, month = viewMonth) {
  return {
    previousEnding: endingCashForMonth(user, previousMonth(month)),
    income: incomeTotalForMonth(user, month),
    outgoings: actualMonthlyOutgoingsForMonth(user, month)
  };
}
function totalAssets(user, month = viewMonth) {
  const gross = grossAssets(user, month);
  return cashState(user, month)?.mode === 'manual' ? gross - actualMonthlyOutgoingsForMonth(user, month) : gross;
}
function refreshAllSnapshotTotals(user) {
  user.history.forEach(snapshot => {
    if (snapshot.assets) snapshot.total = totalAssets(user, snapshot.month);
  });
}
function previousMonth(month = todayMonth()) { const [year, mon] = month.split('-').map(Number); const date = new Date(year, mon - 2, 1); return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`; }
function monthlyChange(user, currentTotal, month = viewMonth) {
  const previous = monthSnapshot(user, previousMonth(month));
  if (!previous || Number(previous.total) === 0) return { className: 'neutral', label: '尚無上月比較資料' };
  const previousTotal = previous.assets ? totalAssets(user, previous.month) : Number(previous.total);
  if (previousTotal === 0) return { className: 'neutral', label: '尚無上月比較資料' };
  const change = ((currentTotal - previousTotal) / Math.abs(previousTotal)) * 100;
  return { className: change >= 0 ? 'up' : 'down', label: `${change >= 0 ? '↗' : '↘'} ${Math.abs(change).toFixed(1)}% 較上月` };
}
function shiftMonth(month, amount) { const [year, mon] = month.split('-').map(Number); const date = new Date(year, mon - 1 + amount, 1); return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`; }

function defaultUser(name, email) {
  return {
    name, email,
    periodStartDay: DEFAULT_PERIOD_START_DAY,
    assets: { cash: 0, tw: 0, us: 0, crypto: 0 },
    expenses: [],
    incomes: {},
    monthlyExpenses: [],
    cashMode: 'manual',
    cashManualTotal: 0,
    cashByMonth: {},
    cashDataVersion: 0,
    twHoldings: [],
    twStockMode: 'manual',
    twManualTotal: 0,
    twStockByMonth: {},
    twStockDataVersion: 0,
    usHoldings: [],
    usStockMode: 'manual',
    usManualTotal: 0,
    usStockByMonth: {},
    usStockDataVersion: 0,
    cryptoHoldings: [],
    cryptoMode: 'manual',
    cryptoManualTotal: 0,
    cryptoByMonth: {},
    cryptoDataVersion: 0,
    activeAssetMonth: '',
    history: [{ month: todayMonth(), total: 0 }],
    createdAt: new Date().toISOString()
  };
}

function persistUser(user) {
  activeUser = normalizeUser(user);
  refreshAllSnapshotTotals(activeUser);
  cacheBook(activeUser);
  window.clearTimeout(cloudSyncTimer);
  cloudSyncTimer = window.setTimeout(() => syncBookToCloud(), 350);
}

function bookPayload(user) {
  return {
    periodStartDay: user.periodStartDay,
    assets: user.assets,
    expenses: user.expenses,
    incomes: user.incomes,
    monthlyExpenses: user.monthlyExpenses,
    cashMode: user.cashMode,
    cashManualTotal: user.cashManualTotal,
    cashByMonth: user.cashByMonth,
    cashDataVersion: user.cashDataVersion,
    twHoldings: user.twHoldings,
    twStockMode: user.twStockMode,
    twManualTotal: user.twManualTotal,
    twStockByMonth: user.twStockByMonth,
    twStockDataVersion: user.twStockDataVersion,
    usHoldings: user.usHoldings,
    usStockMode: user.usStockMode,
    usManualTotal: user.usManualTotal,
    usStockByMonth: user.usStockByMonth,
    usStockDataVersion: user.usStockDataVersion,
    cryptoHoldings: user.cryptoHoldings,
    cryptoMode: user.cryptoMode,
    cryptoManualTotal: user.cryptoManualTotal,
    cryptoByMonth: user.cryptoByMonth,
    cryptoDataVersion: user.cryptoDataVersion,
    activeAssetMonth: user.activeAssetMonth,
    history: user.history,
    createdAt: user.createdAt || new Date().toISOString()
  };
}

function nameFromAuth(authUser) {
  return String(authUser.user_metadata?.display_name || authUser.email?.split('@')[0] || '我').slice(0, 30);
}

function makeUserFromCloud(authUser, row) {
  const legacy = getLegacyUsers()[authUser.email] || null;
  const cached = getCachedBook(authUser.id);
  const source = row?.book || legacy || cached || {};
  const user = normalizeUser({
    ...defaultUser(row?.display_name || source.name || nameFromAuth(authUser), authUser.email),
    ...source,
    id: authUser.id,
    email: authUser.email,
    name: row?.display_name || source.name || nameFromAuth(authUser)
  });
  delete user.passwordHash;
  return user;
}

async function syncBookToCloud({ quiet = false } = {}) {
  if (!supabaseClient || !activeUser?.id) return false;
  const { error } = await supabaseClient.from('user_books').upsert({
    user_id: activeUser.id,
    display_name: activeUser.name,
    book: bookPayload(activeUser)
  }, { onConflict: 'user_id' });
  if (error) {
    console.error('Supabase sync failed', error);
    if (!quiet) showToast('暫時無法同步到雲端，資料已保留在此裝置。');
    return false;
  }
  cacheBook(activeUser);
  return true;
}

async function loadCloudBook(authUser) {
  if (!supabaseClient) { renderCloudSetupError('無法載入雲端服務。請重新整理後再試。'); return; }
  const { data, error } = await supabaseClient.from('user_books').select('display_name, book').eq('user_id', authUser.id).maybeSingle();
  if (error) {
    console.error('Supabase load failed', error);
    const cached = getCachedBook(authUser.id);
    if (cached) {
      activeUser = normalizeUser(cached);
      viewMonth = todayMonth(activeUser);
      renderDashboard();
      startMarketQuoteUpdates();
      showToast('目前離線，顯示此裝置的暫存資料。');
      return;
    }
    renderCloudSetupError('雲端帳本尚未完成設定。請先建立資料表與安全規則。');
    return;
  }
  activeUser = makeUserFromCloud(authUser, data);
  viewMonth = todayMonth(activeUser);
  cacheBook(activeUser);
  if (!data) await syncBookToCloud({ quiet: true });
  renderDashboard();
  startMarketQuoteUpdates();
}

function renderCloudSetupError(message) {
  app.innerHTML = `<main class="auth-screen"><div class="auth-shell"><section class="auth-card"><span class="eyebrow">雲端設定</span><h1>還差最後一步。</h1><p class="subtle">${escapeHTML(message)}</p><p class="auth-note">完成 Supabase 的資料表設定後，重新整理青帳即可。</p><button class="button primary" id="cloud-retry" type="button">重新整理</button></section></div></main>`;
  app.querySelector('#cloud-retry').addEventListener('click', () => window.location.reload());
}

function showToast(message) {
  document.querySelector('.toast')?.remove();
  clearTimeout(toastTimer);
  const toast = document.createElement('div');
  toast.className = 'toast'; toast.textContent = message;
  document.body.append(toast);
  toastTimer = setTimeout(() => toast.remove(), 2600);
}

function renderAuth(mode = 'login') {
  stopMarketQuoteUpdates();
  app.innerHTML = `
    <main class="auth-screen">
      <div class="auth-shell">
        <div class="brand" aria-label="青"><span class="brand-mark">青</span></div>
        <section class="auth-card">
          <span class="eyebrow">Your personal money space</span>
          <h1>${mode === 'login' ? '歡迎回來。' : '從今天開始，\n看見你的資產。'}</h1>
          <p class="subtle">${mode === 'login' ? '登入後，可在手機與電腦繼續追蹤每一個月的財務變化。' : '建立一個只屬於你的雲端資產帳本，資料會安全同步。'}</p>
          <div class="tabs"><button class="tab ${mode === 'login' ? 'active' : ''}" data-auth-mode="login">登入</button><button class="tab ${mode === 'register' ? 'active' : ''}" data-auth-mode="register">建立帳號</button></div>
          <form id="auth-form">
            ${mode === 'register' ? '<div class="form-row"><label for="name">你的稱呼</label><input id="name" name="name" autocomplete="name" placeholder="例如：小青" required maxlength="30"></div>' : ''}
            <div class="form-row"><label for="email">電子信箱</label><input id="email" name="email" type="email" autocomplete="email" placeholder="you@example.com" required></div>
            <div class="form-row"><label for="password">密碼</label><input id="password" name="password" type="password" autocomplete="${mode === 'login' ? 'current-password' : 'new-password'}" placeholder="至少 6 個字元" required minlength="6"></div>
            <div id="form-error" class="form-error"></div>
            <button class="button primary" type="submit">${mode === 'login' ? '登入我的帳本' : '建立我的帳本'}</button>
          </form>
          <p class="auth-note">登入狀態會保留，之後可直接從手機桌面開啟。</p>
        </section>
      </div>
    </main>`;
  app.querySelectorAll('[data-auth-mode]').forEach(button => button.addEventListener('click', () => renderAuth(button.dataset.authMode)));
  app.querySelector('#auth-form').addEventListener('submit', event => handleAuth(event, mode));
}

async function handleAuth(event, mode) {
  event.preventDefault();
  if (!supabaseClient) { renderCloudSetupError('無法載入雲端服務。請重新整理後再試。'); return; }
  const form = new FormData(event.target);
  const email = String(form.get('email')).trim().toLowerCase();
  const password = String(form.get('password'));
  const error = app.querySelector('#form-error');
  const submitButton = app.querySelector('#auth-form button[type="submit"]');
  submitButton.disabled = true;
  submitButton.textContent = mode === 'login' ? '登入中…' : '建立中…';
  if (mode === 'register') {
    const name = String(form.get('name')).trim();
    if (!name) { error.textContent = '請填寫你的稱呼。'; submitButton.disabled = false; submitButton.textContent = '建立我的帳本'; return; }
    const { data, error: authError } = await supabaseClient.auth.signUp({
      email,
      password,
      options: { data: { display_name: name }, emailRedirectTo: window.location.origin + window.location.pathname }
    });
    if (authError) { error.textContent = authError.message; submitButton.disabled = false; submitButton.textContent = '建立我的帳本'; return; }
    if (!data.session) {
      error.textContent = '驗證信已寄出，請到信箱完成驗證後再回來登入。';
      submitButton.disabled = false;
      submitButton.textContent = '建立我的帳本';
      return;
    }
    await loadCloudBook(data.user);
    showToast('雲端帳本已建立，從這裡開始吧！');
    return;
  }
  const { data, error: authError } = await supabaseClient.auth.signInWithPassword({ email, password });
  if (authError) { error.textContent = '電子信箱或密碼不正確，或帳號尚未完成驗證。'; submitButton.disabled = false; submitButton.textContent = '登入我的帳本'; return; }
  await loadCloudBook(data.user);
  showToast(`歡迎回來，${getUser()?.name || '你'}！`);
}

function renderDashboard() {
  const user = getUser();
  if (!user) { renderAuth(); return; }
  refreshAllSnapshotTotals(user);
  const total = totalAssets(user, viewMonth);
  const fixedExpenses = fixedExpenseTotal(user, viewMonth);
  const viewedAssets = assetsForMonth(user, viewMonth);
  const viewedFixedExpenses = fixedExpensesForMonth(user, viewMonth);
  const thisMonthIncome = incomeForMonth(user, viewMonth);
  const thisMonthIncomeTotal = Number(thisMonthIncome.salary || 0) + Number(thisMonthIncome.other || 0);
  const thisMonthExpenses = expensesForMonth(user, viewMonth);
  const cashExpenses = cashExpenseTotal(user, viewMonth);
  const cardExpenses = creditCardSpendTotal(user, viewMonth);
  const cardPaymentDue = creditCardPaymentDue(user, viewMonth);
  const actualMonthlyOutgoings = fixedExpenses + cashExpenses + cardPaymentDue;
  const monthlyBalance = thisMonthIncomeTotal - actualMonthlyOutgoings;
  const endingCash = endingCashForMonth(user, viewMonth);
  const comparison = monthlyChange(user, total, viewMonth);
  const chartHistory = user.history.filter(item => item.month <= todayMonth());
  const monthPageClass = monthPageDirection > 0 ? 'month-page-next' : monthPageDirection < 0 ? 'month-page-previous' : '';
  const monthDateClass = monthPageDirection ? 'month-date-flash' : '';
  app.innerHTML = `
    <main class="app-shell ${monthPageClass}">
      <header class="topbar">
        <div class="brand" aria-label="青"><span class="brand-mark">青</span></div>
        <div class="user-menu"><span class="avatar">${escapeHTML(initials(user.name))}</span><button class="icon-button" id="settings-button" aria-label="開啟設定">⋯</button></div>
      </header>
      <section class="overview">
        <p class="overview-label">我的總資產</p>
        <div class="total-number">$ ${money(total)}</div>
        <span class="currency-label">TWD</span>
        <div class="overview-ending-cash"><span>本月期末現金</span><strong>${endingCash >= 0 ? '' : '−'} NT$ ${money(Math.abs(endingCash))}</strong></div>
        <div class="overview-bottom"><div class="overview-meta"><div class="date-chip overview-month-control ${monthDateClass}" aria-label="切換查看月份"><button class="overview-month-arrow" data-month-shift="-1" aria-label="上個月">‹</button><label class="overview-month-label"><span>${monthText(viewMonth)}（${periodRangeText(viewMonth, user)}）</span><input class="view-month-input" type="month" value="${viewMonth}" aria-label="選擇查看月份"></label><button class="overview-month-arrow" data-month-shift="1" aria-label="下個月">›</button></div><span class="change-chip ${comparison.className}">${comparison.label}</span></div></div>
      </section>
      <div class="dashboard-grid">
        <section>
          <div class="section-heading"><div><h2>資產配置</h2><p>點選卡片，更新目前總價</p></div><button class="text-button" id="asset-summary-button">查看明細</button></div>
          <div class="asset-grid">${Object.entries(assetMeta).map(([key, meta]) => `
            <button class="asset-card ${meta.className}" data-asset="${key}"><span class="asset-icon">${meta.icon}</span><small>${meta.label}</small><strong>$ ${money(viewedAssets[key])}</strong><span class="edit-hint">更新 ${monthText(viewMonth)} →</span></button>`).join('')}</div>
          <div class="section-heading"><div><h2>資產趨勢</h2><p>每一格代表 NT$100,000</p></div><button class="text-button" id="history-button">編輯紀錄</button></div>
          <section class="chart-card"><div class="chart-header"><div><h3>總資產變化</h3><span>${chartHistory.length > 1 ? `已追蹤 ${chartHistory.length} 個月份` : '同步本月資產後，會顯示走勢'}</span></div><span class="chart-caption">NT$ 100K / 格</span></div><div id="asset-chart" class="chart-wrap"></div></section>
        </section>
        <section>
          <div class="section-heading"><div><h2>本月收入</h2><p>${monthText(viewMonth)} · 合計 NT$ ${money(thisMonthIncomeTotal)}</p></div><button class="text-button" id="edit-income-button">更新收入</button></div>
          <section class="income-card" id="income">${renderIncome(thisMonthIncome, thisMonthIncomeTotal)}</section>
          <div class="section-heading"><div><h2>每月固定開銷</h2><p>${monthText(viewMonth)} · 合計 NT$ ${money(fixedExpenses)} / 月</p></div><button class="text-button" id="add-expense-button">＋ 新增</button></div>
          <section class="expense-card" id="expenses">${renderExpenses(viewedFixedExpenses)}</section>
          <div class="section-heading"><div><h2>本月開銷</h2><p>${monthText(viewMonth)} · 現金 NT$ ${money(cashExpenses)} · 本月刷卡 NT$ ${money(cardExpenses)}</p></div><button class="text-button" id="add-monthly-expense-button">＋ 記一筆</button></div>
          <section class="expense-card" id="monthly-expenses">${renderMonthlyExpenses(thisMonthExpenses)}</section>
          <section class="card-payment-card"><div><span>本月信用卡應繳</span><small>${monthText(previousMonth(viewMonth))}信用卡消費 · ${viewMonth}-25 繳納</small></div><strong>NT$ ${money(cardPaymentDue)}</strong></section>
          <section class="monthly-balance-card ${monthlyBalance >= 0 ? 'positive' : 'negative'}"><div class="balance-heading"><span>本月收支結餘</span><strong>${monthlyBalance >= 0 ? '+' : '−'} NT$ ${money(Math.abs(monthlyBalance))}</strong></div><div class="balance-formula"><span>收入 NT$ ${money(thisMonthIncomeTotal)}</span><span>－ 總開銷 NT$ ${money(actualMonthlyOutgoings)}</span></div><div class="balance-breakdown"><span>固定開銷 NT$ ${money(fixedExpenses)}</span><span>現金開銷 NT$ ${money(cashExpenses)}</span><span>信用卡應繳 NT$ ${money(cardPaymentDue)}</span></div></section>
        </section>
      </div>
    </main>
    <nav class="bottom-nav" aria-label="主要功能"><button class="active" id="mobile-overview"><span class="nav-icon">⌂</span>總覽</button><button id="mobile-history"><span class="nav-icon">⌁</span>趨勢</button><button id="mobile-expense"><span class="nav-icon">◒</span>本月開銷</button></nav>`;
  drawChart(chartHistory);
  bindDashboard();
  monthPageDirection = 0;
}

function renderExpenses(expenses) {
  if (!expenses.length) return '<p class="expense-empty">還沒有固定開銷。<br>例如房租、訂閱服務或保險費。</p>';
  return orderedFixedExpenses(expenses).map((expense, index) => `<button class="expense-row fixed-expense-row" data-expense="${expense.id}" title="拖曳左側圖示排序；點選其餘區域可編輯 ${escapeHTML(expense.name)}"><span class="drag-handle" aria-hidden="true">⠿</span><span class="expense-icon">${expenseIcons[index % expenseIcons.length]}</span><span><span class="expense-name">${escapeHTML(expense.name)}</span><span class="expense-meta">每月 ${expense.day} 日${expense.category ? ` · ${escapeHTML(expense.category)}` : ''}</span></span><strong class="expense-amount">$ ${money(expense.amount)}</strong></button>`).join('');
}

function renderIncome(income, total) {
  return `<div class="income-total"><span>本月收入合計</span><strong>$ ${money(total)}</strong></div><div class="income-breakdown"><div class="income-item salary"><span class="income-symbol">＋</span><span><small>薪資收入</small><strong>$ ${money(income.salary)}</strong></span></div><div class="income-item other"><span class="income-symbol">＋</span><span><small>其他收入</small><strong>$ ${money(income.other)}</strong>${income.otherNote ? `<em class="income-note">${escapeHTML(income.otherNote)}</em>` : ''}</span></div></div>`;
}

function renderMonthlyExpenses(expenses) {
  if (!expenses.length) return '<p class="expense-empty">還沒有本月開銷。<br>記下每筆現金或信用卡消費吧。</p>';
  const total = expenses.reduce((sum, expense) => sum + Number(expense.amount || 0), 0);
  const rows = expenses.slice().sort((a, b) => b.date.localeCompare(a.date)).map(expense => { const label = expense.payment === 'card' ? '信用卡消費' : '現金開銷'; return `<button class="expense-row monthly-row" data-monthly-expense="${expense.id}" title="編輯${label}"><span class="expense-icon ${expense.payment === 'card' ? 'card-icon' : 'cash-icon'}">${expense.payment === 'card' ? '▣' : '⌁'}</span><span><span class="expense-name">${label}</span><span class="expense-meta">${dateText(expense.date)} <span class="payment-chip ${expense.payment}">${expense.payment === 'card' ? '下月繳' : '已支出'}</span></span></span><strong class="expense-amount">$ ${money(expense.amount)}</strong></button>`; }).join('');
  return `${rows}<div class="monthly-expense-total"><span>本月消費總額</span><strong>NT$ ${money(total)}</strong></div>`;
}

function drawChart(history) {
  const host = document.querySelector('#asset-chart');
  if (!host) return;
  const data = history.slice().sort((a, b) => a.month.localeCompare(b.month));
  if (data.length < 2) { host.innerHTML = '<div class="empty-chart">同步本月資產後，<br>下個月就能在這裡看見資產走勢。</div>'; return; }
  const width = 620, height = 244, left = 64, right = 14, top = 13, bottom = 35;
  const values = data.map(item => Number(item.total));
  const step = 100000;
  const max = Math.max(step, Math.ceil(Math.max(...values) / step) * step);
  const min = Math.min(0, Math.floor(Math.min(...values) / step) * step - (values.every(v => v === 0) ? 0 : step));
  const range = Math.max(step, max - min);
  const y = value => top + (max - value) / range * (height - top - bottom);
  const x = index => left + (data.length === 1 ? 0 : index / (data.length - 1)) * (width - left - right);
  // The vertical scale is deliberately fixed at NT$100,000 per interval.
  const gridValues = Array.from({ length: Math.ceil(range / step) + 1 }, (_, i) => max - step * i);
  const path = data.map((item, i) => `${i ? 'L' : 'M'} ${x(i).toFixed(1)} ${y(Number(item.total)).toFixed(1)}`).join(' ');
  const base = y(min);
  const area = `${path} L ${x(data.length - 1).toFixed(1)} ${base.toFixed(1)} L ${x(0).toFixed(1)} ${base.toFixed(1)} Z`;
  const points = data.map((item, i) => {
    const pointX = x(i), pointY = y(Number(item.total));
    const label = `NT$ ${money(item.total)}`;
    const labelWidth = Math.max(82, Math.min(146, label.length * 7 + 18));
    const labelY = pointY < 38 ? pointY + 10 : pointY - 32;
    return `<g class="chart-point-group" tabindex="0" role="button" aria-label="${monthText(item.month)}總資產 ${label}"><circle class="chart-hit" cx="${pointX}" cy="${pointY}" r="14"/><circle class="chart-point" cx="${pointX}" cy="${pointY}" r="4"/><g class="chart-tooltip"><rect x="${pointX - labelWidth / 2}" y="${labelY}" width="${labelWidth}" height="23" rx="6"/><text x="${pointX}" y="${labelY + 15}" text-anchor="middle">${label}</text></g></g><text class="month-label" text-anchor="middle" x="${pointX}" y="${height-9}">${item.month.slice(2).replace('-', '/')}</text>`;
  }).join('');
  host.innerHTML = `<svg viewBox="0 0 ${width} ${height}" role="img" aria-label="總資產每月變化折線圖"><defs><linearGradient id="chartGradient" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stop-color="#a8dbc8" stop-opacity=".55"/><stop offset="100%" stop-color="#a8dbc8" stop-opacity=".02"/></linearGradient></defs>${gridValues.map(value => `<line class="grid-line" x1="${left}" y1="${y(value)}" x2="${width-right}" y2="${y(value)}"/><text class="grid-label" x="0" y="${y(value)+3}">${value === 0 ? '0' : `${Math.round(value / 10000)}萬`}</text>`).join('')}<path class="chart-area" d="${area}"/><path class="chart-line" d="${path}"/>${points}</svg>`;
  host.querySelectorAll('.chart-point-group').forEach(point => {
    point.addEventListener('pointerup', event => {
      if (event.pointerType !== 'touch') return;
      host.querySelectorAll('.chart-point-group').forEach(item => item.classList.remove('is-active'));
      point.classList.add('is-active');
    });
    point.addEventListener('keydown', event => {
      if (event.key !== 'Enter' && event.key !== ' ') return;
      event.preventDefault();
      host.querySelectorAll('.chart-point-group').forEach(item => item.classList.remove('is-active'));
      point.classList.add('is-active');
    });
  });
}

function bindDashboard() {
  bindFixedExpenseSorting();
  bindMobileMonthSwipe();
  document.querySelectorAll('[data-month-shift]').forEach(button => button.addEventListener('click', () => {
    const direction = Number(button.dataset.monthShift);
    selectViewMonth(shiftMonth(viewMonth, direction), { direction });
  }));
  document.querySelectorAll('.view-month-input').forEach(input => input.addEventListener('change', event => { if (event.target.value) selectViewMonth(event.target.value); }));
  document.querySelector('#settings-button').addEventListener('click', openAccountModal);
  document.querySelector('#history-button').addEventListener('click', openHistoryModal);
  document.querySelector('#asset-summary-button').addEventListener('click', openAssetsModal);
  document.querySelector('#edit-income-button').addEventListener('click', openIncomeModal);
  document.querySelector('#add-expense-button').addEventListener('click', () => openExpenseModal());
  document.querySelector('#add-monthly-expense-button').addEventListener('click', () => openMonthlyExpenseModal());
  document.querySelectorAll('[data-asset]').forEach(button => button.addEventListener('click', () => openAssetModal(button.dataset.asset)));
  document.querySelectorAll('[data-expense]').forEach(button => button.addEventListener('click', () => openExpenseModal(button.dataset.expense)));
  document.querySelectorAll('[data-monthly-expense]').forEach(button => button.addEventListener('click', () => openMonthlyExpenseModal(button.dataset.monthlyExpense)));
  document.querySelector('#mobile-overview').addEventListener('click', () => window.scrollTo({ top: 0, behavior: 'smooth' }));
  document.querySelector('#mobile-history').addEventListener('click', () => document.querySelector('.chart-card').scrollIntoView({ behavior: 'smooth', block: 'center' }));
  document.querySelector('#mobile-expense').addEventListener('click', () => window.scrollTo({ top: document.documentElement.scrollHeight, behavior: 'smooth' }));
}

function bindMobileMonthSwipe() {
  const shell = document.querySelector('.app-shell');
  if (!shell) return;
  let swipe = null;
  shell.addEventListener('pointerdown', event => {
    if (!window.matchMedia('(max-width: 699px)').matches || event.isPrimary === false || event.button !== 0) return;
    if (event.target.closest('button, input, select, textarea, label, .drag-handle')) return;
    swipe = { id: event.pointerId, x: event.clientX, y: event.clientY, time: Date.now() };
  });
  shell.addEventListener('pointerup', event => {
    if (!swipe || event.pointerId !== swipe.id) return;
    const dx = event.clientX - swipe.x;
    const dy = event.clientY - swipe.y;
    const elapsed = Date.now() - swipe.time;
    swipe = null;
    if (elapsed > 1200 || Math.abs(dx) < 65 || Math.abs(dx) < Math.abs(dy) * 1.25) return;
    event.preventDefault();
    const direction = dx < 0 ? 1 : -1;
    selectViewMonth(shiftMonth(viewMonth, direction), { direction });
  });
  shell.addEventListener('pointercancel', () => { swipe = null; });
}

function selectViewMonth(month, { direction = 0 } = {}) {
  monthPageDirection = direction;
  viewMonth = month;
  const user = getUser();
  if (user) {
    cashState(user, month);
    twStockState(user, month);
    applyTwHoldingsTotal(user, month);
    usStockState(user, month);
    applyUsHoldingsTotal(user, month);
    cryptoState(user, month);
    applyCryptoHoldingsTotal(user, month);
    persistUser(user);
  }
  renderDashboard();
}

function moveFixedExpense(movedId, targetId, placeAfter) {
  if (!movedId || !targetId || movedId === targetId) return;
  const user = getUser();
  const currentExpenses = fixedExpensesForMonth(user, viewMonth);
  const ordered = orderedFixedExpenses(currentExpenses);
  const movedIndex = ordered.findIndex(expense => expense.id === movedId);
  if (movedIndex < 0) return;
  const [moved] = ordered.splice(movedIndex, 1);
  const targetIndex = ordered.findIndex(expense => expense.id === targetId);
  if (targetIndex < 0) return;
  ordered.splice(placeAfter ? targetIndex + 1 : targetIndex, 0, moved);
  ordered.forEach((expense, index) => { expense.sortOrder = index; });
  if (viewMonth === todayMonth()) user.expenses = ordered;
  else ensureMonthSnapshot(user, viewMonth).fixedExpenses = ordered;
  persistUser(user);
  renderDashboard();
  showToast('固定開銷順序已更新');
}

function bindFixedExpenseSorting() {
  const rows = [...document.querySelectorAll('.fixed-expense-row')];
  let dragState = null;
  const clearMarkers = () => rows.forEach(row => row.classList.remove('dragging', 'drag-over-before', 'drag-over-after'));
  const markTarget = (clientX, clientY) => {
    const candidate = document.elementFromPoint(clientX, clientY)?.closest('.fixed-expense-row');
    rows.forEach(row => row.classList.remove('drag-over-before', 'drag-over-after'));
    if (!candidate || candidate.dataset.expense === dragState?.id) return null;
    const rect = candidate.getBoundingClientRect();
    const placeAfter = clientY >= rect.top + rect.height / 2;
    candidate.classList.add(placeAfter ? 'drag-over-after' : 'drag-over-before');
    return { id: candidate.dataset.expense, placeAfter };
  };
  rows.forEach(row => {
    const handle = row.querySelector('.drag-handle');
    handle.addEventListener('pointerdown', event => {
      dragState = { id: row.dataset.expense, startX: event.clientX, startY: event.clientY, active: false, target: null };
      handle.setPointerCapture?.(event.pointerId);
    });
    handle.addEventListener('pointermove', event => {
      if (!dragState || dragState.id !== row.dataset.expense) return;
      if (!dragState.active && Math.hypot(event.clientX - dragState.startX, event.clientY - dragState.startY) < 7) return;
      dragState.active = true;
      event.preventDefault();
      row.classList.add('dragging');
      dragState.target = markTarget(event.clientX, event.clientY);
    });
    const finishDrag = () => {
      if (!dragState || dragState.id !== row.dataset.expense) return;
      const { active, id, target } = dragState;
      clearMarkers();
      dragState = null;
      if (active && target) moveFixedExpense(id, target.id, target.placeAfter);
    };
    handle.addEventListener('pointerup', finishDrag);
    handle.addEventListener('pointercancel', () => { clearMarkers(); dragState = null; });
  });
}

function openModal(content) {
  closeModal();
  currentModal = document.createElement('div');
  currentModal.className = 'modal-backdrop';
  currentModal.innerHTML = `<section class="modal" role="dialog" aria-modal="true">${content}</section>`;
  document.body.append(currentModal);
  bindModalSwipeToClose(currentModal);
  currentModal.querySelectorAll('[data-close-modal]').forEach(button => button.addEventListener('click', closeModal));
  currentModal.querySelector('input, select')?.focus();
}
function closeModal() { currentModal?.remove(); currentModal = null; }

function bindModalSwipeToClose(backdrop) {
  const modal = backdrop.querySelector('.modal');
  if (!modal) return;
  let swipe = null;
  const resetSwipeStyle = () => {
    modal.classList.remove('modal-swipe-active', 'modal-swipe-settling');
    modal.style.removeProperty('transition');
    modal.style.removeProperty('transform');
    backdrop.style.removeProperty('transition');
    backdrop.style.removeProperty('background');
  };
  modal.addEventListener('pointerdown', event => {
    if (!window.matchMedia('(max-width: 699px)').matches || event.isPrimary === false || event.button !== 0) return;
    if (event.target.closest('button, input, select, textarea, label, .drag-handle')) return;
    const rect = modal.getBoundingClientRect();
    if (event.clientX > rect.left + 56) return;
    swipe = { id: event.pointerId, x: event.clientX, y: event.clientY, time: Date.now(), left: rect.left, width: rect.width, distance: 0, active: false, cancelled: false };
  });
  modal.addEventListener('pointermove', event => {
    if (!swipe || event.pointerId !== swipe.id || swipe.cancelled) return;
    const dx = event.clientX - swipe.x;
    const dy = event.clientY - swipe.y;
    if (!swipe.active) {
      if (Math.abs(dy) > 12 && Math.abs(dy) > Math.abs(dx)) { swipe.cancelled = true; return; }
      if (dx < 10 || dx < Math.abs(dy) * 1.2) return;
      swipe.active = true;
      modal.classList.add('modal-swipe-active');
      modal.setPointerCapture?.(event.pointerId);
    }
    event.preventDefault();
    const distance = Math.max(0, dx);
    swipe.distance = distance;
    const progress = Math.min(distance / Math.max(swipe.width * .75, 1), 1);
    modal.style.transform = `translate3d(${distance}px, 0, 0)`;
    backdrop.style.background = `rgba(10, 36, 31, ${Math.max(.05, .43 * (1 - progress))})`;
  });
  const settleSwipe = (gesture, shouldClose) => {
    const currentDistance = Math.max(0, Number(gesture.distance || 0));
    const duration = shouldClose ? 200 : 170;
    modal.style.transform = `translate3d(${currentDistance}px, 0, 0)`;
    modal.style.transition = 'none';
    backdrop.style.transition = 'none';
    modal.classList.remove('modal-swipe-active');
    modal.classList.add('modal-swipe-settling');
    void modal.offsetWidth;
    modal.style.transition = `transform ${duration}ms cubic-bezier(.22,.75,.26,1)`;
    backdrop.style.transition = `background ${duration}ms ease`;
    const targetDistance = Math.ceil(Math.max(window.innerWidth - gesture.left + 48, gesture.width + 48));
    window.requestAnimationFrame(() => {
      modal.style.transform = shouldClose ? `translate3d(${targetDistance}px, 0, 0)` : 'translate3d(0, 0, 0)';
      backdrop.style.background = shouldClose ? 'rgba(10, 36, 31, 0)' : 'rgba(10, 36, 31, .43)';
    });
    window.setTimeout(() => {
      if (currentModal !== backdrop) return;
      if (shouldClose) closeModal();
      else resetSwipeStyle();
    }, duration + 35);
  };
  const finishSwipe = event => {
    if (!swipe || event.pointerId !== swipe.id) return;
    const gesture = swipe;
    swipe = null;
    if (!gesture.active) { resetSwipeStyle(); return; }
    const dx = Math.max(0, event.clientX - gesture.x);
    const elapsed = Date.now() - gesture.time;
    const shouldClose = dx >= gesture.width * .32 || (dx >= 58 && elapsed <= 420);
    gesture.distance = Math.max(gesture.distance, dx);
    settleSwipe(gesture, shouldClose);
  };
  modal.addEventListener('pointerup', finishSwipe);
  modal.addEventListener('pointercancel', event => {
    if (!swipe || event.pointerId !== swipe.id) return;
    const gesture = swipe;
    swipe = null;
    if (gesture.active) settleSwipe(gesture, false);
    else resetSwipeStyle();
  });
}

function applyTwHoldingsTotal(user, month = viewMonth) {
  const state = twStockState(user, month);
  syncLegacyTwStockData(user, month);
  if (state?.mode !== 'holdings') return;
  const assets = month === todayMonth() ? user.assets : ensureMonthSnapshot(user, month).assets;
  assets.tw = Math.round(state.holdings.reduce((sum, holding) => sum + holdingMarketValue(holding), 0));
  refreshMonthSnapshotTotal(user, month);
}

function twQuoteSourceText(holding, isCurrentMonth = true) {
  if (!Number(holding.price)) return '尚未取得價格';
  if (!isCurrentMonth) return '月份快照';
  if (holding.priceSource !== 'fugle') return '已保存價格';
  return holding.isClose ? '已收盤' : '盤中估值';
}

async function refreshTwHoldingQuotes(ids = null, { silent = false, refreshModal = true, month = viewMonth, updateUi = true } = {}) {
  const historicalAsOf = month < todayMonth() ? periodEndDate(month) : '';
  if (twQuoteRequestInFlight) return false;
  const user = getUser();
  const state = twStockState(user, month);
  const targets = state.holdings.filter(holding => (!ids || ids.includes(holding.id)) && (!historicalAsOf || holding.historicalAsOf !== historicalAsOf));
  if (!targets.length) return false;
  twQuoteRequestInFlight = true;
  const refreshButton = currentModal?.querySelector('#refresh-tw-quotes');
  if (refreshButton) { refreshButton.disabled = true; refreshButton.textContent = '更新中…'; }
  try {
    const { data, error } = await supabaseClient.functions.invoke('stock-quote', {
      body: {
        items: targets.map(holding => ({ symbol: holding.symbol, oddLot: Number(holding.shares) % 1000 !== 0 })),
        ...(historicalAsOf ? { asOf: historicalAsOf } : {})
      }
    });
    if (error || !Array.isArray(data?.quotes)) throw new Error(error?.message || '行情服務尚未啟用');
    const quoteMap = new Map(data.quotes.map(quote => [quote.symbol, quote]));
    const now = new Date().toISOString();
    let updatedCount = 0;
    targets.forEach(holding => {
      const quote = quoteMap.get(holding.symbol);
      if (!quote || !Number(quote.price)) return;
      if (historicalAsOf && quote.historicalAsOf !== historicalAsOf) return;
      holding.name = quote.name && quote.name !== holding.symbol ? quote.name : holding.name || holding.symbol;
      holding.price = Number(quote.price);
      holding.priceSource = 'fugle';
      holding.quoteAt = quote.quoteAt || now;
      holding.isClose = Boolean(quote.isClose);
      if (historicalAsOf) holding.historicalAsOf = historicalAsOf;
      else delete holding.historicalAsOf;
      updatedCount += 1;
    });
    if (!updatedCount) throw new Error(historicalAsOf ? '歷史收盤價服務尚未更新' : '沒有可用行情');
    applyTwHoldingsTotal(user, month);
    if (updateUi) {
      persistUser(user);
      renderDashboard();
      if (refreshModal && viewMonth === month && currentModal?.querySelector('#tw-holding-form')) openTwStockModal();
    }
    const failedCount = Array.isArray(data.errors) ? data.errors.length : 0;
    if (!silent) showToast(failedCount ? `已更新行情，${failedCount} 檔暫時無報價` : '台股行情已更新');
    return updatedCount > 0;
  } catch (error) {
    console.error('Stock quote refresh failed', error);
    if (!silent) showToast('暫時無法取得行情，請稍後再按更新價格。');
    return false;
  } finally {
    twQuoteRequestInFlight = false;
    const button = currentModal?.querySelector('#refresh-tw-quotes');
    if (button) { button.disabled = false; button.textContent = '更新價格'; }
  }
}

function openTwStockModal(editId = null) {
  const user = getUser();
  const month = viewMonth;
  const state = twStockState(user, month);
  const holdings = state.holdings;
  const editing = editId ? holdings.find(holding => holding.id === editId) : null;
  const estimatedTotal = twHoldingsTotal(user, month);
  const modeIsHoldings = state.mode === 'holdings';
  const isCurrentMonth = month === todayMonth();
  const canRefreshQuotes = month >= todayMonth();
  const historicalAsOf = periodEndDate(month);
  const assets = assetsForMonth(user, month);
  persistUser(user);
  const rows = holdings.length ? holdings.map(holding => {
    const updatedAt = quoteTimeText(holding.quoteAt);
    return `<article class="tw-holding-row"><div class="tw-holding-main"><div><strong>${escapeHTML(holding.symbol)} ${escapeHTML(holding.name || '')}</strong><small>${money(holding.shares)} 股 × NT$ ${stockPrice(holding.price)} · ${twQuoteSourceText(holding, canRefreshQuotes)}${updatedAt ? ` · ${updatedAt}` : ''}</small></div><b>NT$ ${money(holdingMarketValue(holding))}</b></div><div class="tw-holding-actions"><button class="text-button" data-edit-tw-holding="${holding.id}">修改</button><button class="text-button danger-text" data-delete-tw-holding="${holding.id}">刪除</button></div></article>`;
  }).join('') : '<p class="tw-holding-empty">尚未加入持股。<br>輸入股票代碼與股數後，系統會估算目前市值。</p>';
  const quoteToolbar = canRefreshQuotes ? `<button class="button light compact-button" id="refresh-tw-quotes" type="button" ${holdings.length ? '' : 'disabled'}>更新價格</button>` : `<span class="tw-snapshot-note">已凍結為 ${dateText(historicalAsOf)} 以前最近交易日的收盤價</span>`;
  const summaryContent = modeIsHoldings
    ? `<span>持股估算總額</span><strong>NT$ ${money(estimatedTotal)}</strong><small>已用此金額更新這個月份的台股總額</small>`
    : `<form id="tw-manual-total-form" class="tw-manual-total-form"><label for="tw-manual-total">台股手動總額</label><div class="tw-manual-total-input"><span>NT$</span><input id="tw-manual-total" name="manualTotal" type="text" value="${inputAmount(state.manualTotal)}" placeholder="例如：121300+5000" required inputmode="text"><button class="button light compact-button" type="submit">儲存</button></div><small id="tw-manual-total-preview">目前使用手動總額 NT$ ${money(assets.tw)}</small><div class="form-error" id="tw-manual-total-error"></div></form>`;
  openModal(`<header class="modal-header"><div><span class="eyebrow">${monthText(month)}台股資產</span><h2>台股資產</h2></div><button class="icon-button" data-close-modal aria-label="關閉">×</button></header><section class="tw-stock-summary">${summaryContent}</section><label class="tw-auto-switch"><input id="tw-auto-mode" type="checkbox" ${modeIsHoldings ? 'checked' : ''}><span><b>用持股估值更新台股總額</b><small>只會影響 ${monthText(month)}，其他月份不會改變。</small></span></label><div class="tw-stock-toolbar">${quoteToolbar}</div><section class="tw-holding-list">${rows}</section><form id="tw-holding-form" class="tw-holding-form"><h3>${editing ? '修改持股' : '新增持股'}</h3><div class="tw-form-grid"><div class="form-row"><label for="tw-symbol">股票代碼</label><input id="tw-symbol" name="symbol" value="${escapeHTML(editing?.symbol || '')}" placeholder="例如：2330台積電" autocomplete="off" required maxlength="20"></div><div class="form-row"><label for="tw-shares">持有股數</label><input id="tw-shares" name="shares" type="number" value="${editing?.shares || ''}" placeholder="例如：22" min="1" step="1" required inputmode="numeric"></div></div><div class="form-error" id="tw-holding-error"></div><div class="tw-form-actions">${editing ? '<button class="button light" id="cancel-tw-edit" type="button">取消修改</button>' : ''}<button class="button primary" type="submit">${editing ? '儲存持股' : '加入持股'}</button></div></form><p class="form-note tw-disclaimer">${canRefreshQuotes ? isCurrentMonth ? '只需輸入股票代碼與股數，系統會自動更新行情。' : '此月份尚未開始，先使用目前行情預估；進入該月份後會再更新。' : '歷史月份使用區間結束日前最近交易日的收盤價，持股清單仍可修改。'}</p>`);
  currentModal.querySelector('#refresh-tw-quotes')?.addEventListener('click', () => refreshTwHoldingQuotes(null, { month }));
  const manualTotalForm = currentModal.querySelector('#tw-manual-total-form');
  if (manualTotalForm) {
    const input = manualTotalForm.querySelector('#tw-manual-total');
    const preview = manualTotalForm.querySelector('#tw-manual-total-preview');
    const errorHost = manualTotalForm.querySelector('#tw-manual-total-error');
    const updatePreview = () => {
      errorHost.textContent = '';
      if (!input.value.trim()) { preview.textContent = '可輸入 121300+5000 等算式'; return; }
      const amount = calculateAmount(input.value);
      preview.textContent = amount === null ? '請使用數字與 + − × ÷ ( )' : `計算結果：NT$ ${money(amount)}`;
    };
    input.addEventListener('input', updatePreview);
    manualTotalForm.addEventListener('submit', event => {
      event.preventDefault();
      const amount = calculateAmount(input.value);
      if (amount === null) {
        errorHost.textContent = '請輸入可計算的非負金額。';
        input.focus();
        return;
      }
      const user = getUser();
      const state = twStockState(user, month);
      const monthAssets = month === todayMonth() ? user.assets : ensureMonthSnapshot(user, month).assets;
      state.manualTotal = amount;
      state.mode = 'manual';
      state.modeCustomized = true;
      monthAssets.tw = amount;
      syncLegacyTwStockData(user, month);
      refreshMonthSnapshotTotal(user, month);
      persistUser(user);
      renderDashboard();
      input.value = String(amount);
      preview.textContent = `已儲存：NT$ ${money(amount)}`;
      errorHost.textContent = '';
      showToast('台股手動總額已更新');
    });
  }
  currentModal.querySelector('#tw-auto-mode').addEventListener('change', event => {
    const user = getUser();
    const state = twStockState(user, month);
    const assets = month === todayMonth() ? user.assets : ensureMonthSnapshot(user, month).assets;
    state.modeCustomized = true;
    if (event.target.checked) {
      state.manualTotal = Number(assets.tw || 0);
      state.mode = 'holdings';
      applyTwHoldingsTotal(user, month);
    } else {
      state.mode = 'manual';
      assets.tw = Number(state.manualTotal || 0);
      syncLegacyTwStockData(user, month);
      refreshMonthSnapshotTotal(user, month);
    }
    persistUser(user);
    renderDashboard();
    openTwStockModal();
    showToast(event.target.checked ? '已使用持股估值更新台股總額' : '已切回手動台股總額');
  });
  currentModal.querySelectorAll('[data-edit-tw-holding]').forEach(button => button.addEventListener('click', () => openTwStockModal(button.dataset.editTwHolding)));
  currentModal.querySelectorAll('[data-delete-tw-holding]').forEach(button => button.addEventListener('click', () => {
    const user = getUser();
    const state = twStockState(user, month);
    state.holdings = state.holdings.filter(holding => holding.id !== button.dataset.deleteTwHolding);
    state.holdingsCustomized = true;
    applyTwHoldingsTotal(user, month);
    persistUser(user);
    renderDashboard();
    openTwStockModal();
    showToast('持股已刪除');
  }));
  currentModal.querySelector('#cancel-tw-edit')?.addEventListener('click', () => openTwStockModal());
  const holdingForm = currentModal.querySelector('#tw-holding-form');
  holdingForm.addEventListener('submit', async event => {
    event.preventDefault();
    const form = new FormData(holdingForm);
    const rawSymbol = String(form.get('symbol') || '').trim();
    const symbol = normalizeStockSymbol(rawSymbol);
    const enteredName = rawSymbol.replace(/^[0-9A-Z]+/i, '').trim();
    const shares = Number(form.get('shares'));
    const errorHost = currentModal.querySelector('#tw-holding-error');
    if (!/^[0-9A-Z]{4,6}$/.test(symbol)) { errorHost.textContent = '請輸入正確的台股代碼，例如 2330。'; return; }
    if (!Number.isInteger(shares) || shares <= 0) { errorHost.textContent = '股數請輸入大於 0 的整數。'; return; }
    if (holdings.some(holding => holding.symbol === symbol && holding.id !== editing?.id)) { errorHost.textContent = '這檔股票已在持股清單中。'; return; }
    const holding = editing || { id: crypto.randomUUID(), name: '', price: 0, priceSource: '', quoteAt: '' };
    const symbolChanged = Boolean(holding.symbol && holding.symbol !== symbol);
    const savedHolding = !canRefreshQuotes && (!editing || symbolChanged) ? nearestSavedTwHolding(user, symbol, month) : null;
    holding.symbol = symbol;
    holding.shares = shares;
    if (enteredName) holding.name = enteredName;
    else if (savedHolding?.name) holding.name = savedHolding.name;
    else if (symbolChanged) holding.name = '';
    if (!canRefreshQuotes && (!editing || symbolChanged)) {
      holding.price = Number(savedHolding?.price || 0);
      holding.priceSource = savedHolding ? 'snapshot' : '';
      holding.quoteAt = savedHolding?.quoteAt || '';
      holding.isClose = false;
    } else if (canRefreshQuotes && symbolChanged) {
      holding.price = 0;
      holding.priceSource = '';
      holding.quoteAt = '';
    }
    if (symbolChanged || !editing) delete holding.historicalAsOf;
    if (!editing) holdings.push(holding);
    state.holdingsCustomized = true;
    applyTwHoldingsTotal(user, month);
    persistUser(user);
    if (canRefreshQuotes) {
      const refreshed = await refreshTwHoldingQuotes([holding.id], { month });
      if (!refreshed) {
        renderDashboard();
        openTwStockModal();
      }
    }
    else {
      renderDashboard();
      openTwStockModal();
      showToast(editing ? '持股已更新' : savedHolding ? '持股已加入，並沿用最近保存的價格' : '持股已加入，尚無可沿用的歷史價格');
    }
  });
  const staleHoldings = canRefreshQuotes
    ? holdings.filter(holding => holding.priceSource !== 'fugle' || !holding.quoteAt || Date.now() - new Date(holding.quoteAt).getTime() > MARKET_QUOTE_REFRESH_MS)
    : holdings.filter(holding => holding.historicalAsOf !== historicalAsOf);
  if (staleHoldings.length && (!canRefreshQuotes || Date.now() - twAutoRefreshAttemptedAt > 60 * 1000)) {
    if (canRefreshQuotes) twAutoRefreshAttemptedAt = Date.now();
    window.setTimeout(() => refreshTwHoldingQuotes(staleHoldings.map(holding => holding.id), { silent: true, refreshModal: !canRefreshQuotes, month }), 0);
  }
}

function applyUsHoldingsTotal(user, month = viewMonth) {
  const state = usStockState(user, month);
  syncLegacyUsStockData(user, month);
  if (state?.mode !== 'holdings') return;
  const assets = month === todayMonth() ? user.assets : ensureMonthSnapshot(user, month).assets;
  assets.us = Math.round(state.holdings.reduce((sum, holding) => sum + usHoldingMarketValue(holding), 0));
  refreshMonthSnapshotTotal(user, month);
}

function usQuoteSourceText(holding, isCurrentMonth = true) {
  if (!Number(holding.price) || !Number(holding.exchangeRate)) return '尚未取得價格';
  if (!isCurrentMonth) return '月份快照';
  if (holding.priceSource !== 'yahoo') return '已保存價格';
  return '自動行情';
}

async function refreshUsHoldingQuotes(ids = null, { silent = false, refreshModal = true, month = viewMonth, updateUi = true } = {}) {
  const historicalAsOf = month < todayMonth() ? periodEndDate(month) : '';
  if (usQuoteRequestInFlight) return false;
  const user = getUser();
  const state = usStockState(user, month);
  const targets = state.holdings.filter(holding => (!ids || ids.includes(holding.id)) && (!historicalAsOf || holding.historicalAsOf !== historicalAsOf));
  if (!targets.length) return false;
  usQuoteRequestInFlight = true;
  const refreshButton = currentModal?.querySelector('#refresh-us-quotes');
  if (refreshButton) { refreshButton.disabled = true; refreshButton.textContent = '更新中…'; }
  try {
    const { data, error } = await supabaseClient.functions.invoke('us-stock-quote', {
      body: { items: targets.map(holding => ({ symbol: holding.symbol })), ...(historicalAsOf ? { asOf: historicalAsOf } : {}) }
    });
    if (error || !Array.isArray(data?.quotes)) throw new Error(error?.message || '美股行情服務尚未啟用');
    const quoteMap = new Map(data.quotes.map(quote => [quote.symbol, quote]));
    const now = new Date().toISOString();
    let updatedCount = 0;
    targets.forEach(holding => {
      const quote = quoteMap.get(holding.symbol);
      if (!quote || !Number(quote.price) || !Number(quote.exchangeRate)) return;
      if (historicalAsOf && quote.historicalAsOf !== historicalAsOf) return;
      holding.name = quote.name || holding.name || holding.symbol;
      holding.price = Number(quote.price);
      holding.exchangeRate = Number(quote.exchangeRate);
      holding.priceSource = 'yahoo';
      holding.quoteAt = quote.quoteAt || now;
      if (historicalAsOf) holding.historicalAsOf = historicalAsOf;
      else delete holding.historicalAsOf;
      updatedCount += 1;
    });
    if (!updatedCount) throw new Error(historicalAsOf ? '歷史收盤價服務尚未更新' : '沒有可用行情');
    applyUsHoldingsTotal(user, month);
    if (updateUi) {
      persistUser(user);
      renderDashboard();
      if (refreshModal && viewMonth === month && currentModal?.querySelector('#us-holding-form')) openUsStockModal();
    }
    const failedCount = Array.isArray(data.errors) ? data.errors.length : 0;
    if (!silent) showToast(failedCount ? `已更新美股行情，${failedCount} 檔暫時無報價` : '美股行情與匯率已更新');
    return updatedCount > 0;
  } catch (error) {
    console.error('US stock quote refresh failed', error);
    if (!silent) showToast('美股行情服務尚未部署，手動總額不受影響。');
    return false;
  } finally {
    usQuoteRequestInFlight = false;
    const button = currentModal?.querySelector('#refresh-us-quotes');
    if (button) { button.disabled = false; button.textContent = '更新價格'; }
  }
}

function openUsStockModal(editId = null) {
  const user = getUser();
  const month = viewMonth;
  const state = usStockState(user, month);
  const holdings = state.holdings;
  const editing = editId ? holdings.find(holding => holding.id === editId) : null;
  const estimatedTotal = usHoldingsTotal(user, month);
  const modeIsHoldings = state.mode === 'holdings';
  const isCurrentMonth = month === todayMonth();
  const canRefreshQuotes = month >= todayMonth();
  const historicalAsOf = periodEndDate(month);
  const assets = assetsForMonth(user, month);
  persistUser(user);
  const rows = holdings.length ? holdings.map(holding => {
    const updatedAt = quoteTimeText(holding.quoteAt);
    return `<article class="tw-holding-row"><div class="tw-holding-main"><div><strong>${escapeHTML(holding.symbol)} ${escapeHTML(holding.name && holding.name !== holding.symbol ? holding.name : '')}</strong><small>${stockPrice(holding.shares)} 股 × US$ ${stockPrice(holding.price)} × 匯率 ${stockPrice(holding.exchangeRate)} · ${usQuoteSourceText(holding, canRefreshQuotes)}${updatedAt ? ` · ${updatedAt}` : ''}</small></div><b>NT$ ${money(usHoldingMarketValue(holding))}</b></div><div class="tw-holding-actions"><button class="text-button" data-edit-us-holding="${holding.id}">修改</button><button class="text-button danger-text" data-delete-us-holding="${holding.id}">刪除</button></div></article>`;
  }).join('') : '<p class="tw-holding-empty">尚未加入美股持股。<br>輸入股票代碼與股數後，系統會換算為台幣市值。</p>';
  const quoteToolbar = canRefreshQuotes ? `<button class="button light compact-button" id="refresh-us-quotes" type="button" ${holdings.length ? '' : 'disabled'}>更新價格</button>` : `<span class="tw-snapshot-note">已凍結為 ${dateText(historicalAsOf)} 以前最近交易日的收盤價與匯率</span>`;
  const summaryContent = modeIsHoldings
    ? `<span>持股估算總額</span><strong>NT$ ${money(estimatedTotal)}</strong><small>美元股價已依保存的 USD/TWD 匯率換算</small>`
    : `<form id="us-manual-total-form" class="tw-manual-total-form"><label for="us-manual-total">美股手動總額（TWD）</label><div class="tw-manual-total-input"><span>NT$</span><input id="us-manual-total" name="manualTotal" type="text" value="${inputAmount(state.manualTotal)}" placeholder="例如：300000+5000" required inputmode="text"><button class="button light compact-button" type="submit">儲存</button></div><small id="us-manual-total-preview">目前使用手動總額 NT$ ${money(assets.us)}</small><div class="form-error" id="us-manual-total-error"></div></form>`;
  openModal(`<header class="modal-header"><div><span class="eyebrow">${monthText(month)}美股資產</span><h2>美股資產</h2></div><button class="icon-button" data-close-modal aria-label="關閉">×</button></header><section class="tw-stock-summary">${summaryContent}</section><label class="tw-auto-switch"><input id="us-auto-mode" type="checkbox" ${modeIsHoldings ? 'checked' : ''}><span><b>用持股估值更新美股總額</b><small>只會影響 ${monthText(month)}，其他月份不會改變。</small></span></label><div class="tw-stock-toolbar">${quoteToolbar}</div><section class="tw-holding-list">${rows}</section><form id="us-holding-form" class="tw-holding-form"><h3>${editing ? '修改持股' : '新增持股'}</h3><div class="tw-form-grid"><div class="form-row"><label for="us-symbol">美股代碼</label><input id="us-symbol" name="symbol" value="${escapeHTML(editing?.symbol || '')}" placeholder="例如：AAPL" autocomplete="off" required maxlength="10"></div><div class="form-row"><label for="us-shares">持有股數</label><input id="us-shares" name="shares" type="number" value="${editing?.shares || ''}" placeholder="例如：10" min="0.0001" step="0.0001" required inputmode="decimal"></div></div><div class="form-error" id="us-holding-error"></div><div class="tw-form-actions">${editing ? '<button class="button light" id="cancel-us-edit" type="button">取消修改</button>' : ''}<button class="button primary" type="submit">${editing ? '儲存持股' : '加入持股'}</button></div></form><p class="form-note tw-disclaimer">${canRefreshQuotes ? isCurrentMonth ? '系統會自動取得美元股價與 USD/TWD 匯率，再換算成台幣。' : '此月份尚未開始，先使用目前股價與匯率預估；進入該月份後會再更新。' : '歷史月份使用區間結束日前最近交易日的收盤價與匯率，持股清單仍可修改。'}</p>`);
  currentModal.querySelector('#refresh-us-quotes')?.addEventListener('click', () => refreshUsHoldingQuotes(null, { month }));
  const manualTotalForm = currentModal.querySelector('#us-manual-total-form');
  if (manualTotalForm) {
    const input = manualTotalForm.querySelector('#us-manual-total');
    const preview = manualTotalForm.querySelector('#us-manual-total-preview');
    const errorHost = manualTotalForm.querySelector('#us-manual-total-error');
    const updatePreview = () => {
      errorHost.textContent = '';
      if (!input.value.trim()) { preview.textContent = '可輸入 300000+5000 等算式'; return; }
      const amount = calculateAmount(input.value);
      preview.textContent = amount === null ? '請使用數字與 + − × ÷ ( )' : `計算結果：NT$ ${money(amount)}`;
    };
    input.addEventListener('input', updatePreview);
    manualTotalForm.addEventListener('submit', event => {
      event.preventDefault();
      const amount = calculateAmount(input.value);
      if (amount === null) {
        errorHost.textContent = '請輸入可計算的非負金額。';
        input.focus();
        return;
      }
      const user = getUser();
      const state = usStockState(user, month);
      const monthAssets = month === todayMonth() ? user.assets : ensureMonthSnapshot(user, month).assets;
      state.manualTotal = amount;
      state.mode = 'manual';
      state.modeCustomized = true;
      monthAssets.us = amount;
      syncLegacyUsStockData(user, month);
      refreshMonthSnapshotTotal(user, month);
      persistUser(user);
      renderDashboard();
      input.value = String(amount);
      preview.textContent = `已儲存：NT$ ${money(amount)}`;
      errorHost.textContent = '';
      showToast('美股手動總額已更新');
    });
  }
  currentModal.querySelector('#us-auto-mode').addEventListener('change', event => {
    const user = getUser();
    const state = usStockState(user, month);
    const assets = month === todayMonth() ? user.assets : ensureMonthSnapshot(user, month).assets;
    state.modeCustomized = true;
    if (event.target.checked) {
      state.manualTotal = Number(assets.us || 0);
      state.mode = 'holdings';
      applyUsHoldingsTotal(user, month);
    } else {
      state.mode = 'manual';
      assets.us = Number(state.manualTotal || 0);
      syncLegacyUsStockData(user, month);
      refreshMonthSnapshotTotal(user, month);
    }
    persistUser(user);
    renderDashboard();
    openUsStockModal();
    showToast(event.target.checked ? '已使用持股估值更新美股總額' : '已切回手動美股總額');
  });
  currentModal.querySelectorAll('[data-edit-us-holding]').forEach(button => button.addEventListener('click', () => openUsStockModal(button.dataset.editUsHolding)));
  currentModal.querySelectorAll('[data-delete-us-holding]').forEach(button => button.addEventListener('click', () => {
    const user = getUser();
    const state = usStockState(user, month);
    state.holdings = state.holdings.filter(holding => holding.id !== button.dataset.deleteUsHolding);
    state.holdingsCustomized = true;
    applyUsHoldingsTotal(user, month);
    persistUser(user);
    renderDashboard();
    openUsStockModal();
    showToast('美股持股已刪除');
  }));
  currentModal.querySelector('#cancel-us-edit')?.addEventListener('click', () => openUsStockModal());
  const holdingForm = currentModal.querySelector('#us-holding-form');
  holdingForm.addEventListener('submit', async event => {
    event.preventDefault();
    const form = new FormData(holdingForm);
    const symbol = normalizeUsStockSymbol(form.get('symbol'));
    const shares = Number(form.get('shares'));
    const errorHost = currentModal.querySelector('#us-holding-error');
    if (!symbol) { errorHost.textContent = '請輸入正確的美股代碼，例如 AAPL 或 BRK.B。'; return; }
    if (!Number.isFinite(shares) || shares <= 0) { errorHost.textContent = '股數請輸入大於 0 的數字。'; return; }
    if (holdings.some(holding => holding.symbol === symbol && holding.id !== editing?.id)) { errorHost.textContent = '這檔股票已在持股清單中。'; return; }
    const holding = editing || { id: crypto.randomUUID(), name: '', price: 0, exchangeRate: 0, priceSource: '', quoteAt: '' };
    const symbolChanged = Boolean(holding.symbol && holding.symbol !== symbol);
    const savedHolding = !canRefreshQuotes && (!editing || symbolChanged) ? nearestSavedUsHolding(user, symbol, month) : null;
    holding.symbol = symbol;
    holding.shares = shares;
    if (!canRefreshQuotes && (!editing || symbolChanged)) {
      holding.name = savedHolding?.name || symbol;
      holding.price = Number(savedHolding?.price || 0);
      holding.exchangeRate = Number(savedHolding?.exchangeRate || 0);
      holding.priceSource = savedHolding ? 'snapshot' : '';
      holding.quoteAt = savedHolding?.quoteAt || '';
    } else if (canRefreshQuotes && symbolChanged) {
      holding.name = symbol;
      holding.price = 0;
      holding.exchangeRate = 0;
      holding.priceSource = '';
      holding.quoteAt = '';
    }
    if (symbolChanged || !editing) delete holding.historicalAsOf;
    if (!editing) holdings.push(holding);
    state.holdingsCustomized = true;
    applyUsHoldingsTotal(user, month);
    persistUser(user);
    if (canRefreshQuotes) {
      const refreshed = await refreshUsHoldingQuotes([holding.id], { month });
      if (!refreshed) {
        renderDashboard();
        openUsStockModal();
      }
    } else {
      renderDashboard();
      openUsStockModal();
      showToast(editing ? '美股持股已更新' : savedHolding ? '持股已加入，並沿用最近保存的價格與匯率' : '持股已加入，尚無可沿用的歷史行情');
    }
  });
  const staleHoldings = canRefreshQuotes
    ? holdings.filter(holding => holding.priceSource !== 'yahoo' || !holding.quoteAt || Date.now() - new Date(holding.quoteAt).getTime() > MARKET_QUOTE_REFRESH_MS)
    : holdings.filter(holding => holding.historicalAsOf !== historicalAsOf);
  if (staleHoldings.length && (!canRefreshQuotes || Date.now() - usAutoRefreshAttemptedAt > 60 * 1000)) {
    if (canRefreshQuotes) usAutoRefreshAttemptedAt = Date.now();
    window.setTimeout(() => refreshUsHoldingQuotes(staleHoldings.map(holding => holding.id), { silent: true, refreshModal: !canRefreshQuotes, month }), 0);
  }
}

function applyCryptoHoldingsTotal(user, month = viewMonth) {
  const state = cryptoState(user, month);
  syncLegacyCryptoData(user, month);
  if (state?.mode !== 'holdings') return;
  const assets = month === todayMonth() ? user.assets : ensureMonthSnapshot(user, month).assets;
  assets.crypto = Math.round(state.holdings.reduce((sum, holding) => sum + cryptoHoldingMarketValue(holding), 0));
  refreshMonthSnapshotTotal(user, month);
}

function cryptoQuoteSourceText(holding, canRefreshQuotes = true) {
  if (!Number(holding.price) || !Number(holding.exchangeRate)) return '尚未取得價格';
  if (!canRefreshQuotes) return '月份快照';
  if (holding.priceSource !== 'yahoo') return '已保存價格';
  return '自動行情';
}

async function refreshCryptoQuotes(ids = null, { silent = false, refreshModal = true, month = viewMonth, updateUi = true } = {}) {
  const historicalAsOf = month < todayMonth() ? periodEndDate(month) : '';
  if (cryptoQuoteRequestInFlight) return false;
  const user = getUser();
  const state = cryptoState(user, month);
  const targets = state.holdings.filter(holding => (!ids || ids.includes(holding.id)) && (!historicalAsOf || holding.historicalAsOf !== historicalAsOf));
  if (!targets.length) return false;
  cryptoQuoteRequestInFlight = true;
  const refreshButton = currentModal?.querySelector('#refresh-crypto-quotes');
  if (refreshButton) { refreshButton.disabled = true; refreshButton.textContent = '更新中…'; }
  try {
    const { data, error } = await supabaseClient.functions.invoke('crypto-quote', {
      body: { items: targets.map(holding => ({ symbol: holding.symbol })), ...(historicalAsOf ? { asOf: historicalAsOf } : {}) }
    });
    if (error || !Array.isArray(data?.quotes)) throw new Error(error?.message || '加密貨幣行情服務尚未啟用');
    const quoteMap = new Map(data.quotes.map(quote => [quote.symbol, quote]));
    const now = new Date().toISOString();
    let updatedCount = 0;
    targets.forEach(holding => {
      const quote = quoteMap.get(holding.symbol);
      if (!quote || !Number(quote.price) || !Number(quote.exchangeRate)) return;
      if (historicalAsOf && quote.historicalAsOf !== historicalAsOf) return;
      holding.name = quote.name || holding.name || holding.symbol;
      holding.price = Number(quote.price);
      holding.exchangeRate = Number(quote.exchangeRate);
      holding.priceSource = 'yahoo';
      holding.quoteAt = quote.quoteAt || now;
      if (historicalAsOf) holding.historicalAsOf = historicalAsOf;
      else delete holding.historicalAsOf;
      updatedCount += 1;
    });
    if (!updatedCount) throw new Error(historicalAsOf ? '歷史收盤價服務尚未更新' : '沒有可用行情');
    applyCryptoHoldingsTotal(user, month);
    if (updateUi) {
      persistUser(user);
      renderDashboard();
      if (refreshModal && viewMonth === month && currentModal?.querySelector('#crypto-holding-form')) openCryptoModal();
    }
    const failedCount = Array.isArray(data.errors) ? data.errors.length : 0;
    if (!silent) showToast(failedCount ? `已更新加密貨幣行情，${failedCount} 種暫時無報價` : '加密貨幣行情與匯率已更新');
    return updatedCount > 0;
  } catch (error) {
    console.error('Crypto quote refresh failed', error);
    if (!silent) showToast('加密貨幣行情服務尚未部署，手動總額不受影響。');
    return false;
  } finally {
    cryptoQuoteRequestInFlight = false;
    const button = currentModal?.querySelector('#refresh-crypto-quotes');
    if (button) { button.disabled = false; button.textContent = '更新價格'; }
  }
}

function monthsNeedingHistoricalQuotes(collection) {
  return Object.entries(collection || {})
    .filter(([month, state]) => month < todayMonth()
      && Array.isArray(state?.holdings)
      && state.holdings.some(holding => holding.historicalAsOf !== periodEndDate(month)))
    .map(([month]) => month)
    .sort();
}

async function freezeHistoricalMarketQuotes() {
  const user = getUser();
  if (!user) return false;
  let changed = false;
  const updateMonths = async (months, refresh) => {
    for (const month of months) {
      if (await refresh(null, { silent: true, refreshModal: false, month, updateUi: false })) changed = true;
    }
  };
  await Promise.all([
    updateMonths(monthsNeedingHistoricalQuotes(user.twStockByMonth), refreshTwHoldingQuotes),
    updateMonths(monthsNeedingHistoricalQuotes(user.usStockByMonth), refreshUsHoldingQuotes),
    updateMonths(monthsNeedingHistoricalQuotes(user.cryptoByMonth), refreshCryptoQuotes)
  ]);
  return changed;
}

async function runMarketQuoteRefresh({ includeHistory = false } = {}) {
  if (!activeUser || marketQuoteRefreshInFlight || document.visibilityState === 'hidden') return false;
  const refreshGeneration = marketQuoteRefreshGeneration;
  const refreshUserId = activeUser.id;
  marketQuoteRefreshInFlight = true;
  let changed = false;
  try {
    const month = todayMonth();
    const currentResults = await Promise.all([
      refreshTwHoldingQuotes(null, { silent: true, refreshModal: false, month, updateUi: false }),
      refreshUsHoldingQuotes(null, { silent: true, refreshModal: false, month, updateUi: false }),
      refreshCryptoQuotes(null, { silent: true, refreshModal: false, month, updateUi: false })
    ]);
    changed = currentResults.some(Boolean);
    if (refreshGeneration !== marketQuoteRefreshGeneration || activeUser?.id !== refreshUserId) return false;
    if (includeHistory && await freezeHistoricalMarketQuotes()) changed = true;
    if (refreshGeneration !== marketQuoteRefreshGeneration || activeUser?.id !== refreshUserId) return false;
    if (changed) {
      persistUser(getUser());
      renderDashboard();
    }
    return changed;
  } finally {
    if (refreshGeneration === marketQuoteRefreshGeneration) {
      lastMarketQuoteRefreshAt = Date.now();
      marketQuoteRefreshInFlight = false;
    }
  }
}

function stopMarketQuoteUpdates() {
  marketQuoteRefreshGeneration += 1;
  window.clearTimeout(marketQuoteStartupTimer);
  window.clearInterval(marketQuoteRefreshTimer);
  marketQuoteStartupTimer = undefined;
  marketQuoteRefreshTimer = undefined;
  marketQuoteRefreshInFlight = false;
  lastMarketQuoteRefreshAt = 0;
}

function startMarketQuoteUpdates() {
  stopMarketQuoteUpdates();
  marketQuoteStartupTimer = window.setTimeout(() => runMarketQuoteRefresh({ includeHistory: true }), 0);
  marketQuoteRefreshTimer = window.setInterval(() => runMarketQuoteRefresh(), MARKET_QUOTE_REFRESH_MS);
}

function openCryptoModal(editId = null) {
  const user = getUser();
  const month = viewMonth;
  const state = cryptoState(user, month);
  const holdings = state.holdings;
  const editing = editId ? holdings.find(holding => holding.id === editId) : null;
  const estimatedTotal = cryptoHoldingsTotal(user, month);
  const modeIsHoldings = state.mode === 'holdings';
  const isCurrentMonth = month === todayMonth();
  const canRefreshQuotes = month >= todayMonth();
  const historicalAsOf = periodEndDate(month);
  const assets = assetsForMonth(user, month);
  persistUser(user);
  const rows = holdings.length ? holdings.map(holding => {
    const updatedAt = quoteTimeText(holding.quoteAt);
    return `<article class="tw-holding-row"><div class="tw-holding-main"><div><strong>${escapeHTML(holding.symbol)} ${escapeHTML(holding.name && holding.name !== holding.symbol ? holding.name : '')}</strong><small>${cryptoAmount(holding.amount)} 枚 × US$ ${cryptoPrice(holding.price)} × 匯率 ${stockPrice(holding.exchangeRate)} · ${cryptoQuoteSourceText(holding, canRefreshQuotes)}${updatedAt ? ` · ${updatedAt}` : ''}</small></div><b>NT$ ${money(cryptoHoldingMarketValue(holding))}</b></div><div class="tw-holding-actions"><button class="text-button" data-edit-crypto-holding="${holding.id}">修改</button><button class="text-button danger-text" data-delete-crypto-holding="${holding.id}">刪除</button></div></article>`;
  }).join('') : '<p class="tw-holding-empty">尚未加入加密貨幣。<br>輸入幣種代碼與持有數量後，系統會換算為台幣市值。</p>';
  const quoteToolbar = canRefreshQuotes ? `<button class="button light compact-button" id="refresh-crypto-quotes" type="button" ${holdings.length ? '' : 'disabled'}>更新價格</button>` : `<span class="tw-snapshot-note">已凍結為 ${dateText(historicalAsOf)} 的收盤價與最近匯率</span>`;
  const summaryContent = modeIsHoldings
    ? `<span>持幣估算總額</span><strong>NT$ ${money(estimatedTotal)}</strong><small>美元幣價已依保存的 USD/TWD 匯率換算</small>`
    : `<form id="crypto-manual-total-form" class="tw-manual-total-form"><label for="crypto-manual-total">加密貨幣手動總額（TWD）</label><div class="tw-manual-total-input"><span>NT$</span><input id="crypto-manual-total" name="manualTotal" type="text" value="${inputAmount(state.manualTotal)}" placeholder="例如：200000+5000" required inputmode="text"><button class="button light compact-button" type="submit">儲存</button></div><small id="crypto-manual-total-preview">目前使用手動總額 NT$ ${money(assets.crypto)}</small><div class="form-error" id="crypto-manual-total-error"></div></form>`;
  openModal(`<header class="modal-header"><div><span class="eyebrow">${monthText(month)}加密貨幣資產</span><h2>加密貨幣資產</h2></div><button class="icon-button" data-close-modal aria-label="關閉">×</button></header><section class="tw-stock-summary">${summaryContent}</section><label class="tw-auto-switch"><input id="crypto-auto-mode" type="checkbox" ${modeIsHoldings ? 'checked' : ''}><span><b>用持幣估值更新加密貨幣總額</b><small>只會影響 ${monthText(month)}，其他月份不會改變。</small></span></label><div class="tw-stock-toolbar">${quoteToolbar}</div><section class="tw-holding-list">${rows}</section><form id="crypto-holding-form" class="tw-holding-form"><h3>${editing ? '修改持幣' : '新增持幣'}</h3><div class="tw-form-grid"><div class="form-row"><label for="crypto-symbol">幣種代碼</label><input id="crypto-symbol" name="symbol" value="${escapeHTML(editing?.symbol || '')}" placeholder="例如：BTC" autocomplete="off" required maxlength="10"></div><div class="form-row"><label for="crypto-amount">持有數量</label><input id="crypto-amount" name="amount" type="number" value="${editing?.amount || ''}" placeholder="例如：0.05" min="0.00000001" step="any" required inputmode="decimal"></div></div><div class="form-error" id="crypto-holding-error"></div><div class="tw-form-actions">${editing ? '<button class="button light" id="cancel-crypto-edit" type="button">取消修改</button>' : ''}<button class="button primary" type="submit">${editing ? '儲存持幣' : '加入持幣'}</button></div></form><p class="form-note tw-disclaimer">${canRefreshQuotes ? isCurrentMonth ? '系統會自動取得美元幣價與 USD/TWD 匯率，再換算成台幣。' : '此月份尚未開始，先使用目前幣價與匯率預估；進入該月份後會再更新。' : '歷史月份使用區間結束日的收盤價與最近匯率，持幣清單仍可修改。'}</p>`);
  currentModal.querySelector('#refresh-crypto-quotes')?.addEventListener('click', () => refreshCryptoQuotes(null, { month }));
  const manualTotalForm = currentModal.querySelector('#crypto-manual-total-form');
  if (manualTotalForm) {
    const input = manualTotalForm.querySelector('#crypto-manual-total');
    const preview = manualTotalForm.querySelector('#crypto-manual-total-preview');
    const errorHost = manualTotalForm.querySelector('#crypto-manual-total-error');
    const updatePreview = () => {
      errorHost.textContent = '';
      if (!input.value.trim()) { preview.textContent = '可輸入 200000+5000 等算式'; return; }
      const amount = calculateAmount(input.value);
      preview.textContent = amount === null ? '請使用數字與 + − × ÷ ( )' : `計算結果：NT$ ${money(amount)}`;
    };
    input.addEventListener('input', updatePreview);
    manualTotalForm.addEventListener('submit', event => {
      event.preventDefault();
      const amount = calculateAmount(input.value);
      if (amount === null) {
        errorHost.textContent = '請輸入可計算的非負金額。';
        input.focus();
        return;
      }
      const user = getUser();
      const state = cryptoState(user, month);
      const monthAssets = month === todayMonth() ? user.assets : ensureMonthSnapshot(user, month).assets;
      state.manualTotal = amount;
      state.mode = 'manual';
      state.modeCustomized = true;
      monthAssets.crypto = amount;
      syncLegacyCryptoData(user, month);
      refreshMonthSnapshotTotal(user, month);
      persistUser(user);
      renderDashboard();
      input.value = String(amount);
      preview.textContent = `已儲存：NT$ ${money(amount)}`;
      errorHost.textContent = '';
      showToast('加密貨幣手動總額已更新');
    });
  }
  currentModal.querySelector('#crypto-auto-mode').addEventListener('change', event => {
    const user = getUser();
    const state = cryptoState(user, month);
    const assets = month === todayMonth() ? user.assets : ensureMonthSnapshot(user, month).assets;
    state.modeCustomized = true;
    if (event.target.checked) {
      state.manualTotal = Number(assets.crypto || 0);
      state.mode = 'holdings';
      applyCryptoHoldingsTotal(user, month);
    } else {
      state.mode = 'manual';
      assets.crypto = Number(state.manualTotal || 0);
      syncLegacyCryptoData(user, month);
      refreshMonthSnapshotTotal(user, month);
    }
    persistUser(user);
    renderDashboard();
    openCryptoModal();
    showToast(event.target.checked ? '已使用持幣估值更新加密貨幣總額' : '已切回手動加密貨幣總額');
  });
  currentModal.querySelectorAll('[data-edit-crypto-holding]').forEach(button => button.addEventListener('click', () => openCryptoModal(button.dataset.editCryptoHolding)));
  currentModal.querySelectorAll('[data-delete-crypto-holding]').forEach(button => button.addEventListener('click', () => {
    const user = getUser();
    const state = cryptoState(user, month);
    state.holdings = state.holdings.filter(holding => holding.id !== button.dataset.deleteCryptoHolding);
    state.holdingsCustomized = true;
    applyCryptoHoldingsTotal(user, month);
    persistUser(user);
    renderDashboard();
    openCryptoModal();
    showToast('加密貨幣持幣已刪除');
  }));
  currentModal.querySelector('#cancel-crypto-edit')?.addEventListener('click', () => openCryptoModal());
  const holdingForm = currentModal.querySelector('#crypto-holding-form');
  holdingForm.addEventListener('submit', async event => {
    event.preventDefault();
    const form = new FormData(holdingForm);
    const symbol = normalizeCryptoSymbol(form.get('symbol'));
    const amount = Number(form.get('amount'));
    const errorHost = currentModal.querySelector('#crypto-holding-error');
    if (!symbol) { errorHost.textContent = '請輸入正確的幣種代碼，例如 BTC、ETH 或 SOL。'; return; }
    if (!Number.isFinite(amount) || amount <= 0) { errorHost.textContent = '持有數量請輸入大於 0 的數字。'; return; }
    if (holdings.some(holding => holding.symbol === symbol && holding.id !== editing?.id)) { errorHost.textContent = '這個幣種已在持幣清單中。'; return; }
    const holding = editing || { id: crypto.randomUUID(), name: '', price: 0, exchangeRate: 0, priceSource: '', quoteAt: '' };
    const symbolChanged = Boolean(holding.symbol && holding.symbol !== symbol);
    const savedHolding = !canRefreshQuotes && (!editing || symbolChanged) ? nearestSavedCryptoHolding(user, symbol, month) : null;
    holding.symbol = symbol;
    holding.amount = amount;
    if (!canRefreshQuotes && (!editing || symbolChanged)) {
      holding.name = savedHolding?.name || symbol;
      holding.price = Number(savedHolding?.price || 0);
      holding.exchangeRate = Number(savedHolding?.exchangeRate || 0);
      holding.priceSource = savedHolding ? 'snapshot' : '';
      holding.quoteAt = savedHolding?.quoteAt || '';
    } else if (canRefreshQuotes && symbolChanged) {
      holding.name = symbol;
      holding.price = 0;
      holding.exchangeRate = 0;
      holding.priceSource = '';
      holding.quoteAt = '';
    }
    if (symbolChanged || !editing) delete holding.historicalAsOf;
    if (!editing) holdings.push(holding);
    state.holdingsCustomized = true;
    applyCryptoHoldingsTotal(user, month);
    persistUser(user);
    if (canRefreshQuotes) {
      const refreshed = await refreshCryptoQuotes([holding.id], { month });
      if (!refreshed) {
        renderDashboard();
        openCryptoModal();
      }
    } else {
      renderDashboard();
      openCryptoModal();
      showToast(editing ? '加密貨幣持幣已更新' : savedHolding ? '持幣已加入，並沿用最近保存的價格與匯率' : '持幣已加入，尚無可沿用的歷史行情');
    }
  });
  const staleHoldings = canRefreshQuotes
    ? holdings.filter(holding => holding.priceSource !== 'yahoo' || !holding.quoteAt || Date.now() - new Date(holding.quoteAt).getTime() > MARKET_QUOTE_REFRESH_MS)
    : holdings.filter(holding => holding.historicalAsOf !== historicalAsOf);
  if (staleHoldings.length && (!canRefreshQuotes || Date.now() - cryptoAutoRefreshAttemptedAt > 60 * 1000)) {
    if (canRefreshQuotes) cryptoAutoRefreshAttemptedAt = Date.now();
    window.setTimeout(() => refreshCryptoQuotes(staleHoldings.map(holding => holding.id), { silent: true, refreshModal: !canRefreshQuotes, month }), 0);
  }
}

function openCashModal() {
  const user = getUser();
  const month = viewMonth;
  const hadState = Boolean(user.cashByMonth?.[month]);
  const state = cashState(user, month);
  const cash = cashValueForMonth(user, month);
  const endingCash = endingCashForMonth(user, month);
  const parts = cashFormulaParts(user, month);
  if (!hadState) persistUser(user);
  const summaryContent = state.mode === 'manual'
    ? `<form id="cash-manual-form" class="tw-manual-total-form"><label for="cash-manual-total">現金手動總額（TWD）</label><div class="tw-manual-total-input"><span>NT$</span><input id="cash-manual-total" name="manualTotal" type="text" value="${inputAmount(state.manualTotal)}" placeholder="例如：200000+5000" required inputmode="text"><button class="button light compact-button" type="submit">儲存</button></div><small id="cash-manual-preview">目前使用手動現金 NT$ ${money(cash)}；扣除開銷後末期現金 NT$ ${money(endingCash)}</small><div class="form-error" id="cash-manual-error"></div></form>`
    : state.mode === 'income'
      ? `<span>上月末期現金＋本月收入（未扣除開銷）</span><strong>${cash >= 0 ? '' : '−'} NT$ ${money(Math.abs(cash))}</strong><small>NT$ ${money(parts.previousEnding)} ＋ NT$ ${money(parts.income)}；目前總資產顯示滿額狀態</small>`
      : `<span>自動計算本月末期現金</span><strong>${cash >= 0 ? '' : '−'} NT$ ${money(Math.abs(cash))}</strong><small>NT$ ${money(parts.previousEnding)} ＋ NT$ ${money(parts.income)} － NT$ ${money(parts.outgoings)}</small>`;
  const modes = [
    { value: 'manual', title: '手動填寫現金', description: '自行輸入本月現金，總資產會再扣除本月全部開銷。' },
    { value: 'income', title: '上月末期現金＋本月收入（未扣除開銷）', description: '顯示剛領完收入的滿額現金與總資產，全部開銷暫不扣除。' },
    { value: 'ending', title: '上月末期現金＋本月收入－全部開銷', description: '直接顯示本月末期現金；總資產不會重複扣除開銷。' }
  ];
  openModal(`<header class="modal-header"><div><span class="eyebrow">${monthText(month)}現金資產</span><h2>現金計算方式</h2></div><button class="icon-button" data-close-modal aria-label="關閉">×</button></header><section class="tw-stock-summary cash-summary">${summaryContent}</section><div class="cash-mode-list" role="radiogroup" aria-label="現金計算方式">${modes.map(mode => `<label class="tw-auto-switch cash-mode-option"><input type="radio" name="cash-mode" value="${mode.value}" ${state.mode === mode.value ? 'checked' : ''}><span><b>${mode.title}</b><small>${mode.description}</small></span></label>`).join('')}</div><p class="form-note tw-disclaimer">自動模式會依每個月份的收入、固定開銷、現金開銷及信用卡應繳金額即時更新。</p>`);
  const manualForm = currentModal.querySelector('#cash-manual-form');
  if (manualForm) {
    const input = manualForm.querySelector('#cash-manual-total');
    const preview = manualForm.querySelector('#cash-manual-preview');
    const errorHost = manualForm.querySelector('#cash-manual-error');
    const updatePreview = () => {
      errorHost.textContent = '';
      if (!input.value.trim()) { preview.textContent = '可輸入 200000+5000 等算式'; return; }
      const amount = calculateAmount(input.value);
      preview.textContent = amount === null ? '請使用數字與 + − × ÷ ( )' : `計算結果：NT$ ${money(amount)}`;
    };
    input.addEventListener('input', updatePreview);
    manualForm.addEventListener('submit', event => {
      event.preventDefault();
      const amount = calculateAmount(input.value);
      if (amount === null) {
        errorHost.textContent = '請輸入可計算的非負金額。';
        input.focus();
        return;
      }
      const user = getUser();
      const state = cashState(user, month);
      const rawAssets = month === todayMonth() ? user.assets : ensureMonthSnapshot(user, month).assets;
      state.manualTotal = amount;
      state.mode = 'manual';
      rawAssets.cash = amount;
      syncLegacyCashData(user, month);
      persistUser(user);
      renderDashboard();
      openCashModal();
      showToast('現金手動總額已更新');
    });
  }
  currentModal.querySelectorAll('input[name="cash-mode"]').forEach(input => input.addEventListener('change', event => {
    if (!event.target.checked) return;
    const user = getUser();
    const state = cashState(user, month);
    const rawAssets = month === todayMonth() ? user.assets : ensureMonthSnapshot(user, month).assets;
    state.mode = normalizeCashMode(event.target.value);
    if (state.mode === 'manual') rawAssets.cash = Number(state.manualTotal || 0);
    syncLegacyCashData(user, month);
    persistUser(user);
    renderDashboard();
    openCashModal();
    showToast(state.mode === 'manual' ? '已切回手動現金' : state.mode === 'income' ? '已使用上月末期現金加本月收入' : '已自動計算本月末期現金');
  }));
}

function openAssetModal(key) {
  if (key === 'cash') { openCashModal(); return; }
  if (key === 'tw') { openTwStockModal(); return; }
  if (key === 'us') { openUsStockModal(); return; }
  if (key === 'crypto') { openCryptoModal(); return; }
  openBasicAssetModal(key);
}

function openBasicAssetModal(key) {
  const user = getUser(), meta = assetMeta[key], assets = assetsForMonth(user, viewMonth);
  openModal(`<header class="modal-header"><div><span class="eyebrow">${monthText(viewMonth)}資產總價</span><h2>更新${meta.label}</h2></div><button class="icon-button" data-close-modal aria-label="關閉">×</button></header><form id="asset-form"><div class="form-row"><label for="asset-amount">${monthText(viewMonth)}總價（TWD）</label><input id="asset-amount" name="amount" type="text" value="${inputAmount(assets[key])}" placeholder="例如：172883+100" required inputmode="text" data-calculator></div><p class="form-note">可直接輸入 172883+100、50000-3200 或 (1200+800)*2。填完四項資產後，再同步該月份資料到走勢圖。</p><div class="modal-actions"><button type="button" class="button light" data-close-modal>取消</button><button class="button primary" type="submit">儲存金額</button></div></form>`);
  const assetForm = currentModal.querySelector('#asset-form'); enableAmountCalculator(assetForm);
  assetForm.addEventListener('submit', event => {
    event.preventDefault();
    const user = getUser(), amount = amountFromForm(assetForm, 'amount'), month = viewMonth;
    if (amount === null) return;
    const monthAssets = month === todayMonth() ? user.assets : ensureMonthSnapshot(user, month).assets;
    monthAssets[key] = amount;
    if (key === 'tw') {
      const state = twStockState(user, month);
      state.manualTotal = amount;
      state.mode = 'manual';
      syncLegacyTwStockData(user, month);
    }
    refreshMonthSnapshotTotal(user, month);
    persistUser(user);
    closeModal();
    renderDashboard();
    showToast(`${meta.label}已更新`);
  });
}

function openAssetsModal() {
  const user = getUser();
  const assets = assetsForMonth(user, viewMonth), gross = grossAssets(user, viewMonth), cashExpenses = cashExpenseTotal(user, viewMonth), cardDue = creditCardPaymentDue(user, viewMonth), cardSpending = creditCardSpendTotal(user, viewMonth), fixed = fixedExpenseTotal(user, viewMonth), total = totalAssets(user, viewMonth);
  const currentCashMode = cashState(user, viewMonth)?.mode;
  const outgoingsRows = currentCashMode === 'ending'
    ? `<li><span>本月現金開銷（已含於末期現金）</span><strong>NT$ ${money(cashExpenses)}</strong></li><li><span>本月信用卡應繳（已含於末期現金）</span><strong>NT$ ${money(cardDue)}</strong></li><li><span>固定開銷（已含於末期現金）</span><strong>NT$ ${money(fixed)}</strong></li>`
    : currentCashMode === 'income'
      ? `<li><span>本月現金開銷（滿額狀態尚未扣除）</span><strong>NT$ ${money(cashExpenses)}</strong></li><li><span>本月信用卡應繳（滿額狀態尚未扣除）</span><strong>NT$ ${money(cardDue)}</strong></li><li><span>固定開銷（滿額狀態尚未扣除）</span><strong>NT$ ${money(fixed)}</strong></li>`
      : `<li><span>－ 本月現金開銷</span><strong>NT$ ${money(cashExpenses)}</strong></li><li><span>－ 本月信用卡應繳（${monthText(previousMonth(viewMonth))}）</span><strong>NT$ ${money(cardDue)}</strong></li><li><span>－ 固定開銷</span><strong>NT$ ${money(fixed)}</strong></li>`;
  const totalNote = currentCashMode === 'ending'
    ? '目前現金採用自動末期現金，開銷不會從總資產重複扣除。'
    : currentCashMode === 'income'
      ? '目前顯示剛領完收入的滿額總資產，所有開銷皆尚未扣除。'
      : `本月刷卡 NT$ ${money(cardSpending)} 會在下個月 25 日從總資產扣除。`;
  openModal(`<header class="modal-header"><div><span class="eyebrow">資產明細</span><h2>${monthText(viewMonth)}資產配置</h2></div><button class="icon-button" data-close-modal aria-label="關閉">×</button></header><ul class="history-list">${Object.entries(assetMeta).map(([key, meta]) => `<li><span>${meta.icon}　${meta.label}</span><strong>NT$ ${money(assets[key])}</strong></li>`).join('')}<li><span>資產合計</span><strong>NT$ ${money(gross)}</strong></li>${outgoingsRows}<li><span><b>總資產</b></span><strong>NT$ ${money(total)}</strong></li></ul><p class="form-note">${totalNote}</p><div class="modal-actions"><button class="button primary" data-close-modal>完成</button></div>`);
}

function openSnapshotModal() {
  const user = getUser(), total = totalAssets(user, viewMonth), month = viewMonth;
  openModal(`<header class="modal-header"><div><span class="eyebrow">月度紀錄</span><h2>同步本月資產</h2></div><button class="icon-button" data-close-modal aria-label="關閉">×</button></header><form id="snapshot-form"><div class="calculated-total"><span>${monthText(month)}總資產</span><strong>NT$ ${money(total)}</strong><small>自動加總現金、台股、美股、加密貨幣</small></div><p class="form-note">同一月份重複同步會覆蓋舊紀錄。請先更新四項資產的目前總價。</p><div class="modal-actions"><button type="button" class="button light" data-close-modal>取消</button><button class="button primary" type="submit">同步到走勢圖</button></div></form>`);
  currentModal.querySelector('#snapshot-form').addEventListener('submit', event => { event.preventDefault(); const user = getUser(), month = viewMonth; const snapshot = ensureMonthSnapshot(user, month); snapshot.assets = { ...assetsForMonth(user, month) }; snapshot.fixedExpenses = cloneFixedExpenses(fixedExpensesForMonth(user, month)); snapshot.total = totalAssets(user, month); user.history.sort((a,b) => a.month.localeCompare(b.month)); persistUser(user); closeModal(); renderDashboard(); showToast(`${monthText(month)}的資產已同步`); });
}

function openIncomeModal() {
  const user = getUser(), month = viewMonth, income = incomeForMonth(user, month);
  openModal(`<header class="modal-header"><div><span class="eyebrow">本月收入</span><h2>更新收入</h2></div><button class="icon-button" data-close-modal aria-label="關閉">×</button></header><form id="income-form"><div class="form-row"><label for="income-month">月份</label><input id="income-month" name="month" type="month" value="${month}" required></div><div class="form-row"><label for="salary-income">薪資收入（TWD）</label><input id="salary-income" name="salary" type="text" value="${inputAmount(income.salary)}" placeholder="例如：50000" required inputmode="text" data-calculator></div><div class="form-row"><label for="other-income">其他收入（TWD）</label><input id="other-income" name="other" type="text" value="${inputAmount(income.other)}" placeholder="例如：12000+3000" required inputmode="text" data-calculator></div><div class="form-row"><label for="other-income-note">其他收入來源（選填）</label><input id="other-income-note" name="otherNote" value="${escapeHTML(income.otherNote)}" placeholder="例如：接案、年終獎金、紅包" maxlength="40"></div><p class="form-note">金額可直接用 + − × ÷ 計算。收入來源會顯示在其他收入下方。</p><div class="modal-actions"><button type="button" class="button light" data-close-modal>取消</button><button class="button primary" type="submit">儲存收入</button></div></form>`);
  const incomeForm = currentModal.querySelector('#income-form'); enableAmountCalculator(incomeForm);
  incomeForm.addEventListener('submit', event => { event.preventDefault(); const form = new FormData(incomeForm), user = getUser(), month = String(form.get('month')), salary = amountFromForm(incomeForm, 'salary'), other = amountFromForm(incomeForm, 'other'); if (salary === null || other === null) return; user.incomes[month] = { salary, other, otherNote: String(form.get('otherNote')).trim() }; viewMonth = month; persistUser(user); closeModal(); renderDashboard(); showToast(`${monthText(month)}的收入已儲存`); });
}

function openHistoryModal() {
  const user = getUser();
  const list = user.history.slice().sort((a, b) => b.month.localeCompare(a.month));
  openModal(`<header class="modal-header"><div><span class="eyebrow">月度紀錄</span><h2>資產歷程</h2></div><button class="icon-button" data-close-modal aria-label="關閉">×</button></header><ul class="history-list">${list.map(item => `<li><span>${monthText(item.month)}</span><span><strong>NT$ ${money(item.total)}</strong> <button class="text-button" data-remove-history="${item.month}" aria-label="刪除 ${item.month}">刪除</button></span></li>`).join('')}</ul><div class="modal-actions"><button class="button light" data-close-modal>關閉</button><button class="button primary" id="history-add">同步本月資產</button></div>`);
  currentModal.querySelector('#history-add').addEventListener('click', openSnapshotModal);
  currentModal.querySelectorAll('[data-remove-history]').forEach(button => button.addEventListener('click', () => { const user = getUser(); if (user.history.length === 1) { showToast('至少保留一筆月份紀錄'); return; } user.history = user.history.filter(item => item.month !== button.dataset.removeHistory); persistUser(user); openHistoryModal(); renderDashboard(); showToast('月份紀錄已刪除'); }));
}

function openExpenseModal(id) {
  const user = getUser(); const fixedExpenses = fixedExpensesForMonth(user, viewMonth); const expense = id ? fixedExpenses.find(item => item.id === id) : null;
  openModal(`<header class="modal-header"><div><span class="eyebrow">${monthText(viewMonth)}固定開銷</span><h2>${expense ? '編輯固定開銷' : '新增固定開銷'}</h2></div><button class="icon-button" data-close-modal aria-label="關閉">×</button></header><form id="expense-form"><div class="form-row"><label for="expense-name">項目名稱</label><input id="expense-name" name="name" value="${escapeHTML(expense?.name || '')}" placeholder="例如：房租" required maxlength="40"></div><div class="form-row"><label for="expense-amount">每月金額（TWD）</label><input id="expense-amount" name="amount" type="text" value="${inputAmount(expense?.amount)}" placeholder="例如：30000+1200" required inputmode="text" data-calculator></div><div class="form-row"><label for="expense-day">扣款日</label><select id="expense-day" name="day">${Array.from({length:31},(_,i) => `<option value="${i+1}" ${(expense?.day || 1) === i+1 ? 'selected' : ''}>每月 ${i+1} 日</option>`).join('')}</select></div><div class="form-row"><label for="expense-category">分類（選填）</label><input id="expense-category" name="category" value="${escapeHTML(expense?.category || '')}" placeholder="例如：居住、訂閱、保險" maxlength="30"></div><div class="modal-actions">${expense ? '<button type="button" class="button danger" id="delete-expense">刪除</button>' : ''}<button type="button" class="button light" data-close-modal>取消</button><button class="button primary" type="submit">${expense ? '儲存變更' : '新增開銷'}</button></div></form>`);
  const expenseForm = currentModal.querySelector('#expense-form'); enableAmountCalculator(expenseForm);
  expenseForm.addEventListener('submit', event => {
    event.preventDefault();
    const form = new FormData(expenseForm), user = getUser(), amount = amountFromForm(expenseForm, 'amount');
    if (amount === null) return;
    const entry = { id: expense?.id || crypto.randomUUID(), name: String(form.get('name')).trim(), amount, day: Number(form.get('day')), category: String(form.get('category')).trim() };
    if (Number.isFinite(Number(expense?.sortOrder))) entry.sortOrder = Number(expense.sortOrder);
    else if (!expense && hasManualExpenseOrder(fixedExpenses)) entry.sortOrder = Math.max(...fixedExpenses.map(item => Number(item.sortOrder) || 0)) + 1;
    if (viewMonth === todayMonth()) {
      if (expense) user.expenses = user.expenses.map(item => item.id === expense.id ? entry : item);
      else user.expenses.push(entry);
    } else {
      const snapshot = ensureMonthSnapshot(user, viewMonth);
      if (expense) snapshot.fixedExpenses = snapshot.fixedExpenses.map(item => item.id === expense.id ? entry : item);
      else snapshot.fixedExpenses.push(entry);
    }
    refreshMonthSnapshotTotal(user, viewMonth);
    persistUser(user);
    closeModal();
    renderDashboard();
    showToast(expense ? '固定開銷已更新' : '固定開銷已新增');
  });
  currentModal.querySelector('#delete-expense')?.addEventListener('click', () => { const user = getUser(); if (viewMonth === todayMonth()) user.expenses = user.expenses.filter(item => item.id !== expense.id); else { const snapshot = ensureMonthSnapshot(user, viewMonth); snapshot.fixedExpenses = snapshot.fixedExpenses.filter(item => item.id !== expense.id); } refreshMonthSnapshotTotal(user, viewMonth); persistUser(user); closeModal(); renderDashboard(); showToast('固定開銷已刪除'); });
}

function openMonthlyExpenseModal(id) {
  const user = getUser(); const expense = id ? user.monthlyExpenses.find(item => item.id === id) : null;
  const defaultDate = viewMonth === todayMonth(user) ? todayDate() : `${viewMonth}-${String(periodStartDay(user)).padStart(2, '0')}`;
  openModal(`<header class="modal-header"><div><span class="eyebrow">${monthText(viewMonth)}開銷</span><h2>${expense ? '編輯一筆開銷' : '記錄一筆開銷'}</h2></div><button class="icon-button" data-close-modal aria-label="關閉">×</button></header><form id="monthly-expense-form"><div class="form-row"><label for="monthly-expense-amount">金額（TWD）</label><input id="monthly-expense-amount" name="amount" type="text" value="${inputAmount(expense?.amount)}" placeholder="例如：120+45" required inputmode="text" data-calculator></div><div class="form-row"><label for="monthly-expense-date">日期</label><input id="monthly-expense-date" name="date" type="date" value="${expense?.date || defaultDate}" required></div><div class="form-row"><label for="monthly-expense-payment">付款方式</label><select id="monthly-expense-payment" name="payment"><option value="cash" ${expense?.payment === 'cash' || !expense ? 'selected' : ''}>現金（本月扣除）</option><option value="card" ${expense?.payment === 'card' ? 'selected' : ''}>信用卡（下月 25 日扣除）</option></select></div><p class="form-note">本月開銷只記付款方式與金額；消費明細可保留在你原本的記錄工具。</p><div class="modal-actions">${expense ? '<button type="button" class="button danger" id="delete-monthly-expense">刪除</button>' : ''}<button type="button" class="button light" data-close-modal>取消</button><button class="button primary" type="submit">${expense ? '儲存變更' : '新增開銷'}</button></div></form>`);
  const monthlyExpenseForm = currentModal.querySelector('#monthly-expense-form'); enableAmountCalculator(monthlyExpenseForm);
  monthlyExpenseForm.addEventListener('submit', event => { event.preventDefault(); const form = new FormData(monthlyExpenseForm), user = getUser(), startDay = periodStartDay(user), oldMonth = expense ? periodMonthForDate(expense.date, startDay) : null, amount = amountFromForm(monthlyExpenseForm, 'amount'), payment = String(form.get('payment')); if (amount === null) return; const entry = { id: expense?.id || crypto.randomUUID(), name: payment === 'card' ? '信用卡消費' : '現金開銷', amount, date: String(form.get('date')), payment, category: '' }; const entryMonth = periodMonthForDate(entry.date, startDay); if (expense) user.monthlyExpenses = user.monthlyExpenses.map(item => item.id === expense.id ? entry : item); else user.monthlyExpenses.push(entry); if (oldMonth) { refreshMonthSnapshotTotal(user, oldMonth); refreshMonthSnapshotTotal(user, shiftMonth(oldMonth, 1)); } refreshMonthSnapshotTotal(user, entryMonth); refreshMonthSnapshotTotal(user, shiftMonth(entryMonth, 1)); viewMonth = entryMonth; persistUser(user); closeModal(); renderDashboard(); showToast(expense ? '本月開銷已更新' : '本月開銷已新增'); });
  currentModal.querySelector('#delete-monthly-expense')?.addEventListener('click', () => { const user = getUser(), expenseMonth = periodMonthForDate(expense.date, periodStartDay(user)); user.monthlyExpenses = user.monthlyExpenses.filter(item => item.id !== expense.id); refreshMonthSnapshotTotal(user, expenseMonth); refreshMonthSnapshotTotal(user, shiftMonth(expenseMonth, 1)); persistUser(user); closeModal(); renderDashboard(); showToast('本月開銷已刪除'); });
}

function openAccountModal() {
  const user = getUser();
  const startDay = periodStartDay(user);
  openModal(`<header class="modal-header"><div><span class="eyebrow">設定</span><h2>記帳設定</h2></div><button class="icon-button" data-close-modal aria-label="關閉">×</button></header><p class="subtle">${escapeHTML(user.name)} · ${escapeHTML(user.email)}</p><form id="account-settings-form"><section class="period-settings-card"><div><label for="period-start-day">每月記帳起始日</label><small>結束日會自動設定為下一個週期開始前一天</small></div><select id="period-start-day" name="periodStartDay" aria-label="每月記帳起始日">${Array.from({ length: 28 }, (_, index) => index + 1).map(day => `<option value="${day}" ${day === startDay ? 'selected' : ''}>每月 ${day} 日</option>`).join('')}</select><p id="period-range-preview">${monthText(viewMonth)}：${periodRangeText(viewMonth, user)}</p></section><p class="form-note">為確保每個月份都有這個日期，可選擇每月 1～28 日。修改後，收入與開銷會依新區間歸類。</p><div class="modal-actions"><button type="button" class="button light" data-close-modal>取消</button><button class="button primary" type="submit">儲存設定</button></div></form><hr class="divider"><button class="button danger account-logout-button" id="confirm-logout" type="button">登出帳號</button>`);
  const settingsForm = currentModal.querySelector('#account-settings-form');
  const startDaySelect = settingsForm.querySelector('#period-start-day');
  const rangePreview = settingsForm.querySelector('#period-range-preview');
  startDaySelect.addEventListener('change', () => {
    const previewUser = { periodStartDay: normalizePeriodStartDay(startDaySelect.value) };
    rangePreview.textContent = `${monthText(viewMonth)}：${periodRangeText(viewMonth, previewUser)}`;
  });
  settingsForm.addEventListener('submit', event => {
    event.preventDefault();
    user.periodStartDay = normalizePeriodStartDay(new FormData(settingsForm).get('periodStartDay'));
    viewMonth = todayMonth(user);
    persistUser(user);
    closeModal();
    renderDashboard();
    showToast(`每月區間已改為 ${periodRangeText(viewMonth, user)}`);
  });
  currentModal.querySelector('#confirm-logout').addEventListener('click', async () => {
    window.clearTimeout(cloudSyncTimer);
    stopMarketQuoteUpdates();
    await syncBookToCloud({ quiet: true });
    await supabaseClient?.auth.signOut();
    activeUser = null;
    closeModal();
    renderAuth();
    showToast('已登出');
  });
}

if ('serviceWorker' in navigator) window.addEventListener('load', () => {
  navigator.serviceWorker.register('./sw.js?v=50').then(registration => registration.update());
});

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && activeUser && Date.now() - lastMarketQuoteRefreshAt >= MARKET_QUOTE_REFRESH_MS) {
    runMarketQuoteRefresh();
  }
});

async function startApp() {
  if (!supabaseClient) { renderCloudSetupError('無法載入雲端服務。請重新整理後再試。'); return; }
  const { data, error } = await supabaseClient.auth.getSession();
  if (error) { renderAuth(); return; }
  if (data.session?.user) await loadCloudBook(data.session.user);
  else renderAuth();
}

startApp();
