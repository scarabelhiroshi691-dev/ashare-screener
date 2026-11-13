import path from "node:path";
import { fileURLToPath } from "node:url";

export const root = path.resolve(
  fileURLToPath(new URL("../", import.meta.url)),
);
export const portable = process.env.SCREENER_PORTABLE === "1";
export const dataDir = path.join(root, ".data");
export const backupRoot = portable
  ? path.join(root, ".local", "backups")
  : "F:/codex/Backups/ashare-screener";
export const archiveRoot = portable
  ? path.join(root, ".local", "archives")
  : "F:/codex/Archives/ashare-screener";
export const reviewDir = portable
  ? path.join(dataDir, "review")
  : path.join(root, "reports/ten-day-review-2026-10-30");
