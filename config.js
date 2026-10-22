// 前端設定（不含任何機密；公開託管也安全）。案場、名單、設定一律由後端驗證身分後才回傳。
window.SITE_CONFIG = {
  // LINE Developers → LINE Login channel 2012150599 → LIFF 分頁「新增」後的 LIFF ID（如菓現場回報，10/22 建）
  LIFF_ID: '2012150599-ywxsoLPY',
  // 現場回報 Apps Script「部署為網頁應用程式」的 exec 網址（10/22 部署 v1；改版用「管理部署作業→建立新版本」，網址不變）
  GAS_URL: 'https://script.google.com/macros/s/AKfycbyV9INVoDc8T33MEzcGq_jAo6ICn-aiImxwXYv-g71CGYPaXXr0445EIZnNUqE7xv9Xxw/exec',
  TIMEOUT_MS: 30000,
  // 送出後以同仁本人身分在聊天室留一則收據（liff.sendMessages，不吃官方帳號額度；需 LIFF 開 chat_message.write）
  RECEIPT: false
};
