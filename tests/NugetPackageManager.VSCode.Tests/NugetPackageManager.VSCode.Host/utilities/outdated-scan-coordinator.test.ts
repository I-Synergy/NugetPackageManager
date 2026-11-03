import * as assert from 'assert';
import * as sinon from 'sinon';
import type { GetOutdatedPackagesResponse } from '@/common/rpc/types';
import { ScanProgress } from '@/host/utilities/scan-progress';
import {
    OutdatedScanCoordinator,
    type OutdatedScanRun,
    type ScanReporter,
} from '@/host/utilities/outdated-scan-coordinator';

/** A latch the runner can wait on, so a test can decide when the shared run finishes. */
function createGate(): { promise: Promise<void>; open: () => void } {
    let open!: () => void;
    const promise = new Promise<void>((resolve) => {
        open = resolve;
    });
    return { promise, open };
}

/**
 * A runner that counts its invocations and only answers once the gate opens, so each test can
 * observe how many scans were started while the first one is still in flight.
 */
function gatedRunner(
    gate: { promise: Promise<void> },
    runs: { count: number }
): () => Promise<GetOutdatedPackagesResponse> {
    return async (): Promise<GetOutdatedPackagesResponse> => {
        runs.count += 1;
        await gate.promise;
        return { Packages: [] };
    };
}

function scanRun(
    key: string,
    scanIds: string[],
    run: (report: ScanReporter, signal: AbortSignal) => Promise<GetOutdatedPackagesResponse>,
    forceReload = false
): OutdatedScanRun {
    return { key, forceReload, scanIds, run };
}

