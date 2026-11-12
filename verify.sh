#!/usr/bin/env bash
# 用法：
#   ./verify.sh                          默认任务
#   ./verify.sh 打开计算器并计算 8 + 9     传入自定义命令
cd "$(dirname "$0")"

export PATH="$PWD/.tools/node/bin:$PWD/node_modules/.bin:$PWD/.tools/bin:$PATH"
export DSH_HOME="$PWD/.tools/dsh-home"

TASK="${*:-打开计算器并计算 5 + 5}"

dsh --profile desktop-cua --json "$TASK"