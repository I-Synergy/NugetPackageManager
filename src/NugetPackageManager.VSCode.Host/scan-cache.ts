import type * as vscode from "vscode";
import type { GetOutdatedPackagesResponse } from "@/common/rpc/types";

const STORAGE_KEY = "nugetpackagemanager.lastScan";
const SCHEMA_VERSION = 2;

/**
 * Bumped whenever a package version changes.
 *
 * A persisted scan describes the workspace as it was when the scan started, so after an update it
 * is worse than useless: a non-forced read would repaint the pre-update list. Every entry carries
 * the epoch it was written under and is refused once that epoch is no longer current.
 */
let scanCacheEpoch = 0;

/** A package version changed: every scan persisted before now is stale. */
export function InvalidateScanCache(): void {
    scanCacheEpoch += 1;
}

/** The epoch a scan starting now must stamp on what it saves. */
export function CurrentScanCacheEpoch(): number {
    return scanCacheEpoch;
}

export type ScanCachePayload = {
    Packages: OutdatedPackage[];
    BlockedPackages: NonNullable<GetOutdatedPackagesResponse["BlockedPackages"]>;
};

export type ScanCacheEntry = ScanCachePayload & {
    SchemaVersion: number;
    /** The `CurrentScanCacheEpoch()` the scan started under. */
    Epoch: number;
    Key: string;
    ScannedAt: string;
};

/** What a scan hands to `SaveAsync`: the store adds the schema version and the epoch. */
export type ScanCacheSaveEntry = Omit<ScanCacheEntry, "SchemaVersion" | "Epoch">;

export type ScanCacheKeyParts = {
    workspaceRoots: string[];
    projectPaths: string[];
    sourceUrls: string[];
    prerelease: boolean;
    excludeGlobs: string[];
};

/** Locale-fixed comparator: cache keys must be identical on every machine. */
function compareStrings(a: string, b: string): number {
    return a.localeCompare(b, "en");
}

/** FNV-1a; keeps the persisted key short and stable. */
function hashKey(value: string): string {
    let hash = 0x811c9dc5;
    for (const char of value) {
        hash ^= char.codePointAt(0)!;
        hash = Math.imul(hash, 0x01000193);
    }
    return (hash >>> 0).toString(16).padStart(8, "0");
}

export function BuildScanCacheKey(parts: ScanCacheKeyParts): string {
    const normalized = JSON.stringify({
        workspaceRoots: [...parts.workspaceRoots].map((root) => root.toLowerCase()).sort(compareStrings),
        projectPaths: [...parts.projectPaths].map((project) => project.toLowerCase()).sort(compareStrings),
        sourceUrls: [...parts.sourceUrls].map((url) => url.toLowerCase()).sort(compareStrings),
        prerelease: parts.prerelease,
        excludeGlobs: [...parts.excludeGlobs].sort(compareStrings),
    });
    return `scan:${hashKey(normalized)}`;
}

/**
 * Persists the last Updates scan in `workspaceState` so the tab can paint
 * immediately on activation/window reload while a live scan refreshes.
 *
 * `memento` is optional: host tests and headless callers run without a cache.
 */
export class ScanCacheStore {
    constructor(private readonly memento?: vscode.Memento) {}

    LoadAsync(key: string): Promise<ScanCacheEntry | null> {
        if (!this.memento) return Promise.resolve(null);
        const entry = this.memento.get<ScanCacheEntry>(STORAGE_KEY);
        if (!entry) return Promise.resolve(null);
        if (entry.SchemaVersion !== SCHEMA_VERSION || entry.Key !== key) return Promise.resolve(null);
        // A scan taken before the mutation that bumped the epoch must not answer a read after it.
        if (entry.Epoch !== scanCacheEpoch) return Promise.resolve(null);
        if (!Array.isArray(entry.Packages)) return Promise.resolve(null);
        return Promise.resolve(entry);
    }

    /**
     * Stores a scan result under the epoch the scan started with.
     *
     * The default is the current epoch. A caller that captured an older one - a scan that began
     * before a mutation - therefore writes an entry the next read refuses: the update happens while
     * the scan is in flight, and its pre-update result must not become readable again.
     */
    async SaveAsync(entry: ScanCacheSaveEntry, epoch: number = CurrentScanCacheEpoch()): Promise<void> {
        if (!this.memento) return;
        await this.memento.update(STORAGE_KEY, { ...entry, Epoch: epoch, SchemaVersion: SCHEMA_VERSION });
    }

    async ClearAsync(): Promise<void> {
        if (!this.memento) return;
        await this.memento.update(STORAGE_KEY, undefined);
    }
}

export const SCAN_CACHE_SCHEMA_VERSION = SCHEMA_VERSION;
