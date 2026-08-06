<h1 align="center">
  <a href="https://kition.ai"><img src="public/logo-mark.png" alt="Kition ロゴ" width="64" valign="middle" /></a> Kition
</h1>

<p align="center">
  <a href="README.md">English</a> ·
  <a href="README.zh-CN.md">简体中文</a> ·
  <a href="README.ru-RU.md">Русский</a> ·
  <strong>日本語</strong> ·
  <a href="README.vi-VN.md">Tiếng Việt</a> ·
  <a href="README.fr-FR.md">Français</a> ·
  <a href="README.de-DE.md">Deutsch</a> ·
  <a href="README.es-ES.md">Español</a>
</p>

<p align="center">
  <strong>ドキュメント、テーブル、エージェント、ワークフローを一つのデスクトップワークスペースに。</strong><br />
  つながる知識を記述し、データツールを構築し、ブラウザーで調査し、繰り返し作業を自動化します。
</p>

<p align="center">
  <a href="https://github.com/KitionAI/kition/actions/workflows/ci.yml"><img src="https://img.shields.io/github/actions/workflow/status/KitionAI/kition/ci.yml?branch=main&amp;style=flat-square&amp;logo=githubactions&amp;logoColor=white&amp;label=CI" alt="CI ステータス" /></a>
  <a href="https://github.com/KitionAI/kition/releases/latest"><img src="https://img.shields.io/github/v/release/KitionAI/kition?include_prereleases&amp;sort=semver&amp;style=flat-square&amp;color=5645d4" alt="最新リリース" /></a>
  <a href="LICENSE"><img src="https://img.shields.io/github/license/KitionAI/kition?style=flat-square&amp;color=5645d4" alt="ライセンス: GNU AGPLv3" /></a>
</p>

<h3 align="center"><a href="https://github.com/KitionAI/kition/releases/latest"><ins>Kition をダウンロード</ins></a></h3>

<p align="center">
  <a href="https://kition.ai">ウェブサイト</a> ·
  <a href="https://github.com/KitionAI/kition/releases">リリース</a> ·
  <a href="CONTRIBUTING.md">コントリビューション</a> ·
  <a href=".github/SUPPORT.md">サポート</a> ·
  <a href=".github/SECURITY.md">セキュリティ</a>
</p>

<p align="center"><img src="docs/readme/kition-overview.webp" alt="ドキュメント、構造化テーブル、エージェント調査、ビジュアルワークフローを備えた Kition" width="100%" /></p>

Kition は Markdown ドキュメント、構造化テーブル、ツールを利用する AI エージェント、ブラウザー調査、ビジュアルワークフローを一つのデスクトップワークスペースに統合します。編集可能なプロジェクトファイル、型付きレコード、添付ファイル、見えるプロセスをエージェントに提供することで、AI の操作を確認・修正・再実行しやすくします。

> Kition は現在ベータ版です。重要なワークスペースをバックアップし、本番利用の前にエージェントの変更を確認してください。

## Kition を選ぶ理由

- **つながるドキュメント。** Markdown のライブプレビュー、内部リンク、バックリンク、コード、数式、図、デイリーノート、検索、エクスポートを利用できます。
- **知識と並ぶ構造化データ。** 型付きフィールド、数式、フィルター、グループ、ビュー、添付ファイル、AI フィールドで情報を整理できます。
- **実際に操作できるエージェント。** ブラウザーで調査し、ドキュメントやテーブルを読み書きし、結果をプロジェクトへ保存します。
- **レビュー可能なドキュメント編集。** エージェントに現在のドキュメントを編集させ、追加・削除された箇所を一つずつ確認して、変更ごとに承認または却下できます。
- **見える自動化。** トリガーとアクションを組み合わせ、各ステップをテストし、実行履歴を確認できます。

## エージェントに編集を任せても、最終判断はあなたに

Kition エージェントは、コピー＆ペーストが必要な提案を返すだけではありません。現在の Markdown ドキュメントを読み、必要な範囲を直接変更して、結果をワークスペースへ書き戻せます。作業中もドキュメントとタスクの実行過程を並べて確認できます。

<p align="center">
  <img src="docs/readme/agent-document-edit.webp" alt="オープンソースの Kition AI エージェントが現在の Markdown ドキュメントを読み取り、ツール実行履歴の横で直接編集している画面" width="100%" />
</p>

