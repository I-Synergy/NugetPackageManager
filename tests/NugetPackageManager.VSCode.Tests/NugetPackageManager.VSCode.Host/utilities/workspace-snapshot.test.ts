import * as assert from 'assert';
import * as sinon from 'sinon';
import * as vscode from 'vscode';
import {
    WorkspaceSnapshotCache,
    isIgnoredWatchPath,
    type ParseBatchResult,
} from '@/host/utilities/workspace-snapshot';


function projectFor(fsPath: string): Project {
    return {
        Name: fsPath,
        Path: fsPath,
        Packages: [],
        CpmEnabled: false,
    };
}

/** A latch a parse can wait on, so a test can decide when the shared parse finishes. */
function createGate(): { promise: Promise<void>; open: () => void } {
    let open!: () => void;
    const promise = new Promise<void>((resolve) => {
        open = resolve;
    });
    return { promise, open };
}

/** Lets every pending microtask and the discovery promise settle. */
function tick(): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, 0));
}

/**
 * A parse that counts its invocations and only answers once the gate opens, so a test can observe
 * how many parses were started while the first one is still in flight.
 */
function gatedParse(
    gate: { promise: Promise<void> },
    parses: { count: number }
): (paths: string[]) => Promise<ParseBatchResult> {
    return async (paths: string[]): Promise<ParseBatchResult> => {
        parses.count += 1;
        await gate.promise;
        return { projects: paths.map(projectFor), failedPaths: [] };
    };
}

