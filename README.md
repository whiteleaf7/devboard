# devboard

AI 自律開発のための開発ボード。タスク・教訓・マイルストーンの SQLite ストア、読み取り専用の Web ダッシュボード、MCP サーバ、CLI を、`devboard` コマンド 1 つにまとめたもの。複数のプロジェクトが、このリポジトリを 1 つだけ共有して使う。

## 入れる

```sh
git clone <このリポジトリ> ~/github/devboard
cd ~/github/devboard
pnpm install
pnpm run link-bin   # ~/.local/bin/devboard に置く。~/.local/bin が PATH に必要
```

Node 24 以上が必要（TypeScript をそのまま実行し、`node:sqlite` を使う）。

## 使う

プロジェクトのディレクトリ（サブディレクトリや linked worktree でもよい）で打つ。

| コマンド                      | することと                                                       |
| ----------------------------- | ---------------------------------------------------------------- |
| `devboard start`              | ダッシュボードを前面で起動する                                   |
| `devboard open`               | ダッシュボードを裏で起動して、ブラウザで開く                     |
| `devboard tailscale [off]`    | Tailscale で公開して URL を出す（`off` で公開をやめる）          |
| `devboard mcp`                | MCP サーバ（stdio）。`.mcp.json` の `command` に `devboard`、`args` に `["mcp"]` |
| `devboard show ...`           | ボードを読む（`overview`・`tasks`・`task <ID>`・`decisions`・`decision <番号>`） |
| `devboard apply '<JSON>'`     | ボードに操作の JSON の配列を当てる（MCP のツールと同じ名前と入力） |
| `devboard recall <質問>`      | 過去のタスク・決定記録・教訓を探す                               |
| `devboard import-history`     | git の履歴にある古いボードを、空の SQLite のボードに取り込む     |

## プロジェクトとデータの場所

- プロジェクトは、コマンドを打った場所の git の main の worktree。`DEVBOARD_ROOT` で別の場所を指せる
- ボードは `~/.devboard/boards/<プロジェクトのディレクトリ名>.sqlite`（`DEVBOARD_DB` で変更可）。git の外にあり、変更はすべてイベントとして追記する
- 決定記録はプロジェクトの `docs/decisions/NNNN-slug.md`
- ダッシュボードの待ち受けは `127.0.0.1` のみ（`DEVBOARD_PORT`・`DEVBOARD_HOSTS`・`DEVBOARD_TS_PORT`）

## 開発する

```sh
pnpm typecheck
pnpm test
```

テストは `DEVBOARD_DB` を一時ファイルに向けるので、本物のボードには触れない。このコマンドは全プロジェクトで同時に使われるので、変更はテストを足してから入れる。
