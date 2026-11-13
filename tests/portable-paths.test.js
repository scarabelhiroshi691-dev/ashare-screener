import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import path from "node:path";
import { root } from "../server/cache.js";

test("便携模式只使用实例目录，原实例默认备份和阶段路径不迁移", () => {
  const inspect = (portable) =>
    JSON.parse(
      execFileSync(
        process.execPath,
        [
          "--input-type=module",
          "-e",
          'import * as p from "./server/paths.js"; console.log(JSON.stringify(p))',
        ],
        {
          cwd: root,
          env: { ...process.env, SCREENER_PORTABLE: portable },
          encoding: "utf8",
        },
      ),
    );
  const local = inspect("0"),
    bundled = inspect("1");
  assert.equal(local.backupRoot, "F:/codex/Backups/ashare-screener");
  assert.equal(
    local.reviewDir,
    path.join(root, "reports/ten-day-review-2026-10-30"),
  );
  assert.equal(bundled.backupRoot, path.join(root, ".local/backups"));
  assert.equal(bundled.archiveRoot, path.join(root, ".local/archives"));
  assert.equal(bundled.reviewDir, path.join(root, ".data/review"));
  assert.equal(bundled.dataDir, local.dataDir);
});
