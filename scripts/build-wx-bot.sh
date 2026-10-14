#!/bin/sh
# 构建桌面端使用的 wx-bot（与 deploy/wechat/Dockerfile 同一固定提交和补丁），输出到 deploy/wechat/bin/wx-bot。
set -eu
ROOT=$(cd "$(dirname "$0")/.." && pwd)
COMMIT=57ed5f56eedce782e378483f762c7565c45ade5d
TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT
git clone -q https://github.com/lawrencewzen/wx-bot.git "$TMP/src"
git -C "$TMP/src" checkout -q --detach "$COMMIT"
python3 "$ROOT/deploy/wechat/patch_upstream.py" "$TMP/src"
# 桌面端补丁：设置 WX_BOT_QR_PNG 时，登录二维码另存为 PNG 供桌面端直接打开。
cat > "$TMP/src/cmd/wx-bot/qrpng.go" <<'GO'
//go:build linux || darwin

package main

import (
	"os"

	"rsc.io/qr"
)

func writeQRPNG(content string) {
	path := os.Getenv("WX_BOT_QR_PNG")
	if path == "" {
		return
	}
	if code, err := qr.Encode(content, qr.M); err == nil {
		_ = os.WriteFile(path, code.PNG(), 0o600)
	}
}
GO
python3 - "$TMP/src/cmd/wx-bot/login.go" <<'PY'
import sys
p = sys.argv[1]
s = open(p).read()
needle = "\t\tif imgURL != \"\" {\n"
assert needle in s
open(p, "w").write(s.replace(needle, needle + "\t\t\twriteQRPNG(imgURL)\n", 1))
PY
mkdir -p "$ROOT/deploy/wechat/bin"
(cd "$TMP/src" && go mod tidy >/dev/null 2>&1 || true; go build -trimpath -ldflags="-s -w" -o "$ROOT/deploy/wechat/bin/wx-bot" ./cmd/wx-bot)
echo "built $ROOT/deploy/wechat/bin/wx-bot"
