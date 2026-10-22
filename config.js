// 前端設定（不含任何機密；公開託管也安全）。案場、名單、設定一律由後端驗證身分後才回傳。
window.SITE_CONFIG = {
  // LINE Developers → LINE Login channel 2012150599 → LIFF 分頁「新增」後的 LIFF ID（待老闆建立）
  LIFF_ID: 'TODO_LIFF_ID',
  // 現場回報 Apps Script「部署為網頁應用程式」的 exec 網址（待部署）
  GAS_URL: 'TODO_GAS_EXEC_URL',
  GEO_TIMEOUT_MS: 15000,
  TIMEOUT_MS: 30000,
  // 送出後以同仁本人身分在聊天室留一則收據（liff.sendMessages，不吃官方帳號額度；需 LIFF 開 chat_message.write）
  RECEIPT: false
};
