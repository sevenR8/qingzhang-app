# 青帳｜資產記帳 PWA

這是一個可安裝到手機桌面的繁體中文資產記帳網頁。它支援：

- 建立帳號、登入與保留登入狀態
- 現金、台股、美股、加密貨幣的目前總價紀錄
- 現金可選擇手動填寫、上月末期現金加本月收入的未扣款滿額模式，或再扣除全部開銷後自動計算本月末期現金
- 滿額模式的現金與總資產都不扣除當月開銷，方便查看收入剛入帳時的資產高點
- 現金計算方式會分月份保存；自動末期現金已包含開銷，不會在總資產重複扣款
- 台股只需輸入股票代碼與股數，透過 Fugle 行情估算持股市值並自動加總，不必手動填寫每股價格
- 台股手動總額可在持股視窗上方直接編輯；勾選持股估值後，同一區域會切換為自動估算總額
- 每個月份各自保存台股持股、股數、價格與估值模式；新月份會複製前月持股，歷史價格則維持凍結
- 美股同樣只需輸入股票代碼與股數，系統會自動取得美元股價與 USD/TWD 匯率並換算台幣
- 每個月份各自保存美股持股、美元價格、匯率與估值模式；手動總額可隨時與持股估值切換
- 加密貨幣只需輸入 BTC、ETH、SOL 等幣種代碼與持有數量，系統會取得美元幣價與 USD/TWD 匯率並換算台幣
- 每個月份各自保存持幣數量、美元幣價、匯率與估值模式；手動總額可隨時與持幣估值切換
- 自動計算總資產：四項資產合計扣除本月開銷與固定開銷，並顯示較上月漲跌
- 使用月份切換器查看與補登各月份的資產、收入、固定開銷與日常開銷
- 所有金額欄位支援 `+`、`-`、`*`、`/` 與括號的即時計算
- 日常開銷只區分現金與信用卡；信用卡消費會在下一個月 25 日計入應繳金額
- 每個記帳月份從當月 5 日到下月 4 日，例如 7 月為 7/5 至 8/4
- 其他收入可加上簡短來源說明，例如接案、獎金或紅包
- 本月開銷清單會自動加總現金與當月信用卡消費
- 本月收支結餘會自動計算：收入扣除固定開銷、現金開銷與信用卡應繳
- 每月薪資收入與其他收入的分項紀錄
- 每月固定開銷的新增、修改與刪除
- 逐筆記錄本月開銷，並區分現金與信用卡付款
- 自訂每月總資產，並以每格 NT$100,000 的折線圖追蹤變化
- 離線快取與手機 PWA 安裝設定

## 本機開啟

在本資料夾執行：

```powershell
py -m http.server 4173
```

接著瀏覽 `http://localhost:4173`。手機與桌面瀏覽器都可以從瀏覽器選單選擇「加入主畫面」或「安裝應用程式」。

## 資料與帳號

目前版本將帳號與記帳資料保存在**該裝置的瀏覽器本機儲存空間**，因此能滿足個人、單一裝置使用與維持登入，但不會自動同步到其他手機或電腦。若要正式上線並支援跨裝置、安全帳號驗證與備份，下一步應串接 Supabase、Firebase 或自有後端資料庫。
# 青帳

個人資產與每月收支追蹤 PWA。

## 雲端同步設定

前端使用 Supabase Auth 與 Postgres。建立 Supabase 專案後，請在 SQL Editor 執行 [supabase/schema.sql](supabase/schema.sql)；資料表會以 Row Level Security 限制為登入者僅能讀寫自己的帳本。

在 Supabase Authentication 的 URL Configuration 中，設定：

- Site URL：`https://sevenr8.github.io/qingzhang-app/`
- Redirect URLs：`https://sevenr8.github.io/qingzhang-app/`

`sb_publishable_...` 公開金鑰可出現在前端；資料庫密碼、`sb_secret_...`、`service_role` 與連線字串不可放入本專案。

## 台股即時估值（Fugle）

台股持股、股數與估值模式會隨青帳資料同步；行情 API 金鑰只存放在 Supabase Edge Function，不會出現在公開網站程式碼中。

1. 到 [Fugle Developer](https://developer.fugle.tw/) 建立行情 API Key。
2. 在 Supabase 建立名為 `stock-quote` 的 Edge Function，內容使用 `supabase/functions/stock-quote/index.ts`。
3. 在該專案的 Edge Function Secrets 新增 `FUGLE_API_KEY`，值為 Fugle API Key。
4. 部署函式；函式程式會自行驗證登入權杖，因此 Dashboard 的「Verify JWT with legacy secret」請關閉。
5. 登入青帳，點「台股」，輸入股票代碼與股數，系統會自動取得目前行情。

目前與未來月份可用最新價格預估；歷史月份可獨立編輯持股並保留月度快照，避免過去資產被今天股價改寫。新月份第一次開啟時會複製最近月份的持股，再由使用者調整買進或賣出後的股數。

## 美股自動估值

美股行情不需要另外申請 API Key。前端會透過 Supabase Edge Function 取得美元股價與 USD/TWD 匯率，API 來源不會直接暴露給瀏覽器。

1. 在 Supabase 建立名為 `us-stock-quote` 的 Edge Function。
2. 函式內容使用 `supabase/functions/us-stock-quote/index.ts`。
3. 部署函式，並關閉「Verify JWT with legacy secret」；函式本身仍會驗證使用者登入權杖。
4. 登入青帳，點「美股」，輸入例如 `AAPL` 與持有股數。

目前與未來月份可用最新美元股價與匯率預估；歷史月份會使用保存的月度快照，避免過去資產跟著今天行情變動。

## 加密貨幣自動估值

加密貨幣行情不需要另外申請 API Key，並與美股相同透過 Supabase Edge Function 取得美元價格及 USD/TWD 匯率。

1. 在 Supabase 建立名為 `crypto-quote` 的 Edge Function。
2. 函式內容使用 `supabase/functions/crypto-quote/index.ts`。
3. 部署函式，並關閉「Verify JWT with legacy secret」；函式本身仍會驗證使用者登入權杖。
4. 登入青帳，點「加密貨幣」，輸入例如 `BTC` 與持有數量。

目前與未來月份可用最新幣價與匯率預估；歷史月份會使用保存的月度快照。單一函式支援 BTC、ETH、SOL 等 Yahoo Finance 有提供美元行情的幣種。
