#!/bin/sh
# 本地开发：进程退出后 1 秒自动拉起，模拟 Docker 的 restart；Ctrl+C 整体退出
trap 'kill "$child" 2>/dev/null; exit 0' INT TERM
while true; do
	node apps/server/dist/main.js &
	child=$!
	wait "$child"
	echo "进程已退出（代码 $?），1 秒后重启……"
	sleep 1
done
