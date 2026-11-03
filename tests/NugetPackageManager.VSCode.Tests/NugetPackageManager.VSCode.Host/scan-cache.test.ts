import * as assert from 'assert';
import type * as vscode from 'vscode';
import {
    BuildScanCacheKey,
    CurrentScanCacheEpoch,
    InvalidateScanCache,
    SCAN_CACHE_SCHEMA_VERSION,
    ScanCacheStore,
    type ScanCacheSaveEntry,
} from '@/host/scan-cache';

function makeMemento(): vscode.Memento & { value: unknown } {
    const memento = {
        value: undefined as unknown,
        get<T>(_key: string, defaultValue?: T): T | undefined {
            return (memento.value as T | undefined) ?? defaultValue;
        },
        update: async (_key: string, value: unknown) => {
            memento.value = value;
        },
        keys: () => [],
        setKeysForSync: () => undefined,
    };
    return memento as unknown as vscode.Memento & { value: unknown };
}

let memento: ReturnType<typeof makeMemento>;

suite('scan-cache', () => {
    setup(() => {
        memento = makeMemento();
    });

    // The epoch is module-level state, so every test starts from a known one.
    teardown(() => {
        InvalidateScanCache();
    });

    const parts = {
        workspaceRoots: ['D:\\ws'],
        projectPaths: ['D:\\ws\\B.csproj', 'D:\\ws\\A.csproj'],
        sourceUrls: ['https://api.nuget.org/v3/index.json'],
        prerelease: false,
        excludeGlobs: ['**/bin/**'],
    };

    test('keys are stable and order-independent', () => {
        const a = BuildScanCacheKey(parts);
        const b = BuildScanCacheKey({
            ...parts,
            projectPaths: [...parts.projectPaths].reverse(),
            workspaceRoots: parts.workspaceRoots.map((root) => root.toUpperCase()),
        });
        assert.strictEqual(a, b);
        assert.match(a, /^scan:[0-9a-f]{8}$/);
    });

    test('keys change with filters and sources', () => {
        assert.notStrictEqual(BuildScanCacheKey(parts), BuildScanCacheKey({ ...parts, prerelease: true }));
        assert.notStrictEqual(
            BuildScanCacheKey(parts),
            BuildScanCacheKey({ ...parts, sourceUrls: ['https://other.example/v3/index.json'] })
        );
    });

    test('stores and reloads a payload for the same key', async () => {
        const store = new ScanCacheStore(memento);
        const entry: ScanCacheSaveEntry = {
            Key: BuildScanCacheKey(parts),
            ScannedAt: '2026-10-26T12:00:00.000Z',
            Packages: [{
                Id: 'Pkg.Shared',
                InstalledVersion: '1.0.0',
                LatestVersion: '2.0.0',
                Projects: [{ Name: 'A', Path: 'D:\\ws\\A.csproj', Version: '1.0.0' }],
                SourceUrl: 'https://api.nuget.org/v3/index.json',
                SourceName: 'nuget.org',
            }],
            BlockedPackages: [],
        };
        await store.SaveAsync(entry);

        const loaded = await new ScanCacheStore(memento).LoadAsync(entry.Key);
        assert.ok(loaded);
        assert.strictEqual(loaded!.SchemaVersion, SCAN_CACHE_SCHEMA_VERSION);
        assert.strictEqual(loaded!.Packages[0]!.Id, 'Pkg.Shared');
        assert.strictEqual(loaded!.ScannedAt, entry.ScannedAt);
    });

    test('ignores entries for another key or schema', async () => {
        const store = new ScanCacheStore(memento);
        await store.SaveAsync({
            Key: BuildScanCacheKey(parts),
            ScannedAt: '2026-10-26T12:00:00.000Z',
            Packages: [],
            BlockedPackages: [],
        });

        assert.strictEqual(await store.LoadAsync('scan:00000000'), null);

        memento.value = { ...(memento.value as object), SchemaVersion: SCAN_CACHE_SCHEMA_VERSION + 1 };
        assert.strictEqual(await store.LoadAsync(BuildScanCacheKey(parts)), null);
    });

    test('does nothing without a memento', async () => {
        const store = new ScanCacheStore();
        assert.strictEqual(await store.LoadAsync('scan:12345678'), null);
        await store.SaveAsync({
            Key: 'scan:12345678',
            ScannedAt: '2026-10-26T12:00:00.000Z',
            Packages: [],
            BlockedPackages: [],
        });
    });

    test('refuses an entry written under another epoch', async () => {
        const store = new ScanCacheStore(memento);
        const entry: ScanCacheSaveEntry = {
            Key: BuildScanCacheKey(parts),
            ScannedAt: '2026-10-26T12:00:00.000Z',
            Packages: [],
            BlockedPackages: [],
        };
        // Simulates an entry persisted by a build that ran before a mutation.
        await store.SaveAsync(entry, CurrentScanCacheEpoch() + 1);

        assert.strictEqual(await store.LoadAsync(entry.Key), null);
    });

    test('InvalidateScanCache makes the previous save unreadable', async () => {
        const store = new ScanCacheStore(memento);
        const entry: ScanCacheSaveEntry = {
            Key: BuildScanCacheKey(parts),
            ScannedAt: '2026-10-26T12:00:00.000Z',
            Packages: [],
            BlockedPackages: [],
        };
        await store.SaveAsync(entry);
        assert.ok(await store.LoadAsync(entry.Key), 'the entry is readable before the mutation');

        InvalidateScanCache();

        assert.strictEqual(await store.LoadAsync(entry.Key), null);
        // The same key can be repopulated: the epoch only refuses older entries.
        await store.SaveAsync(entry);
        assert.ok(await store.LoadAsync(entry.Key));
    });

    test('a save stamped with a stale epoch is never served', async () => {
        const store = new ScanCacheStore(memento);
        const entry: ScanCacheSaveEntry = {
            Key: BuildScanCacheKey(parts),
            ScannedAt: '2026-10-26T12:00:00.000Z',
            Packages: [],
            BlockedPackages: [],
        };
        // A scan captured the epoch, then an update landed while it was still running.
        const scanEpoch = CurrentScanCacheEpoch();
        InvalidateScanCache();
        await store.SaveAsync(entry, scanEpoch);

        assert.strictEqual(await store.LoadAsync(entry.Key), null);
        const stamp = memento.value as { Epoch?: number };
        assert.strictEqual(stamp.Epoch, scanEpoch, 'the entry records the epoch the scan started with');
    });
});
