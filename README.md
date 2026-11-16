# devboard

AI 自律開発のための開発ボード。タスク・教訓・マイルストーンを SQLite に記録し、読み取り専用の Web ダッシュボード、MCP サーバ、CLI を `devboard` コマンド 1 つにまとめたもの。複数のプロジェクトが、このリポジトリを 1 つだけ共有して使う。

## 入れる

必要なもの:

- git
- Node 24 以上（TypeScript をそのまま実行し、`node:sqlite` を使う。`node --version` で確かめる）
- pnpm（`packageManager` に固定したバージョンを使う。無ければ `corepack enable` で入る）

```sh
git clone https://github.com/whiteleaf7/devboard.git ~/github/devboard
cd ~/github/devboard
pnpm install
pnpm run link-bin   # ~/.local/bin/devboard に置く
```

`~/.local/bin` が PATH に無いと `devboard` が見つからない。次で確かめる。

```sh
devboard --help     # コマンドの一覧が出れば入っている
```

`command not found` と出たら、シェルの設定に `export PATH="$HOME/.local/bin:$PATH"` を足して、シェルを開き直す。

リポジトリの場所を変えたときは、移動先で `pnpm run link-bin` をもう一度打つ。

## プロジェクトで使う

プロジェクトの設定や初期化は要らない。プロジェクトのディレクトリ（サブディレクトリや linked worktree でもよい）で打つだけで、ボードが自動で作られる。

```sh
cd ~/github/my-project
devboard show overview                                  # 空のボードが出る
devboard apply '[{"op":"set_project","args":{"name":"my-project","summary":"一言の説明"}}]'   # 表示名と概要を決める（任意）
devboard open                                           # ダッシュボードをブラウザで開く
```

### AI から使う（MCP）

プロジェクトの `.mcp.json` に書くと、Claude Code から使える。

```json
{
  "mcpServers": {
    "devboard": { "command": "devboard", "args": ["mcp"] }
  }
}
```

Codex は `.codex/config.toml` に書く。

```toml
[mcp_servers.devboard]
command = "devboard"
args = ["mcp"]
```

MCP サーバは、起動したディレクトリのプロジェクトのボードを読み書きする。入っているツールの名前は `devboard tools` で見られる。

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
| `devboard import-history`     | git の履歴にある古いボードを、空の SQLite のボードに取り込む     |

## ダッシュボード

- 読み取り専用。ボードに書けるのは MCP と `devboard apply` だけ
- 待ち受けは `127.0.0.1` のみ。ポートは 4848（`DEVBOARD_PORT` で変更）。`devboard open` が開く
- スマホなど別の端末から見たいときは、Tailscale を入れて `devboard tailscale` を打つ。出た URL を開く（やめるときは `devboard tailscale off`）。ポートは `DEVBOARD_TS_PORT`、許可する名前の追加は `DEVBOARD_HOSTS`

## データの場所

- プロジェクトは、コマンドを打った場所の git の main の worktree。`DEVBOARD_ROOT` で別の場所を指せる
- ボードは `~/.devboard/boards/<プロジェクトのディレクトリ名>.sqlite`（`DEVBOARD_DB` で変更可）。プロジェクトの git の外にあり、変更はすべてイベントとして追記する。バックアップは `devboard snapshot`
- 決定記録はプロジェクトの `docs/decisions/NNNN-slug.md`

## 更新する

```sh
cd ~/github/devboard
git pull
pnpm install
```

このコマンドは入れたすべてのプロジェクトに同時に効く。

## 外す

`rm ~/.local/bin/devboard` でコマンドを消す。ボード（`~/.devboard/`）は残るので、要らなければ別に消す。

## 開発する

```sh
pnpm typecheck
pnpm test
```

テストは `DEVBOARD_DB` を一時ファイルに向けるので、本物のボードには触れない。変更はテストを足してから入れる。
