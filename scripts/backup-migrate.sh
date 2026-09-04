#!/usr/bin/env bash
# =============================================================================
# backup-migrate.sh — Bangumi Blog 一键迁移打包脚本
# -----------------------------------------------------------------------------
# 用途：服务器到期 / 换机前，把「必须迁移」的最小数据集打成 tar.gz：
#   · backend/.env                      SMTP / Bangumi OAuth / 代理等配置（600 权限）
#   · backend/data/bangumi-blog.db      SQLite 主库（VACUUM INTO 一致性快照，
#                                        服务运行中执行也安全，不依赖 -wal/-shm）
#   · backend/data/vapid.json           Web Push 密钥
#   · backend/uploads/                  （若存在）用户上传文件
#   · backend/news-img/                 （若存在）公告/资讯图片
# 自动排除：img-cache（可重新生成）、node_modules、frontend/dist、logs、*.bak*
#
# 用法：
#   bash scripts/backup-migrate.sh [输出目录]
#   默认输出：/www/backup/bangumi-blog/migrate-<时间戳>.tar.gz
#   输出目录不可写时自动回退到仓库根目录。
#
# 恢复（新服务器，已 git clone 到 /www/wwwroot/bangumi-blog）：
#   cd /www/wwwroot/bangumi-blog && tar xzf migrate-<时间戳>.tar.gz && chmod 600 backend/.env
# 完整迁移步骤见 docs/migration.md
# =============================================================================
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
BACKEND="$ROOT/backend"
STAMP="$(date +%Y%m%d-%H%M%S)"
STAGE="$(mktemp -d)"
trap 'rm -rf "$STAGE"' EXIT

echo "==> 仓库根目录: $ROOT"

# ---------- 1. 校验关键文件 ----------
echo "==> [1/4] 校验关键文件"
for f in .env data/bangumi-blog.db data/vapid.json; do
  if [ ! -e "$BACKEND/$f" ]; then
    echo "错误: 缺少 $BACKEND/$f"
    echo "请确认脚本位于仓库根目录的 scripts/ 下，且 backend/ 是真实部署目录。"
    exit 1
  fi
done

# ---------- 2. 确定输出目录 ----------
OUT_DIR="${1:-/www/backup/bangumi-blog}"
if ! mkdir -p "$OUT_DIR" 2>/dev/null; then
  OUT_DIR="$ROOT"
fi
ARCHIVE="$OUT_DIR/migrate-$STAMP.tar.gz"
echo "==> 归档将输出到: $ARCHIVE"

# ---------- 3. SQLite 一致性快照 ----------
echo "==> [2/4] 生成 SQLite 一致性快照（VACUUM INTO）"
DB_SNAP="$STAGE/backend/data/bangumi-blog.db"
mkdir -p "$(dirname "$DB_SNAP")"
if command -v node >/dev/null 2>&1; then
  cat > "$STAGE/snap.js" <<'JS'
const { DatabaseSync } = require('node:sqlite');
const [,, src, dest] = process.argv;
const db = new DatabaseSync(src, { readOnly: true });
db.exec("VACUUM INTO '" + dest.replace(/'/g, "''") + "'");
db.close();
JS
  if node --experimental-sqlite --disable-warning=ExperimentalWarning \
      "$STAGE/snap.js" "$BACKEND/data/bangumi-blog.db" "$DB_SNAP" >/dev/null 2>&1; then
    echo "    一致性快照成功（服务运行中执行也安全）"
  else
    echo "    快照失败，回退为直接复制（建议先 systemctl stop bangumi-blog）"
    cp -f "$BACKEND/data/bangumi-blog.db" "$DB_SNAP"
  fi
else
  echo "    未找到 node，回退为直接复制（建议先 systemctl stop bangumi-blog）"
  cp -f "$BACKEND/data/bangumi-blog.db" "$DB_SNAP"
fi

# ---------- 4. 组装并打包 ----------
echo "==> [3/4] 组装归档内容"
cp -a "$BACKEND/.env" "$STAGE/backend/.env"
cp -a "$BACKEND/data/vapid.json" "$STAGE/backend/data/vapid.json"
TAR_LIST="backend/.env backend/data/bangumi-blog.db backend/data/vapid.json"
for d in uploads news-img; do
  if [ -d "$BACKEND/$d" ]; then
    cp -a "$BACKEND/$d" "$STAGE/backend/$d"
    TAR_LIST="$TAR_LIST backend/$d"
  else
    echo "    跳过不存在的目录: backend/$d"
  fi
done

echo "==> [4/4] 打包"
tar -C "$STAGE" -czf "$ARCHIVE" $TAR_LIST
echo "==> 校验归档内容"
tar -tzf "$ARCHIVE" | sed 's/^/    /'
echo "==> 完成:"
ls -lh "$ARCHIVE"
sha256sum "$ARCHIVE" 2>/dev/null || true

cat <<EOF

迁移包已生成：$ARCHIVE
传到新服务器后执行：
  cd /www/wwwroot/bangumi-blog && tar xzf $(basename "$ARCHIVE") && chmod 600 backend/.env
完整迁移步骤见 docs/migration.md
EOF