suite('workspace-snapshot', () => {
    let sandbox: sinon.SinonSandbox;
    let cache: WorkspaceSnapshotCache;

    setup(() => {
        sandbox = sinon.createSandbox();
        // Never create a real file-system watcher from these tests.
        sandbox.stub(vscode.workspace, 'createFileSystemWatcher').returns({
            onDidChange: () => ({ dispose: () => undefined }),
            onDidCreate: () => ({ dispose: () => undefined }),
            onDidDelete: () => ({ dispose: () => undefined }),
            dispose: () => undefined,
        } as unknown as vscode.FileSystemWatcher);
        cache = new WorkspaceSnapshotCache();
    });

    teardown(() => {
        cache.Reset();
        sandbox.restore();
    });

    test('parses the workspace once for concurrent callers', async () => {
        const gate = createGate();
        const parses = { count: 0 };
        let discoverCount = 0;

        const discover = async (): Promise<string[]> => {
            discoverCount += 1;
            return ['/ws/A.csproj', '/ws/B.csproj'];
        };
        const parse = gatedParse(gate, parses);

        const first = cache.GetAsync({ discover, parse });
        const second = cache.GetAsync({ discover, parse });
        gate.open();

        const [firstSnapshot, secondSnapshot] = await Promise.all([first, second]);

        assert.strictEqual(discoverCount, 1);
        assert.strictEqual(parses.count, 1);
        assert.deepStrictEqual(firstSnapshot.projects.map((project) => project.Path), [
            '/ws/A.csproj',
            '/ws/B.csproj',
        ]);
        assert.strictEqual(secondSnapshot, firstSnapshot);

        // The cached snapshot answers the next call without touching discovery or the core.
        const third = await cache.GetAsync({ discover, parse });
        assert.strictEqual(third, firstSnapshot);
        assert.strictEqual(discoverCount, 1);
        assert.strictEqual(parses.count, 1);
    });

    test('forceReload starts a new generation', async () => {
        let discoverCount = 0;
        const discover = async (): Promise<string[]> => {
            discoverCount += 1;
            return ['/ws/A.csproj'];
        };
        const parse = async (paths: string[]): Promise<ParseBatchResult> => ({
            projects: paths.map(projectFor),
            failedPaths: [],
        });

        await cache.GetAsync({ discover, parse });
        const reloaded = await cache.GetAsync({ discover, parse, forceReload: true });

        assert.strictEqual(discoverCount, 2);
        assert.strictEqual(reloaded.projectFiles.length, 1);
    });

    test('invalidate drops the snapshot so the next caller re-parses', async () => {
        let discoverCount = 0;
        const discover = async (): Promise<string[]> => {
            discoverCount += 1;
            return [`/ws/${discoverCount}.csproj`];
        };
        const parse = async (paths: string[]): Promise<ParseBatchResult> => ({
            projects: paths.map(projectFor),
            failedPaths: [],
        });

        const before = await cache.GetAsync({ discover, parse });
        cache.invalidate();
        const after = await cache.GetAsync({ discover, parse });

        assert.notStrictEqual(after, before);
        assert.deepStrictEqual(after.projectFiles, ['/ws/2.csproj']);
    });

    test('a caller abort detaches only that caller and the parse still fills the cache', async () => {
        const gate = createGate();
        const parses = { count: 0 };
        const discover = async (): Promise<string[]> => ['/ws/A.csproj'];
        const parse = gatedParse(gate, parses);

        const controller = new AbortController();
        const detached = cache.GetAsync({ discover, parse, signal: controller.signal });
        const attached = cache.GetAsync({ discover, parse });

        controller.abort(new Error('the tab was closed'));
        await assert.rejects(detached, /the tab was closed/);

        gate.open();
        const snapshot = await attached;
        assert.strictEqual(snapshot.projects.length, 1);
        assert.strictEqual(parses.count, 1);

        // The shared parse completed for the caller that stayed, and its result is cached.
        const reused = await cache.GetAsync({ discover, parse });
        assert.strictEqual(reused, snapshot);
    });

    test('surfaces the project files the core could not parse', async () => {
        const snapshot = await cache.GetAsync({
            discover: async () => ['/ws/A.csproj', '/ws/B.csproj'],
            parse: async () => ({
                projects: [projectFor('/ws/A.csproj')],
                failedPaths: ['/ws/B.csproj'],
            }),
        });

        assert.deepStrictEqual(snapshot.projectFiles, ['/ws/A.csproj', '/ws/B.csproj']);
        assert.deepStrictEqual(snapshot.failedPaths, ['/ws/B.csproj']);
        assert.deepStrictEqual(snapshot.projects.map((project) => project.Path), ['/ws/A.csproj']);
    });

    test('forwards parse progress to every caller, including a late one', async () => {
        const gate = createGate();
        const progress: Array<[number, number]> = [];
        const lateProgress: Array<[number, number]> = [];

        const discover = async (): Promise<string[]> => ['/ws/A.csproj', '/ws/B.csproj'];
        const parse = async (
            paths: string[],
            _signal?: AbortSignal,
            onProgress?: (completed: number, total: number) => void
        ): Promise<ParseBatchResult> => {
            onProgress?.(1, 2);
            await gate.promise;
            onProgress?.(2, 2);
            return { projects: paths.map(projectFor), failedPaths: [] };
        };

        const first = cache.GetAsync({
            discover,
            parse,
            onProgress: (completed, total) => progress.push([completed, total]),
        });
        // The first chunk's progress arrives once discovery has settled.
        await tick();
        assert.deepStrictEqual(progress, [[1, 2]]);

        const late = cache.GetAsync({
            discover,
            parse,
            onProgress: (completed, total) => lateProgress.push([completed, total]),
        });
        // A late caller is seeded with the progress the parse already reached.
        assert.deepStrictEqual(lateProgress, [[1, 2]]);

        gate.open();
        await Promise.all([first, late]);

        assert.deepStrictEqual(progress, [[1, 2], [2, 2]]);
        assert.deepStrictEqual(lateProgress, [[1, 2], [2, 2]]);
    });

    test('rejects every caller when the shared parse fails and does not cache the failure', async () => {        const parse = async (): Promise<ParseBatchResult> => {
            throw new Error('the core exploded');
        };
        const discover = async (): Promise<string[]> => ['/ws/A.csproj'];

        await assert.rejects(cache.GetAsync({ discover, parse }), /the core exploded/);

        const recovered = await cache.GetAsync({
            discover,
            parse: async () => ({ projects: [projectFor('/ws/A.csproj')], failedPaths: [] }),
        });
        assert.strictEqual(recovered.projects.length, 1);
    });

    test('knownProjectFiles is null before any discovery', () => {
        // Nothing was discovered yet, and asking must not start a parse or a discovery.
        assert.strictEqual(cache.knownProjectFiles(), null);
    });

    test('knownProjectFiles answers from the in-flight discovery while the parse is still running', async () => {
        const gate = createGate();
        const parses = { count: 0 };
        const discover = async (): Promise<string[]> => ['/ws/A.csproj', '/ws/B.csproj'];
        const parse = gatedParse(gate, parses);

        const pending = cache.GetAsync({ discover, parse });
        // Discovery has settled; the parse is blocked on the gate.
        await tick();

        assert.deepStrictEqual(cache.knownProjectFiles(), ['/ws/A.csproj', '/ws/B.csproj']);
        assert.strictEqual(parses.count, 1, 'reading the known files must not start another parse');

        gate.open();
        const snapshot = await pending;

        // The cached snapshot answers afterwards.
        assert.deepStrictEqual(cache.knownProjectFiles(), snapshot.projectFiles);
    });

    test('ignores build-output and VCS paths when deciding whether to invalidate', () => {
        // `dotnet restore` rewrites these for every project, so they must not drop the snapshot.
        for (const ignored of [
            '/ws/src/App/obj/App.nuget.g.props',
            '/ws/src/App/obj/App.nuget.g.targets',
            '/ws/src/App/bin/Debug/net8.0/App.deps.json',
            '/ws/node_modules/pkg/index.props',
            '/ws/.git/config.props',
            'C:\\ws\\src\\App\\obj\\App.nuget.g.props',
            'C:\\ws\\node_modules\\pkg\\x.targets',
            'C:\\ws\\.git\\config',
            '/ws/src/App/OBJ/App.nuget.g.props',
            '/ws/src/App/Bin/Debug/x.props',
            'C:\\ws\\Node_Modules\\pkg\\x.props',
            'C:\\WS\\.GIT\\config',
        ]) {
            assert.ok(isIgnoredWatchPath(ignored), `${ignored} should be ignored`);
        }

        // Segment matching, not substring: a directory merely containing "obj" stays watched.
        for (const watched of [
            '/ws/src/App/App.csproj',
            '/ws/Directory.Build.props',
            '/ws/Directory.Build.targets',
            '/ws/combine/App.csproj',
            '/ws/object-model/App.props',
            'C:\\ws\\src\\App\\App.csproj',
            'C:\\ws\\objects\\App.targets',
        ]) {
            assert.ok(!isIgnoredWatchPath(watched), `${watched} should not be ignored`);
        }

        // A real project file is not ignored, so its change still reaches the 300 ms debounce.
        assert.strictEqual(isIgnoredWatchPath('/ws/src/App/App.csproj'), false);
    });
});
