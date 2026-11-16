# devboard

複数のプロジェクトが共有する開発ボード（SQLite ストア・ダッシュボード・MCP・CLI）。使い方は `README.md`。

- パッケージマネージャは pnpm。npm / npx は使わない
- Node の TypeScript 直接実行を使う。import には `.ts` 拡張子を付け、enum や namespace など型の除去だけで消えない構文は使わない（`erasableSyntaxOnly`）
- コミットの前に `pnpm typecheck` と `pnpm test` を通す。メッセージは Conventional Commits の簡潔な英語
- このコマンドは、使っているすべてのプロジェクトに同時に効く。ボードの保存形式（`schema.ts`・`board-db.ts`）を変えるときは、既存のボードがそのまま読めることをテストで確かめる
- プロジェクトの場所はコマンドを打った場所（cwd）から決める。devboard 自身の置き場所に依存するコードを書かない
- ダッシュボードは読み取り専用。ボードへの書き込みは MCP と `devboard apply` だけが行う
- ローカルで待ち受けるサーバは `127.0.0.1` のみにし、Host を確認する
- コマンド（`src/commands.ts`）を足したら、README の表も直す
