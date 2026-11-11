# dsh-trace — 常用组合
# 环境: nix develop / direnv allow

default:
    @just --list

# 跑测试 (Node 直接跑 TS, 无需构建)
test:
    node --test test/*.test.ts

# 类型检查 (src + test, 不产出)
check:
    ./node_modules/.bin/tsc -p tsconfig.check.json

# 构建到 dist/ (发布用)
build:
    pnpm build

# 在指定会话上跑 ingest
ingest path:
    node src/cli/main.ts ingest {{path}}

# 本机最近改动的一份会话路径
latest:
    @find ~/.dsh/sessions -name 'session*.jsonl.zstd' -print0 | xargs -0 ls -t | head -1
