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
  const milliseconds = timestamp > 1e14 ? timestamp / 1000 : timestamp < 1e11 ? timestamp * 1000 : timestamp;
  const date = new Date(milliseconds);
  return Number.isNaN(date.getTime()) ? new Date().toISOString() : date.toISOString();
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

  const fugleApiKey = Deno.env.get('FUGLE_API_KEY');
  if (!fugleApiKey) return json({ error: '尚未設定 Fugle 行情金鑰' }, 503);

  let payload: { items?: Array<{ symbol?: unknown; oddLot?: unknown }> };
  try {
    payload = await request.json();
  } catch {
    return json({ error: '請求內容格式錯誤' }, 400);
  }

  const items = Array.isArray(payload.items) ? payload.items : [];
  const unique = new Map<string, boolean>();
  for (const item of items) {
    const symbol = String(item?.symbol || '').trim().toUpperCase();
    if (/^[0-9A-Z]{4,6}$/.test(symbol)) unique.set(symbol, Boolean(item?.oddLot));
  }
  if (!unique.size) return json({ error: '沒有可查詢的股票代碼' }, 400);
  if (unique.size > 20) return json({ error: '一次最多更新 20 檔股票' }, 400);

  const results = await Promise.all([...unique].map(async ([symbol, oddLot]) => {
    const url = new URL(`https://api.fugle.tw/marketdata/v1.0/stock/intraday/quote/${encodeURIComponent(symbol)}`);
    if (oddLot) url.searchParams.set('type', 'oddlot');
    try {
      const response = await fetch(url, { headers: { 'X-API-KEY': fugleApiKey } });
      const data = await response.json();
      if (!response.ok) throw new Error(data?.message || `HTTP ${response.status}`);
      const price = Number(data?.lastTrade?.price ?? data?.lastPrice ?? data?.closePrice ?? data?.previousClose);
      if (!Number.isFinite(price) || price <= 0) throw new Error('沒有可用價格');
      return {
        quote: {
          symbol,
          name: String(data?.name || symbol),
          price,
          isClose: Boolean(data?.isClose),
          quoteAt: quoteTimestamp(data?.lastUpdated),
          market: String(data?.market || ''),
        },
      };
    } catch (error) {
      return { error: { symbol, message: error instanceof Error ? error.message : '報價查詢失敗' } };
    }
  }));

  const quotes = results.flatMap((result) => 'quote' in result ? [result.quote] : []);
  const errors = results.flatMap((result) => 'error' in result ? [result.error] : []);
  return json({ quotes, errors });
});
