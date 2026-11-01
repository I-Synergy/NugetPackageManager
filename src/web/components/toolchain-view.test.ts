import '../web-setup';
import * as assert from 'assert';
import { ToolchainView } from '@/web/components/toolchain-view';
import { ok } from '@/common/rpc/result';
import * as registrations from '@/web/registrations';
import type { HostAPI, ToolchainHealth } from '@/common/rpc/types';

function makeHealth(overrides: Partial<ToolchainHealth> = {}): ToolchainHealth {
    return {
        DotnetFound: true,
        SdkVersion: '10.0.403',
        GlobalJsonPath: 'D:/ws/global.json',
        PinnedSdkVersion: '10.0.403',
        SdkMatchesPin: true,
        ProjectEvaluationFailed: false,
        CheckedAt: new Date().toISOString(),
        InstalledSdks: [{ Version: '10.0.403', Path: 'C:/dotnet/sdk', Source: 'system' }],
        Issues: [],
        ...overrides,
    };
}

async function waitForAsync(predicate: () => boolean, timeoutMs = 2000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (!predicate() && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 5));
    }
}

suite('ToolchainView Component', () => {
    let originalHostApi: HostAPI;
    let mockHostApi: Partial<HostAPI>;
    let healthCalls = 0;
    let diagnosticsCalls = 0;
    let workloadCalls: string[] = [];
    let confirmAnswer = true;
    let health = makeHealth();

    setup(() => {
        originalHostApi = registrations.hostApi;
        healthCalls = 0;
        diagnosticsCalls = 0;
        workloadCalls = [];
        confirmAnswer = true;
        health = makeHealth();

        mockHostApi = {
            getToolchainHealthAsync: async () => {
                healthCalls += 1;
                return ok({ Health: health });
            },
            runToolchainDiagnosticsAsync: async () => {
                diagnosticsCalls += 1;
                return ok({ Report: '--- report ---' });
            },
            setWorkspaceSdkAsync: async (request) => ok({ GlobalJsonPath: 'D:/ws/global.json', Version: request.Version, Notes: [] }),
            showConfirmationAsync: async () => ok({ Confirmed: confirmAnswer }),
            runWorkloadCommandAsync: async (request) => {
                workloadCalls.push(request.Action);
                return ok({
                    Action: request.Action,
                    Succeeded: true,
                    ExitCode: 0,
                    Output: 'Workload(s) updated.',
                    NeedsElevation: false,
                });
            },
        };
        Object.defineProperty(registrations, 'hostApi', {
            value: mockHostApi,
            writable: true,
            configurable: true,
        });
    });

    teardown(() => {
        Object.defineProperty(registrations, 'hostApi', {
            value: originalHostApi,
            writable: true,
            configurable: true,
        });
    });

    test('reports a healthy toolchain and the selected SDK', async () => {
        const view = new ToolchainView();
        document.body.appendChild(view);
        await waitForAsync(() => (view.shadowRoot?.textContent ?? '').includes('No toolchain problems detected'));

        const text = view.shadowRoot!.textContent ?? '';
        assert.match(text, /Using \.NET SDK 10\.0\.403/);
        assert.match(text, /No toolchain problems detected/);
        assert.match(text, /dotnet \(PATH\)/);
        assert.match(text, /10\.0\.403/);
        view.remove();
    });

    test('renders issues with hints and reports the issue count', async () => {
        health = makeHealth({
            SdkMatchesPin: false,
            ProjectEvaluationFailed: true,
            Issues: [{
                Kind: 'WorkloadManifestConflict',
                Summary: 'The .NET SDK 11.0.100-rc.3 has conflicting workload manifests.',
                Hint: 'Run `dotnet workload update`.',
                Detail: 'error MSB4242: SDK Resolver Failure',
            }],
        });

        const view = new ToolchainView();
        const counts: number[] = [];
        view.addEventListener('count-changed', (event) => counts.push((event as CustomEvent<number>).detail));
        document.body.appendChild(view);
        await waitForAsync(() => (view.shadowRoot?.textContent ?? '').includes('conflicting workload manifests'));

        const text = view.shadowRoot!.textContent ?? '';
        assert.match(text, /1 problem found/);
        assert.match(text, /dotnet workload update/);
        assert.deepStrictEqual(counts, [1]);

        // Raw output stays collapsed until asked for.
        assert.strictEqual(view.shadowRoot!.querySelector('pre'), null);
        const showButton = Array.from(view.shadowRoot!.querySelectorAll('button')).find(
            (button) => (button.textContent ?? '').trim() === 'Show output'
        ) as HTMLButtonElement;
        showButton.click();
        await view.updateComplete;
        assert.match(view.shadowRoot!.querySelector('pre')!.textContent ?? '', /MSB4242/);

        view.remove();
    });

    test('Re-check forces a fresh probe', async () => {
        const view = new ToolchainView();
        document.body.appendChild(view);
        await waitForAsync(() => healthCalls > 0);
        assert.strictEqual(healthCalls, 1);

        const recheck = Array.from(view.shadowRoot!.querySelectorAll('button')).find(
            (button) => (button.textContent ?? '').trim() === 'Re-check'
        ) as HTMLButtonElement;
        recheck.click();
        await waitForAsync(() => healthCalls > 1);
        assert.strictEqual(healthCalls, 2);

        view.remove();
    });

    test('shows a progress bar and disables Re-check while re-checking', async () => {
        const view = new ToolchainView();
        document.body.appendChild(view);
        await waitForAsync(() => healthCalls > 0);

        const gate: { release?: () => void } = {};
        mockHostApi.getToolchainHealthAsync = () => new Promise((resolve) => {
            healthCalls += 1;
            gate.release = () => resolve(ok({ Health: health }));
        });

        const recheck = Array.from(view.shadowRoot!.querySelectorAll('button')).find(
            (button) => (button.textContent ?? '').trim() === 'Re-check'
        ) as HTMLButtonElement;
        recheck.click();
        await waitForAsync(() => view.shadowRoot!.querySelector('[role="progressbar"]') !== null);

        assert.ok(view.shadowRoot!.querySelector('[role="progressbar"]'), 'progress bar should be visible');
        const pendingButton = Array.from(view.shadowRoot!.querySelectorAll('button')).find(
            (button) => (button.textContent ?? '').trim() === 'Re-check'
        ) as HTMLButtonElement;
        assert.strictEqual(pendingButton.disabled, true);

        gate.release?.();
        await waitForAsync(() => view.shadowRoot!.querySelector('[role="progressbar"]') === null);
        assert.strictEqual(view.shadowRoot!.querySelector('[role="progressbar"]'), null);

        view.remove();
    });

    test('Update workloads asks for confirmation, runs the command and re-checks', async () => {
        health = makeHealth({
            SdkVersion: '11.0.100-rc.3.26522.148',
            ProjectEvaluationFailed: true,
            Issues: [{
                Kind: 'WorkloadManifestConflict',
                Summary: 'The .NET SDK 11.0.100-rc.3 has conflicting workload manifests.',
                Hint: 'Run `dotnet workload update`.',
                Detail: 'error MSB4242',
            }],
        });

        const view = new ToolchainView();
        document.body.appendChild(view);
        await waitForAsync(() => (view.shadowRoot?.textContent ?? '').includes('conflicting workload manifests'));

        const findButton = (label: string): HTMLButtonElement => Array.from(view.shadowRoot!.querySelectorAll('button')).find(
            (button) => (button.textContent ?? '').trim() === label
        ) as HTMLButtonElement;

        confirmAnswer = false;
        findButton('Update workloads').click();
        await new Promise((resolve) => setTimeout(resolve, 10));
        assert.deepStrictEqual(workloadCalls, []);

        confirmAnswer = true;
        findButton('Update workloads').click();
        await waitForAsync(() => workloadCalls.length > 0);
        assert.deepStrictEqual(workloadCalls, ['update']);

        await waitForAsync(() => (view.shadowRoot?.textContent ?? '').includes('Workload(s) updated.'));
        assert.match(view.shadowRoot!.textContent ?? '', /re-checking the toolchain/);
        assert.strictEqual(healthCalls > 1, true, 'a successful update should re-check the toolchain');

        view.remove();
    });

    test('offers an editable cleanup command for left-over manifest bands', async () => {
        health = makeHealth({
            OrphanedManifestBands: [
                'C:/Program Files/dotnet/sdk-manifests/10.0.100',
                'C:/Program Files/dotnet/sdk-manifests/9.0.100',
            ],
        });

        let copied = '';
        Object.defineProperty(navigator, 'clipboard', {
            value: { writeText: async (text: string) => { copied = text; } },
            configurable: true,
        });

        const view = new ToolchainView();
        document.body.appendChild(view);
        await waitForAsync(() => (view.shadowRoot?.textContent ?? '').includes('left-over manifest bands'));

        const button = Array.from(view.shadowRoot!.querySelectorAll('button')).find(
            (candidate) => (candidate.textContent ?? '').trim() === 'Copy cleanup command'
        ) as HTMLButtonElement;
        assert.ok(button, 'cleanup button should be rendered');
        button.click();
        await waitForAsync(() => copied.length > 0);

        assert.match(copied, /elevated PowerShell/);
        assert.match(copied, /Rename-Item -LiteralPath "C:\/Program Files\/dotnet\/sdk-manifests\/10\.0\.100" "10\.0\.100\.bak"/);
        view.remove();
    });

    test('Copy diagnostics asks the host for the report', async () => {
        const view = new ToolchainView();
        view.projectPaths = ['d:/ws/App.csproj'];
        document.body.appendChild(view);
        await waitForAsync(() => healthCalls > 0);

        const copy = Array.from(view.shadowRoot!.querySelectorAll('button')).find(
            (button) => (button.textContent ?? '').trim() === 'Copy diagnostics'
        ) as HTMLButtonElement;
        copy.click();
        await waitForAsync(() => diagnosticsCalls > 0);
        assert.strictEqual(diagnosticsCalls, 1);

        view.remove();
    });
});
