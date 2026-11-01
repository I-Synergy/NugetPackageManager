import * as fs from "node:fs/promises";
import * as fsSync from "node:fs";
import * as path from "node:path";
import { createHash } from "node:crypto";
import { Logger } from "@/common/logger";

type CacheFile = {
    url: string;
    timestamp: number;
    data: unknown;
};

const DEFAULT_TTL_MS = 30 * 60 * 1000;
const MAX_ENTRIES = 1000;

/**
 * Small on-disk cache for NuGet HTTP GET responses.
 *
 * It lives under the extension's global storage and survives window reloads, so
 * the first Updates scan after a restart does not re-fetch every registration
 * page. Responses are keyed by URL + query parameters and expire after a TTL.
 * Cached data is always served best-effort: any I/O problem falls back to the
 * network.
 */
export class HttpCache {
    constructor(
        private readonly directory: string | null,
        private readonly ttlMs: number = DEFAULT_TTL_MS,
        private readonly now: () => number = () => Date.now()
    ) {}

    private fileFor(key: string): string | null {
        if (!this.directory) return null;
        const hash = createHash("sha256").update(key).digest("hex");
        return path.join(this.directory, `${hash}.json`);
    }

    async GetAsync<T>(key: string): Promise<T | null> {
        const file = this.fileFor(key);
        if (!file) return null;
        try {
            const raw = JSON.parse(await fs.readFile(file, "utf8")) as CacheFile;
            if (!raw || typeof raw.timestamp !== "number") return null;
            if (this.now() - raw.timestamp > this.ttlMs) return null;
            return raw.data as T;
        } catch (err) {
            if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
                Logger.debug(`HttpCache: could not read ${file}`, err);
            }
            return null;
        }
    }

    async SetAsync(key: string, data: unknown): Promise<void> {
        const file = this.fileFor(key);
        if (!file || !this.directory) return;
        try {
            await fs.mkdir(this.directory, { recursive: true });
            const entry: CacheFile = { url: key, timestamp: this.now(), data };
            await fs.writeFile(file, JSON.stringify(entry), "utf8");
            await this.pruneIfNeededAsync();
        } catch (err) {
            Logger.debug(`HttpCache: could not write ${file}`, err);
        }
    }

    /** Synchronous because it is called from the existing sync factory clear path. */
    Clear(): void {
        if (!this.directory) return;
        try {
            fsSync.rmSync(this.directory, { recursive: true, force: true });
        } catch (err) {
            Logger.debug(`HttpCache: could not clear ${this.directory}`, err);
        }
    }

    private async pruneIfNeededAsync(): Promise<void> {
        if (!this.directory) return;
        try {
            const names = await fs.readdir(this.directory);
            if (names.length <= MAX_ENTRIES) return;

            const stats = await Promise.all(names.map(async (name) => {
                const file = path.join(this.directory!, name);
                try {
                    const stat = await fs.stat(file);
                    return { file, mtimeMs: stat.mtimeMs };
                } catch {
                    return null;
                }
            }));

            const sorted = stats
                .filter((entry): entry is { file: string; mtimeMs: number } => entry !== null)
                .sort((a, b) => a.mtimeMs - b.mtimeMs);
            const removeCount = sorted.length - Math.floor(MAX_ENTRIES * 0.75);
            await Promise.all(sorted.slice(0, removeCount).map((entry) => fs.rm(entry.file, { force: true })));
            Logger.debug(`HttpCache: pruned ${removeCount} old entries`);
        } catch (err) {
            Logger.debug("HttpCache: prune failed", err);
        }
    }
}
