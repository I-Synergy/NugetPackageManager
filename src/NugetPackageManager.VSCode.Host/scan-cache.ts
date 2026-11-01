import type * as vscode from "vscode";
import type { GetOutdatedPackagesResponse } from "@/common/rpc/types";

const STORAGE_KEY = "nugetpackagemanager.lastScan";
const SCHEMA_VERSION = 1;

export type ScanCachePayload = {
    Packages: OutdatedPackage[];
    BlockedPackages: NonNullable<GetOutdatedPackagesResponse["BlockedPackages"]>;
};

export type ScanCacheEntry = ScanCachePayload & {
    SchemaVersion: number;
    Key: string;
    ScannedAt: string;
};

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
        if (!Array.isArray(entry.Packages)) return Promise.resolve(null);
        return Promise.resolve(entry);
    }

    async SaveAsync(entry: Omit<ScanCacheEntry, "SchemaVersion">): Promise<void> {
        if (!this.memento) return;
        await this.memento.update(STORAGE_KEY, { SchemaVersion: SCHEMA_VERSION, ...entry });
    }

    async ClearAsync(): Promise<void> {
        if (!this.memento) return;
        await this.memento.update(STORAGE_KEY, undefined);
    }
}

export const SCAN_CACHE_SCHEMA_VERSION = SCHEMA_VERSION;
