# Feature Spec: キーカラーを赤から青に変更

**作成日**: 2026-06-21  
**ステータス**: Draft

---

## Overview

アプリ全体のキーカラー（プライマリカラー）を赤 (#DF0515) から青 (#1A6FD4) に変更する。CSS変数で管理されているため、変数定義と fallback値を一括更新する。

## User Story

> As a ユーザー,  
> I want to アプリのキーカラーが青で統一されている状態にする,  
> so that ブランドカラーが変わったアプリを使える.

## Current State

現状の関連ファイルと動作：
- `static/css/app.css:5-7`: `:root` で3つのCSS変数を定義
  - `--color-primary: #DF0515`（赤）
  - `--color-primary-dark: #B8010F`（濃い赤）
  - `--color-primary-light: #FDECEA`（薄い赤/ピンク）
- `static/css/app.css`: `var(--color-primary, #DF0515)` 形式で fallback値が多数存在（18箇所）
- `static/css/app.css:1992`: グラデーションに旧赤 `#DF0515` が含まれる

**変更しない箇所（意図的な赤）:**
- `--color-error-bg`, `--color-error-text`: エラー色（赤のまま）
- `.toast.error`: エラートースト
- `static/index.html:1325`: 削除ボタン `color:#DF0515`（danger色として意図的）
- `static/js/report.js:1014`: チャートカラー配列内の `#DF0515`（UIのキーカラーとは別）

## Technical Design

### Backend
変更なし。

### Frontend (`static/css/app.css`)

**変更する色:**

| 旧値 | 新値 | 用途 |
|:---|:---|:---|
| `#DF0515` | `#1A6FD4` | primary (var + fallback) |
| `#B8010F` | `#1457A8` | primary-dark (var + fallback) |
| `#FDECEA` | `#EAF2FF` | primary-light (var + fallback) |

**CSS変数（`:root`）:**
```css
--color-primary:      #1A6FD4;
--color-primary-dark: #1457A8;
--color-primary-light: #EAF2FF;
```

**Fallback値の置換:**
- `var(--color-primary, #DF0515)` → `var(--color-primary, #1A6FD4)`
- `var(--color-primary-dark, #B8010F)` → `var(--color-primary-dark, #1457A8)`
- `var(--color-primary-light, #FDECEA)` → `var(--color-primary-light, #EAF2FF)`

**グラデーション（line 1992）:**
```css
/* 変更前 */
background: linear-gradient(135deg, #DF0515 0%, #0071BC 100%);
/* 変更後 */
background: linear-gradient(135deg, #1A6FD4 0%, #0D3F7A 100%);
```

### Data Flow
なし（純粋なスタイル変更）

## Task Breakdown

| # | タスク | サイズ | 対象ファイル | Agent Safe? |
|---|--------|--------|-------------|-------------|
| 1 | `static/css/app.css` のCSS変数3つとfallback値をすべて青に置換。エラー色・削除ボタン・チャート色は変更しない | S | `static/css/app.css` | ✅ |

**サイズ目安**: S = 30分以内

## Delegation Plan

**✅ 即委譲可能:**
- Task #1: `app.css` のキーカラー一括置換

**⚠️ 委譲前に要確認:**
なし

## Acceptance Criteria

- [ ] ヘッダー・ボタン（btn-primary）が青で表示される
- [ ] アクティブタブ下線が青で表示される
- [ ] チェックボックスのアクセントカラーが青になっている
- [ ] エラートースト・エラーバッジは引き続き赤で表示される
- [ ] 削除ボタン（step1-edit-delete-btn）は引き続き赤で表示される

## Browser Test

- [ ] Desktop Chrome: 必要（全STEPで目視確認）
- [ ] Mobile Safari: 不要

## Risks

- fallback値の置換漏れ: `grep` で全 `#DF0515` / `#B8010F` / `#FDECEA` の残存を確認することで検証可能
- エラー色との混同: 変更スコープを `app.css` の primary 系に限定し、`--color-error-*` 変数定義行は手を触れない
