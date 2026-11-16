# devboard

AI 自律開発のための開発ボード。タスク・教訓・マイルストーンを SQLite に記録し、読み取り専用の Web ダッシュボード、MCP サーバ、CLI を `devboard` コマンド 1 つにまとめたもの。複数のプロジェクトが、このリポジトリを 1 つだけ共有して使う。主な読み手は AI エージェント。

## 導入する（AI 向けの手順）

上から順に実行し、各手順の確認が通ってから次へ進む。

1. 前提を確かめる。`git --version` と `node --version`（24 以上）と `pnpm --version` が通ること。pnpm が無ければ `corepack enable`。Node が 24 未満なら、入れ直しはユーザーに頼む
2. 入れる
   ```sh
   git clone https://github.com/whiteleaf7/devboard.git ~/github/devboard
   cd ~/github/devboard
   pnpm install
   pnpm run link-bin   # ~/.local/bin/devboard に置く
   ```
3. 確かめる。`devboard --help` がコマンドの一覧を出すこと。`command not found` なら `~/.local/bin` が PATH に無い。シェルの設定に `export PATH="$HOME/.local/bin:$PATH"` を足し、ユーザーにシェルを開き直すよう頼む（絶対パス `~/.local/bin/devboard` なら今すぐ動く）
4. プロジェクトに登録する。プロジェクトの `.mcp.json`（Claude Code）に足す。既にあれば `mcpServers` に `devboard` だけを足す
   ```json
   {
     "mcpServers": {
       "devboard": { "command": "devboard", "args": ["mcp"] }
     }
   }
   ```
   Codex は `.codex/config.toml`。
   ```toml
   [mcp_servers.devboard]
   command = "devboard"
   args = ["mcp"]
   ```
5. 確かめる。プロジェクトのディレクトリで `devboard show overview` が JSON を出すこと。ボードは初回に自動で作られ、初期化は要らない
6. 任意。表示名と概要を決める
   ```sh
   devboard apply '[{"op":"set_project","args":{"name":"表示名","summary":"一言の説明"}}]'
   ```
7. 登録した MCP サーバは、エージェントのセッションを開き直すまで読み込まれない。ユーザーにそう伝える。入っているツールの名前は `devboard tools`

更新は `cd ~/github/devboard && git pull && pnpm install`。このコマンドは入れたすべてのプロジェクトに同時に効く。外すときは `~/.local/bin/devboard` を消す（ボードの `~/.devboard/` は残る）。

## 使うときの注意

- プロジェクトは、コマンドを打った場所（サブディレクトリや linked worktree でもよい）の git の main の worktree。別の場所は `DEVBOARD_ROOT` で指す
- `devboard start` は前面で動き続けて戻らない。`devboard open` はブラウザを開く。AI が自分で打つ必要はなく、ユーザーに見せたいときは `devboard tailscale` を打ち、出た URL を渡す。Tailscale が動いていないときだけ、MCP の `open_dashboard` が返すローカルの URL を渡す
- ダッシュボードは読み取り専用。ボードに書けるのは MCP と `devboard apply` だけ。待ち受けは `127.0.0.1` のみ
- ボードは `~/.devboard/boards/<プロジェクトのディレクトリ名>.sqlite`（`DEVBOARD_DB` で変更可）。プロジェクトの git の外にあり、変更はすべてイベントとして追記する。実験や検証は `devboard snapshot <ファイル>` で写しを取り、`DEVBOARD_DB` をその写しに向けて行う。本物のボードで試さない
- 決定記録はプロジェクトの `docs/decisions/NNNN-slug.md`
- `devboard apply` の JSON は、シェルのシングルクォートで囲む。操作の名前と入力は MCP のツールと同じ

## プロジェクトごとの設定（`.devboard.json`）

devboard は全プロジェクトで共有するので、プロジェクトの名前や場所はコードに持たない。違いは、プロジェクトの根の `.devboard.json`（任意。無ければ既定）で渡す。コマンドを打った場所から上へたどって最初に見つかったものを使い、無ければプロジェクトの根（main の worktree）のものを使う。

```json
{
  "decisionsDir": "docs/decisions",
  "hiddenPaths": ["tools/harness/eval/heldout/"],
  "rules": {
    "profile": "autodev",
    "verificationHint": "手段は docs/verification.md の「使える手段」: …"
  }
}
```

- `decisionsDir`: 決定記録を置くディレクトリ（プロジェクトの根からの相対。既定は `docs/decisions`）
- `hiddenPaths`: `recall` が、触ったタスクの説明・メモ・結び付いた教訓の本文を返さないパスの接頭辞（最終評価用の資料など）。既定は空
- `rules.profile`: `autodev`（既定）は、書き込みの決まり（メモの無い done・cancelled・blocked、AI のタスクの review、子が残る親の done、動かした結果の無い振る舞いのタスクの done）を使う。`none` は使わない。つながりの検査（存在しない親・依存、循環）は、どちらでも使う
- `rules.verificationHint`: 「動かした: `コマンド` → 結果」の書き方を断るときの案内の続き。プロジェクトの確かめる手段（文書や道具の名前）を書く
- 知らない項目や壊れた JSON は、ファイルの名前を添えて断る

## コマンド

| コマンド                      | することと                                                       |
| ----------------------------- | ---------------------------------------------------------------- |
| `devboard start`              | ダッシュボードを前面で起動する                                   |
| `devboard open`               | ダッシュボードを裏で起動して、ブラウザで開く                     |
| `devboard tailscale [off]`    | Tailscale で公開して URL を出す（`off` で公開をやめる）          |
| `devboard mcp`                | MCP サーバ（stdio）。`.mcp.json` の `command` に `devboard`、`args` に `["mcp"]` |
| `devboard show ...`           | ボードを読む（`overview`・`tasks`・`task <ID>`・`decisions`・`decision <番号>`） |
| `devboard apply '<JSON>'`     | ボードに操作の JSON の配列を当てる（MCP のツールと同じ名前と入力。`set_project` で表示名と概要も書ける） |
| `devboard recall <質問>`      | 過去のタスク・決定記録・教訓を探す                               |
| `devboard snapshot <ファイル>` | ボードの写しを SQLite のファイルとして書き出す（バックアップ・複製して試す用） |
| `devboard tools`              | MCP のツールの名前を JSON の配列で出す（ドキュメントや設定の検査用） |
| `devboard lint-decisions`     | 標準入力の決定記録（JSON `[{file,text}]`）の形式を検査し、問題を JSON で出す（あれば終了コード 1。CI から使える） |
| `devboard import-history`     | git の履歴にある古いボードを、空の SQLite のボードに取り込む     |

環境変数: `DEVBOARD_ROOT`（プロジェクトの場所）、`DEVBOARD_DB`（ボードのファイル）、`DEVBOARD_PORT`（既定 4848）、`DEVBOARD_TS_PORT`（既定 8448）、`DEVBOARD_HOSTS`（ダッシュボードに許可する tailnet の名前を足す。カンマ区切り）。

## このリポジトリを開発する

```sh
pnpm typecheck
pnpm test
```

テストは `DEVBOARD_DB` を一時ファイルに向けるので、本物のボードには触れない。変更はテストを足してから入れる。
