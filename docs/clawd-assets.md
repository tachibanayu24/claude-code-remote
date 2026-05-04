# Clawd 素材リファレンス

Claude Code 起動画面の Clawd（カニ風 Unicode ブロックキャラ）の在処と AA データ。`claude-code-remote` の Android UI に流用するための索引。

> 注: Claude Code 本体は非公開。2026 年 3 月に npm パッケージの sourceMap から流出し、復元リポジトリが多数存在する。下記は復元版のミラー。

---

## 1. ソースの場所

`src/components/LogoV2/Clawd.tsx` — 9 列 × 3 行、4 ポーズ。テーマ色 `clawd_body` / `clawd_background` で着色。

| Repo | パス | 行数 | 備考 |
|------|------|------|------|
| go-hare/claude-code-recover-and-python-reset | `recovered-from-cli-js-map/src/components/LogoV2/Clawd.tsx` | 239 | sourceMap 復元（コメント・元 TS 付き） |
| go-hare/claude-code-recover-and-python-reset | `recovered-from-cli-js-map/src/components/LogoV2/AnimatedClawd.tsx` | 123 | アニメーションロジック |
| claytonsandham/claude-code-internals | `src/components/LogoV2/Clawd.tsx.md` | 22 | 仕様解説のみ |
| claytonsandham/claude-code-internals | `src/components/LogoV2/AnimatedClawd.tsx.md` | 20 | 仕様解説のみ |

### curl 用 raw URL

```
https://raw.githubusercontent.com/go-hare/claude-code-recover-and-python-reset/main/recovered-from-cli-js-map/src/components/LogoV2/Clawd.tsx
https://raw.githubusercontent.com/go-hare/claude-code-recover-and-python-reset/main/recovered-from-cli-js-map/src/components/LogoV2/AnimatedClawd.tsx
```

---

## 2. AA データ（4 ポーズ、本物そのまま）

各ポーズは Row1 + Row2 + Row3 の 3 行で構成。Row3 は全ポーズ共通の固定文字列 `  ▘▘ ▝▝  `。

### default

```
 ▐▛███▜▌
▝▜█████▛▘
  ▘▘ ▝▝
```

### look-left（瞳が左に寄る）

```
 ▐▟███▟▌
▝▜█████▛▘
  ▘▘ ▝▝
```

### look-right（瞳が右に寄る）

```
 ▐▙███▙▌
▝▜█████▛▘
  ▘▘ ▝▝
```

### arms-up（両腕を上げる、ジャンプ時に使用）

```
▗▟▛███▜▙▖
 ▜█████▛
  ▘▘ ▝▝
```

### セグメント定義（Clawd.tsx:34-63 そのまま）

```ts
const POSES: Record<ClawdPose, Segments> = {
  default:      { r1L: ' ▐', r1E: '▛███▜', r1R: '▌', r2L: '▝▜', r2R: '▛▘' },
  'look-left':  { r1L: ' ▐', r1E: '▟███▟', r1R: '▌', r2L: '▝▜', r2R: '▛▘' },
  'look-right': { r1L: ' ▐', r1E: '▙███▙', r1R: '▌', r2L: '▝▜', r2R: '▛▘' },
  'arms-up':    { r1L: '▗▟', r1E: '▛███▜', r1R: '▙▖', r2L: ' ▜', r2R: '▛ ' },
};
```

レンダリング:
- Row1 = `r1L` + `r1E`（背景色塗り）+ `r1R`
- Row2 = `r2L` + `█████`（背景色塗り、固定）+ `r2R`
- Row3 = `  ▘▘ ▝▝  `（固定）

look-left/right は r1E の眼を上クォドラント文字（▙/▟）に差し替えるだけ。default と arms-up は下クォドラント（▛/▜）。

---

## 3. Apple Terminal フォールバック

Apple Terminal は Unicode の縦間隔が広いため、背景塗りで描画する別ルートを使う。腕ポーズはサポートされず default にフォールバック。

```ts
const APPLE_EYES: Record<ClawdPose, string> = {
  default:      ' ▗   ▖ ',
  'look-left':  ' ▘   ▘ ',
  'look-right': ' ▝   ▝ ',
  'arms-up':    ' ▗   ▖ ',
};
```

レンダリング:
- Row1 = `▗` + `APPLE_EYES[pose]`（前景/背景反転）+ `▖`
- Row2 = `       `（背景色塗り、7 スペース）
- Row3 = `▘▘ ▝▝`

---

## 4. アニメーション仕様（AnimatedClawd.tsx）

- フレーム長: **60ms**
- コンテナ高: 3 行固定（クロウチ時は足が下にはみ出してクリップ）
- offset: 0 = 通常、1 = しゃがみ（marginTop 増）
- クリックで `JUMP_WAVE` か `LOOK_AROUND` をランダム発火
- 発火条件: マウストラッキング有効（fullscreen / AlternateScreen）かつ `prefersReducedMotion` 無効

### JUMP_WAVE シーケンス

| フレーム数 | pose | offset | 説明 |
|---|---|---|---|
| 2 | default | 1 | しゃがみ |
| 3 | arms-up | 0 | ジャンプ＆万歳 |
| 1 | default | 0 | 着地 |
| 2 | default | 1 | しゃがみ（2 回目） |
| 3 | arms-up | 0 | ジャンプ |
| 1 | default | 0 | 着地 |

### LOOK_AROUND シーケンス

| フレーム数 | pose | offset |
|---|---|---|
| 5 | look-right | 0 |
| 5 | look-left | 0 |
| 1 | default | 0 |

---

## 5. テーマ色

```
clawd_body:       rgb(215, 119, 87)   // オレンジ（カニ色）
clawd_background: rgb(0, 0, 0)        // 黒
```

Ink の `<Text color="clawd_body" backgroundColor="clawd_background">` で参照される。

---

## 6. 改変・周辺ツール（参考）

| Repo | 用途 |
|------|------|
| Piebald-AI/tweakcc | Clawd の色・AA を CLI で改変（`src/patches/hideStartupClawd.ts` で起動 Clawd 非表示も） |
| panuhen/claude-code-crabgotchi | VSCode 拡張で Clawd 風ペットを表示 |
| yousifamanuel/clawd-mochi | ESP32 + TFT の物理デスクペット |
| rullerzhou-afk/clawd-on-desk | デスクトップペット（Clawd テーマ含む） |
| data-goblin/claude-goblin | Clawd を SVG ピクセルアート化 |

---

## 7. 流用方針メモ（claude-code-remote 用）

- **Compose で表示**: `Text` + `FontFamily.Monospace` + `letterSpacing = 0.sp` + `lineHeight` を文字高に揃える。Unicode ブロック文字が等幅で並ぶフォント必須（Noto Sans Mono 等）。
- **背景色塗り**: `Row1` の中央 5 文字と `Row2` の中央 5 文字には `clawd_background` 色の塗りが必要 → `AnnotatedString` で `SpanStyle(background = ...)` を使う。
- **アニメ**: `LaunchedEffect` + `delay(60)` のループ。状態は `mutableStateOf<Pose>(Pose.Default)`。
- **ライセンス注意**: Claude Code 本体は非公開ライセンス。AA テキスト数十バイトの転用は実害ないと思うが、コード構造ごと転用は避け、Compose 側で書き直す。

---

## 8. ローカルキャッシュ

調査時にダウンロードしたファイル:

- `/tmp/Clawd_orig.tsx` — 起動 Clawd 本物（239 行）
- `/tmp/AnimatedClawd_orig.tsx` — アニメ版本物（123 行）
