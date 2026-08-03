import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), {
  status,
  headers: { ...corsHeaders, 'Content-Type': 'application/json; charset=utf-8' },
});

const quoteTimestamp = (value: unknown) => {
  const timestamp = Number(value);
  if (!Number.isFinite(timestamp)) return new Date().toISOString();
  const date = new Date(timestamp < 1e11 ? timestamp * 1000 : timestamp);
  return Number.isNaN(date.getTime()) ? new Date().toISOString() : date.toISOString();
};

const isoDate = (value: unknown) => {
  const date = String(value || '').trim();
  return /^\d{4}-\d{2}-\d{2}$/.test(date) ? date : '';
};

const shiftIsoDate = (dateString: string, days: number) => {
  const date = new Date(`${dateString}T12:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
};

const yahooChart = async (symbol: string, asOf = '') => {
  const url = new URL(`https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}`);
  if (asOf) {
    url.searchParams.set('period1', String(Math.floor(new Date(`${shiftIsoDate(asOf, -14)}T00:00:00Z`).getTime() / 1000)));
    url.searchParams.set('period2', String(Math.floor(new Date(`${shiftIsoDate(asOf, 1)}T00:00:00Z`).getTime() / 1000)));
  } else {
    url.searchParams.set('range', '1d');
  }
  url.searchParams.set('interval', '1d');
  const response = await fetch(url, {
    headers: {
      Accept: 'application/json',
      'User-Agent': 'Mozilla/5.0 (compatible; QingZhang/1.0)',
    },
  });
  const data = await response.json();
  if (!response.ok) throw new Error(data?.chart?.error?.description || `HTTP ${response.status}`);
  const result = data?.chart?.result?.[0];
  if (!result || data?.chart?.error) throw new Error(data?.chart?.error?.description || '沒有可用行情');
  const closes = Array.isArray(result?.indicators?.quote?.[0]?.close) ? result.indicators.quote[0].close : [];
  const timestamps = Array.isArray(result?.timestamp) ? result.timestamp : [];
  const historicalCutoff = asOf ? Math.floor(new Date(`${asOf}T23:59:59Z`).getTime() / 1000) : 0;
  const historicalIndex = asOf ? closes.map((value: unknown, index: number) => ({ value: Number(value), index, timestamp: Number(timestamps[index]) }))
    .filter((item: { value: number; timestamp: number }) => Number.isFinite(item.value) && item.value > 0 && item.timestamp <= historicalCutoff).at(-1)?.index : -1;
  const lastClose = closes.filter((value: unknown) => Number.isFinite(Number(value))).at(-1);
  const price = Number(asOf && historicalIndex >= 0 ? closes[historicalIndex] : result?.meta?.regularMarketPrice ?? result?.meta?.previousClose ?? lastClose);
  if (!Number.isFinite(price) || price <= 0) throw new Error('沒有可用價格');
  const quoteAt = asOf && historicalIndex >= 0 ? quoteTimestamp(timestamps[historicalIndex]) : quoteTimestamp(result?.meta?.regularMarketTime);
  return {
    price,
    currency: String(result?.meta?.currency || ''),
    quoteAt,
  };
};

Deno.serve(async (request) => {
  if (request.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });
  if (request.method !== 'POST') return json({ error: 'Method not allowed' }, 405);

  const authorization = request.headers.get('Authorization');
  if (!authorization) return json({ error: '請先登入青帳' }, 401);

  const supabaseUrl = Deno.env.get('SUPABASE_URL');
  const supabaseAnonKey = Deno.env.get('SUPABASE_ANON_KEY');
  if (!supabaseUrl || !supabaseAnonKey) return json({ error: 'Supabase 環境設定不完整' }, 500);

  const supabase = createClient(supabaseUrl, supabaseAnonKey, {
    global: { headers: { Authorization: authorization } },
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const { data: { user }, error: userError } = await supabase.auth.getUser();
  if (userError || !user) return json({ error: '登入狀態已失效，請重新登入' }, 401);

  let payload: { items?: Array<{ symbol?: unknown }>; asOf?: unknown };
  try {
    payload = await request.json();
  } catch {
    return json({ error: '請求內容格式錯誤' }, 400);
  }

  const asOf = isoDate(payload.asOf);
  if (payload.asOf && !asOf) return json({ error: '歷史日期格式錯誤' }, 400);

  const items = Array.isArray(payload.items) ? payload.items : [];
  const symbols = [...new Set(items.map(item => String(item?.symbol || '').trim().toUpperCase()).filter(symbol => /^[A-Z][A-Z0-9.-]{0,9}$/.test(symbol)))];
  if (!symbols.length) return json({ error: '沒有可查詢的美股代碼' }, 400);
  if (symbols.length > 20) return json({ error: '一次最多更新 20 檔股票' }, 400);

  let exchangeRate: number;
  try {
    const exchange = await yahooChart('TWD=X', asOf);
    exchangeRate = exchange.price;
  } catch (error) {
    return json({ error: error instanceof Error ? `無法取得 USD/TWD 匯率：${error.message}` : '無法取得 USD/TWD 匯率' }, 502);
  }

  const results = await Promise.all(symbols.map(async (symbol) => {
    try {
      const quote = await yahooChart(symbol, asOf);
      if (quote.currency && quote.currency !== 'USD') throw new Error(`幣別為 ${quote.currency}，目前只支援美元`);
      return {
        quote: {
          symbol,
          name: symbol,
          price: quote.price,
          exchangeRate,
          quoteAt: quote.quoteAt,
          historicalAsOf: asOf || undefined,
        },
      };
    } catch (error) {
      return { error: { symbol, message: error instanceof Error ? error.message : '報價查詢失敗' } };
    }
  }));

  const quotes = results.flatMap(result => 'quote' in result ? [result.quote] : []);
  const errors = results.flatMap(result => 'error' in result ? [result.error] : []);
  return json({ quotes, errors, exchangeRate });
});
