#!/usr/bin/env bash
# =============================================================================
# 更新 xiaoyi-channel 插件脚本
#   1) 从 ~/.openclaw/openclaw.json 的 plugins.entries 中移除 "xiaoyi-channel"
#   2) 删除 ~/.openclaw/extensions/xiaoyi-channel 目录
#   3) 安装 package 目录下的 tgz 包
#   4) 重启 openclaw-gateway
#
# 用法：bash update-xiaoyi-channel.sh
# 说明：脚本为幂等设计，可重复执行；所有改动前均自动备份。
# =============================================================================

set -euo pipefail

CONFIG_FILE="$HOME/.openclaw/openclaw.json"
PLUGIN_NAME="xiaoyi-channel"
PLUGIN_DIR="$HOME/.openclaw/extensions/$PLUGIN_NAME"
TGZ_NAME="ynhcj-xiaoyi-channel-0.0.18.tgz"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TGZ_PATH="$SCRIPT_DIR/$TGZ_NAME"

BACKUP_DIR="$HOME/.openclaw/backup/$(date +%Y%m%d_%H%M%S)"

log()  { echo -e "\033[1;34m[INFO]\033[0m $*"; }
warn() { echo -e "\033[1;33m[WARN]\033[0m $*"; }
die()  { echo -e "\033[1;31m[ERROR]\033[0m $*" >&2; exit 1; }

# ---------------------------------------------------------------------------
# 0. 前置检查
# ---------------------------------------------------------------------------
log "步骤 0/4：环境检查"
command -v python3 >/dev/null 2>&1 || die "未找到 python3"
[ -f "$CONFIG_FILE" ] || die "配置文件不存在：$CONFIG_FILE"
[ -f "$TGZ_PATH" ]    || die "安装包不存在：$TGZ_PATH"

mkdir -p "$BACKUP_DIR"
log "备份目录：$BACKUP_DIR"

# ---------------------------------------------------------------------------
# 1. 从 openclaw.json 的 plugins.entries 中移除 xiaoyi-channel
# ---------------------------------------------------------------------------
log "步骤 1/4：从配置中移除 plugins.entries.\"$PLUGIN_NAME\""

cp -a "$CONFIG_FILE" "$BACKUP_DIR/openclaw.json.bak"
log "已备份配置 -> $BACKUP_DIR/openclaw.json.bak"

python3 - "$CONFIG_FILE" "$PLUGIN_NAME" <<'PY'
import json, sys, os, tempfile

cfg_path, name = sys.argv[1], sys.argv[2]

with open(cfg_path, "r", encoding="utf-8") as f:
    data = json.load(f)

entries = data.get("plugins", {}).get("entries", {})
if name in entries:
    del entries[name]
    # 原子写入：先写临时文件再替换
    fd, tmp = tempfile.mkstemp(dir=os.path.dirname(cfg_path) or ".", suffix=".tmp")
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as f:
            json.dump(data, f, indent=2, ensure_ascii=False)
            f.write("\n")
        os.replace(tmp, cfg_path)
    finally:
        if os.path.exists(tmp):
            os.remove(tmp)
    print(f"[OK] 已移除 plugins.entries.{name}")
else:
    print(f"[SKIP] plugins.entries 中不存在 {name}，无需移除")

# 校验 JSON 合法
with open(cfg_path, "r", encoding="utf-8") as f:
    json.load(f)
print("[OK] 配置 JSON 校验通过")
PY

# ---------------------------------------------------------------------------
# 2. 删除 extensions/xiaoyi-channel 目录（先备份再删除）
# ---------------------------------------------------------------------------
log "步骤 2/4：删除插件目录 $PLUGIN_DIR"

if [ -d "$PLUGIN_DIR" ]; then
    cp -a "$PLUGIN_DIR" "$BACKUP_DIR/xiaoyi-channel-ext.bak"
    log "已备份旧插件目录 -> $BACKUP_DIR/xiaoyi-channel-ext.bak"
    if command -v trash >/dev/null 2>&1; then
        trash "$PLUGIN_DIR" && log "已移入回收站：$PLUGIN_DIR"
    else
        rm -rf "$PLUGIN_DIR" && log "已删除：$PLUGIN_DIR"
    fi
else
    warn "插件目录不存在，跳过：$PLUGIN_DIR"
fi

# ---------------------------------------------------------------------------
# 3. 安装新包
# ---------------------------------------------------------------------------
log "步骤 3/4：安装 $TGZ_NAME"

cd "$SCRIPT_DIR"
openclaw plugins install "$TGZ_NAME"

# ---------------------------------------------------------------------------
# 4. 重启 openclaw-gateway
# ---------------------------------------------------------------------------
log "步骤 4/4：Gateway即将重启，正在重启 openclaw-gateway"
python3 -m supervisor.supervisorctl restart openclaw-gateway

log "全部完成 ✅"
log "如需回滚："
log "  配置：cp $BACKUP_DIR/openclaw.json.bak $CONFIG_FILE"
log "  目录：cp -a $BACKUP_DIR/xiaoyi-channel-ext.bak $PLUGIN_DIR"