suite('outdated-scan-coordinator', () => {
    let sandbox: sinon.SinonSandbox;
    let coordinator: OutdatedScanCoordinator;

    setup(() => {
        sandbox = sinon.createSandbox();
        ScanProgress.Reset();
        coordinator = new OutdatedScanCoordinator();
    });

    teardown(() => {
        coordinator.Reset();
        ScanProgress.Reset();
        sandbox.restore();
    });

    test('runs one scan for concurrent callers with the same key', async () => {
        const gate = createGate();
        const runs = { count: 0 };
        const runner = gatedRunner(gate, runs);

        const first = coordinator.RunAsync(scanRun('key-1', ['scan-a'], runner));
        const second = coordinator.RunAsync(scanRun('key-1', ['scan-b'], runner));
        const third = coordinator.RunAsync(scanRun('key-1', [], runner));
        gate.open();

        const results = await Promise.all([first, second, third]);

        assert.strictEqual(runs.count, 1);
        assert.deepStrictEqual(results, [{ Packages: [] }, { Packages: [] }, { Packages: [] }]);
    });

    test('starts a new scan when a caller forces a reload', async () => {
        const gate = createGate();
        const runs = { count: 0 };
        const runner = gatedRunner(gate, runs);

        const attached = coordinator.RunAsync(scanRun('key-1', [], runner));
        const forced = coordinator.RunAsync(scanRun('key-1', [], runner, true));
        gate.open();
        await Promise.all([attached, forced]);

        assert.strictEqual(runs.count, 2);
    });

    test('serves the memoized response inside the window without scanning again', async () => {
        const response: GetOutdatedPackagesResponse = {
            Packages: [{
                Id: 'Newtonsoft.Json',
                InstalledVersion: '1.0.0',
                LatestVersion: '2.0.0',
                Projects: [],
                SourceUrl: 'https://api.nuget.org/v3/index.json',
                SourceName: 'nuget.org',
            }],
        };
        let runCount = 0;
        const runner = async (): Promise<GetOutdatedPackagesResponse> => {
            runCount += 1;
            return response;
        };

        const first = await coordinator.RunAsync(scanRun('key-1', [], runner));
        const second = await coordinator.RunAsync(scanRun('key-1', [], runner));

        assert.strictEqual(runCount, 1);
        assert.strictEqual(first, response);
        // Returned as-is: the caller must not mutate a shared object.
        assert.strictEqual(second, response);
    });

    test('keys the memo per cache key', async () => {
        const runner = async (): Promise<GetOutdatedPackagesResponse> => ({ Packages: [] });
        await coordinator.RunAsync(scanRun('key-1', [], runner));

        let otherRuns = 0;
        const other = await coordinator.RunAsync(scanRun('key-2', [], async () => {
            otherRuns += 1;
            return { Packages: [] };
        }));

        assert.strictEqual(otherRuns, 1);
        assert.deepStrictEqual(other, { Packages: [] });
    });

    test('fans progress out to every attached scan id, including a late one', async () => {
        const gate = createGate();
        const runner = async (report: ScanReporter): Promise<GetOutdatedPackagesResponse> => {
            report('Parsing projects (1/10)…', 10, 1, 10);
            await gate.promise;
            report('Checking latest versions (5/10)…', 50, 5, 10);
            return { Packages: [] };
        };

        const early = coordinator.RunAsync(scanRun('key-1', ['scan-a'], runner));
        // The first report happens before the runner's first await, so the attached id already
        // has progress before any timer runs.
        assert.strictEqual(ScanProgress.Get('scan-a')?.Percent, 10);

        const late = coordinator.RunAsync(scanRun('key-1', ['scan-b'], runner));
        const lateSnapshot = ScanProgress.Get('scan-b');
        assert.ok(lateSnapshot, 'a late scan id must be tracked');
        assert.strictEqual(lateSnapshot!.Percent, 10);
        assert.strictEqual(lateSnapshot!.Completed, 1);

        gate.open();
        await Promise.all([early, late]);

        // Every id is cleared once the run finishes, so no spinner is left behind.
        assert.strictEqual(ScanProgress.Get('scan-a'), null);
        assert.strictEqual(ScanProgress.Get('scan-b'), null);
    });

    test('a caller abort rejects only that caller and the shared run still completes', async () => {
        const gate = createGate();
        const response: GetOutdatedPackagesResponse = { Packages: [] };
        let runCount = 0;
        const runner = async (): Promise<GetOutdatedPackagesResponse> => {
            runCount += 1;
            await gate.promise;
            return response;
        };

        const controller = new AbortController();
        const detached = coordinator.RunAsync(scanRun('key-1', ['scan-a'], runner), controller.signal);
        const attached = coordinator.RunAsync(scanRun('key-1', ['scan-b'], runner));

        controller.abort(new Error('the webview went away'));
        await assert.rejects(detached, /the webview went away/);
        assert.strictEqual(ScanProgress.Get('scan-a'), null);

        gate.open();
        const result = await attached;

        assert.strictEqual(runCount, 1);
        assert.strictEqual(result, response);
        assert.strictEqual(ScanProgress.Get('scan-b'), null);
    });

    test('Invalidate drops the memoized response', async () => {
        let runCount = 0;
        const runner = async (): Promise<GetOutdatedPackagesResponse> => {
            runCount += 1;
            return { Packages: [] };
        };

        await coordinator.RunAsync(scanRun('key-1', [], runner));
        await coordinator.RunAsync(scanRun('key-1', [], runner));
        assert.strictEqual(runCount, 1, 'the second call inside the window is served from the memo');

        coordinator.Invalidate();

        await coordinator.RunAsync(scanRun('key-1', [], runner));
        assert.strictEqual(runCount, 2, 'a mutation must force the next scan to run again');
    });

    test('a run in flight across Invalidate does not repopulate the memo', async () => {
        const gate = createGate();
        const runs = { count: 0 };
        const runner = gatedRunner(gate, runs);

        const inFlight = coordinator.RunAsync(scanRun('key-1', [], runner));
        coordinator.Invalidate();
        gate.open();

        // The caller that started the scan still receives its response.
        assert.deepStrictEqual(await inFlight, { Packages: [] });
        assert.strictEqual(runs.count, 1);

        await coordinator.RunAsync(scanRun('key-1', [], runner));
        assert.strictEqual(runs.count, 2, 'the pre-mutation result must not answer the next caller');
    });

    test('an already-aborted caller neither scans nor attaches', async () => {
        const controller = new AbortController();
        controller.abort(new Error('cancelled before start'));
        let runCount = 0;

        await assert.rejects(
            coordinator.RunAsync(scanRun('key-1', ['scan-a'], async () => {
                runCount += 1;
                return { Packages: [] };
            }), controller.signal),
            /cancelled before start/
        );

        assert.strictEqual(runCount, 0);
        assert.strictEqual(ScanProgress.Get('scan-a'), null);
    });
});
