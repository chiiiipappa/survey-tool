"use strict";

const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const REQUIRED = ["app", "static", "sample_data", "requirements.txt", "electron/main.js"];

let missing = [];
for (const rel of REQUIRED) {
  if (!fs.existsSync(path.join(ROOT, rel))) missing.push(rel);
}

if (missing.length > 0) {
  console.error("[build] 必須ファイル/ディレクトリが見つかりません:");
  for (const m of missing) console.error(`  - ${m}`);
  process.exit(1);
}

console.log("[build] 同梱対象の確認が完了しました。electron-builder の実行準備ができています。");
