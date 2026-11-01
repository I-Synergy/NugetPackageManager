import * as assert from 'assert';
import * as sinon from 'sinon';
import { JobRegistry, OperationJobs } from '@/host/utilities/operation-jobs';
import { Logger } from '@/common/logger';
import { ok, fail } from '@/common/rpc/result';
import type { BatchUpdateResponse, CleanupUnusedResponse } from '@/common/rpc/types';

suite('OperationJobs', () => {
    let sandbox: sinon.SinonSandbox;

    setup(() => {
        sandbox = sinon.createSandbox();
        sandbox.stub(Logger, 'info');
        sandbox.stub(Logger, 'debug');
        sandbox.stub(Logger, 'warn');
        sandbox.stub(Logger, 'error');
        OperationJobs.Reset();
    });

    teardown(() => {
        OperationJobs.Reset();
        sandbox.restore();
    });

    const response: BatchUpdateResponse = {
        Results: [{ PackageId: 'Pkg.Shared', Success: true }],
    };

    function cleanupResponse(removed: string[] = []): CleanupUnusedResponse {
        return {
            Report: { PropsFiles: [], Used: [], Missing: [], Unused: [] },
            Removed: removed,
            Backups: [],
            Errors: [],
        };
    }

    function blockingRunner(): { wait: Promise<void>; open: () => void } {
        let open!: () => void;
        const wait = new Promise<void>((resolve) => { open = resolve; });
        return { wait, open };
    }

    test('reports running progress and keeps the terminal response', async () => {
        const gate = blockingRunner();

        OperationJobs.Batch.Start('job-1', async (_signal, report) => {
            report('Updating packages…', 40);
            await gate.wait;
            return ok(response);
        });

        const running = OperationJobs.Get('job-1');
        assert.ok(running);
        assert.strictEqual(running.Kind, 'batchUpdate');
        assert.strictEqual(running.State, 'running');
        assert.strictEqual(running.Stage, 'Updating packages…');
        assert.strictEqual(running.Percent, 40);

        gate.open();
        await OperationJobs.Batch.WaitAsync('job-1');

        const finished = OperationJobs.Get('job-1');
        assert.strictEqual(finished?.State, 'completed');
        assert.strictEqual(finished?.Percent, 100);
        assert.deepStrictEqual(
            finished?.Kind === 'batchUpdate' ? finished.Response : undefined,
            response
        );
    });

    test('cancel aborts the runner signal and marks the job cancelled', async () => {
        let observedAbort = false;
        const gate = blockingRunner();

        OperationJobs.Project.Start('job-2', async (signal) => {
            signal.addEventListener('abort', () => {
                observedAbort = true;
                gate.open();
            }, { once: true });
            await gate.wait;
            return fail('Failed to update package: cancelled (rolled back)');
        });

        assert.strictEqual(OperationJobs.Cancel('job-2'), true);
        await OperationJobs.Project.WaitAsync('job-2');

        assert.strictEqual(observedAbort, true);
        const finished = OperationJobs.Get('job-2');
        assert.strictEqual(finished?.Kind, 'projectUpdate');
        assert.strictEqual(finished?.State, 'cancelled', 'explicit cancel wins over the abort failure');
        assert.match(finished?.Error ?? '', /rolled back/);
    });

    test('cancel returns false for an unknown or finished job', async () => {
        assert.strictEqual(OperationJobs.Cancel('missing'), false);

        OperationJobs.Cleanup.Start('job-3', async () => ok(cleanupResponse()));
        await OperationJobs.Cleanup.WaitAsync('job-3');

        assert.strictEqual(OperationJobs.Cancel('job-3'), false);
    });

    test('surfaces a failed runner result as a failed job', async () => {
        OperationJobs.Consolidate.Start('job-4', async () => fail('Project path is outside the workspace'));
        await OperationJobs.Consolidate.WaitAsync('job-4');

        const finished = OperationJobs.Get('job-4');
        assert.strictEqual(finished?.Kind, 'consolidate');
        assert.strictEqual(finished?.State, 'failed');
        assert.strictEqual(finished?.Error, 'Project path is outside the workspace');
    });

    test('surfaces a thrown error as a failed job', async () => {
        OperationJobs.Batch.Start('job-5', async () => {
            throw new Error('boom');
        });
        await OperationJobs.Batch.WaitAsync('job-5');

        const finished = OperationJobs.Get('job-5');
        assert.strictEqual(finished?.State, 'failed');
        assert.strictEqual(finished?.Error, 'boom');
    });

    test('tracks jobs per kind and finds them across registries', async () => {
        const batchGate = blockingRunner();
        OperationJobs.Batch.Start('job-6', async () => {
            await batchGate.wait;
            return ok(response);
        });
        OperationJobs.Cleanup.Start('job-7', async () =>
            ok(cleanupResponse(['Pkg.Shared'])));

        assert.strictEqual(OperationJobs.Batch.HasRunning(), true);
        assert.strictEqual(OperationJobs.Get('job-7')?.Kind, 'cleanup');
        assert.strictEqual(OperationJobs.Get('job-6')?.Kind, 'batchUpdate');

        batchGate.open();
        await OperationJobs.Batch.WaitAsync('job-6');
        await OperationJobs.Cleanup.WaitAsync('job-7');

        assert.strictEqual(OperationJobs.Batch.HasRunning(), false);
    });

    test('returns null for an unknown job', () => {
        assert.strictEqual(OperationJobs.Get('nope'), null);
    });

    test('clamps reported percentages and ignores reports after completion', async () => {
        const registry = new JobRegistry<number>('cleanup');
        const gate = blockingRunner();

        registry.Start('job-8', async (_signal, report) => {
            report('Working', 140);
            await gate.wait;
            return ok(1);
        });

        assert.strictEqual(registry.Get('job-8')?.Percent, 100);

        gate.open();
        await registry.WaitAsync('job-8');

        registry.Report('job-8', 'Done', 10);
        assert.strictEqual(registry.Get('job-8')?.Stage, 'Completed');
        registry.Reset();
    });
});