エディター外でファイルが変更されると、Kition は追加・削除・書き換えを強調した差分レビュー画面を開きます。変更は一つずつ承認または却下でき、編集全体をまとめて確認することもできます。

<p align="center">
  <img src="docs/readme/agent-document-diff-review.webp" alt="AI による追加と削除、および変更ごとの承認・却下操作を表示する Kition のドキュメント差分レビュー" width="100%" />
</p>

自然言語で目的を伝え、エージェントに実ファイルを編集させ、差分を確認し、最終ドキュメントに残す内容を決めるという、制御可能なドキュメント作業が実現します。

## 空のプロンプトではなく、作業から始める

Kition はタスクの文脈をドキュメント、テーブル、レコード、テンプレート、ワークフローに保持します。組み込みシナリオは通常の `.kitable` ファイルなので、プロンプト、フィールド関係、生成物、レビュー状態を確認しながら実際のプロジェクトへ適用できます。

### キャンペーン素材を一括生成

主要メッセージと人物写真から、各レコードに 16:9 と 9:16 のサムネイル案を生成します。

<p align="center"><img src="docs/readme/scenarios/thumbnail-generator.webp" alt="Kition サムネイル生成テーブル" width="100%" /></p>

### レシート画像を検索可能なレコードへ変換

添付フィールドにレシートを追加すると、店舗、住所、カテゴリ、構造化 JSON、OCR テキストを同じ行へ抽出できます。

<p align="center"><img src="docs/readme/scenarios/receipt-ocr.webp" alt="Kition レシート OCR テーブル" width="100%" /></p>

### 一つの商品概要から素材パイプラインを展開

商品コンセプトから、デザイン案、正投影図、機能画像、ライフスタイル画像、スタイルボード、発売コピーを生成し、元レコードと関連付けて保持します。

<p align="center"><img src="docs/readme/scenarios/batch-product-designer.webp" alt="Kition 商品デザインテーブル" width="100%" /></p>

## 主な機能

- **ドキュメント:** Markdown 編集、ライブプレビュー、テンプレート、検索、PDF/DOCX エクスポート。
- **テーブル:** 型付きフィールド、添付、数式、フィルター、並べ替え、グループ、複数ビュー。
- **エージェント:** ドキュメント更新、ウェブ調査、ツール利用、ワークスペースへの保存。
- **ワークフロー:** ビジュアルキャンバスでトリガーとアクションを構成し、テストと履歴確認を実行。
- **設定:** メール接続、モデル、プロキシ、MCP、アカウント、使用量、更新、デスクトップ統合。

## インストール

デスクトップ版は [GitHub Releases](https://github.com/KitionAI/kition/releases/latest) から入手できます。

- **macOS:** 最新の `.dmg` をダウンロードします。
- **Windows:** 最新のインストーラーをダウンロードします。
- **旧バージョン:** [リリース履歴](https://github.com/KitionAI/kition/releases)を参照してください。

## ソースから実行

必要環境: Node.js 22.19.0、pnpm 10.33.0。

```bash
pnpm install --frozen-lockfile
pnpm dev
```

ランタイム統合を必要としない UI 開発では `pnpm dev:web` を利用できます。詳細は[ランタイム開発](docs/runtime-development.md)を参照してください。

## オープンソースの範囲

このリポジトリには公開 React/Electron クライアント、公開ランタイム契約、モック、テスト、パッケージング処理が含まれます。Kition ランタイムのソースは別の非公開リポジトリで管理され、このリポジトリには含まれません。通信は [`contracts/runtime/`](contracts/runtime/) の公開契約のみを使用します。

## 技術スタック

| 領域 | 技術 |
| --- | --- |
| デスクトップ | Electron |
| UI | React、TypeScript、Vite |
| ドキュメント | CodeMirror、Marked、Mermaid、KaTeX |
| データと状態 | IndexedDB、Jotai、Zod |
| テスト | Vitest、Playwright |

## コントリビューション

公開クライアントへの Issue と Pull Request を歓迎します。[CONTRIBUTING.md](CONTRIBUTING.md) と [Kition 開発標準](docs/development-standard.md)を確認し、公開クライアントとランタイム契約の境界を守ってください。

## ライセンス

Kition 公開クライアントは [GNU Affero General Public License v3.0 only](LICENSE) の下で提供されます。別途配布される Kition ランタイムには独自のライセンスが適用されます。
