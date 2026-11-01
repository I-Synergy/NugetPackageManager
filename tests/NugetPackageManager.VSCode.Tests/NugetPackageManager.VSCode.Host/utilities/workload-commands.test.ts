import * as assert from 'assert';
import { DescribeWorkloadResult } from '@/host/utilities/workload-commands';

suite('workload-commands', () => {
    test('marks a successful command as succeeded', () => {
        const result = DescribeWorkloadResult('update', 0, 'Workload(s) updated.\n');

        assert.strictEqual(result.Succeeded, true);
        assert.strictEqual(result.NeedsElevation, false);
        assert.strictEqual(result.Action, 'update');
        assert.strictEqual(result.Output, 'Workload(s) updated.');
    });

    test('reports a failed command without elevation', () => {
        const result = DescribeWorkloadResult('repair', 1, 'error: could not find a workload manifest');

        assert.strictEqual(result.Succeeded, false);
        assert.strictEqual(result.NeedsElevation, false);
        assert.strictEqual(result.ExitCode, 1);
    });

    test('detects an MSI elevation failure', () => {
        const output = [
            'Installing workload manifest microsoft.net.workload.emscripten.net10 version 11.0.100...',
            'Access is denied.',
        ].join('\n');

        assert.strictEqual(DescribeWorkloadResult('update', 5, output).NeedsElevation, true);
        assert.strictEqual(
            DescribeWorkloadResult('update', 1, 'This command requires elevation to update workloads.').NeedsElevation,
            true
        );
    });

    test('caps very large output', () => {
        const result = DescribeWorkloadResult('update', 0, 'x'.repeat(30_000));

        assert.strictEqual(result.Output.endsWith('… (output truncated)'), true);
        assert.strictEqual(result.Output.length < 30_000, true);
    });
});
