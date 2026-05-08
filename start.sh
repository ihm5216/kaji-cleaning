#!/bin/bash
# kaji清掃 起動スクリプト

# 既存プロセス停止
pkill -f "node server.js" 2>/dev/null
pkill -f "nodemon server.js" 2>/dev/null
pkill -f "localhost.run" 2>/dev/null
sleep 1

# サーバー起動（ファイル変更で自動再起動）
cd "$(dirname "$0")"
./node_modules/.bin/nodemon server.js &
sleep 3

# トンネル起動
ssh -o StrictHostKeyChecking=no -R 80:localhost:3001 nokey@localhost.run 2>&1 &
sleep 6

echo ""
echo "=============================="
echo "  起動完了！"
echo "  パソコン: http://localhost:3001"
echo "  携帯(外部): トンネルURLを確認"
echo "=============================="
wait
