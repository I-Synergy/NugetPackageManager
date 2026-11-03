import '@/web/web-setup';
import * as assert from 'assert';
import { ToolchainView } from '@/web/components/toolchain-view';
import { fail, ok } from '@/common/rpc/result';
import * as registrations from '@/web/registrations';
import type { Result } from '@/common/rpc/result';
import type {
    GetLocalToolsRequest,
    HostAPI,
    LocalTool,
    LocalToolManifest,
    ToolchainHealth,
    UpdateLocalToolRequest,
    UpdateLocalToolResponse,
} from '@/common/rpc/types';

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

function makeTool(overrides: Partial<LocalTool> = {}): LocalTool {
    return {
        Id: 'dotnet-ef',
        Commands: ['dotnet-ef'],
        Version: '8.0.0',
        Pinned: false,
        LatestVersion: '9.0.0',
        UpdateAvailable: true,
        NotRestored: false,
        ...overrides,
    };
}

function makeManifest(overrides: Partial<LocalToolManifest> = {}): LocalToolManifest {
    return {
        Path: 'D:/ws/.config/dotnet-tools.json',
        IsRoot: true,
        Tools: [makeTool()],
        Problems: [],
        ...overrides,
    };
}

function makeUpdateResponse(overrides: Partial<UpdateLocalToolResponse> = {}): UpdateLocalToolResponse {
    return {
        ManifestPath: 'D:/ws/.config/dotnet-tools.json',
        ToolId: 'dotnet-ef',
        PreviousVersion: '8.0.0',
        Version: '9.0.0',
        Restore: { Ok: true, TimedOut: false },
        ...overrides,
    };
}

function findButton(root: ShadowRoot, label: string): HTMLButtonElement | undefined {
    return Array.from(root.querySelectorAll('button')).find(
        (button) => (button.textContent ?? '').trim() === label
    ) as HTMLButtonElement | undefined;
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
    let manifests: LocalToolManifest[] = [];
    let toolsCalls = 0;
    let lastToolsRequest: GetLocalToolsRequest | undefined;
    let updateCalls: UpdateLocalToolRequest[] = [];
    let updateResult: Result<UpdateLocalToolResponse> = ok(makeUpdateResponse());

    setup(() => {
        originalHostApi = registrations.hostApi;
        healthCalls = 0;
        diagnosticsCalls = 0;
        workloadCalls = [];
        confirmAnswer = true;
        health = makeHealth();
        manifests = [];
        toolsCalls = 0;
        lastToolsRequest = undefined;
        updateCalls = [];
        updateResult = ok(makeUpdateResponse());

        mockHostApi = {
            getToolchainHealthAsync: async () => {
                healthCalls += 1;
                return ok({ Health: health });
            },
            getLocalToolsAsync: async (request) => {
                toolsCalls += 1;
                lastToolsRequest = request;
                return ok({ Manifests: manifests });
            },
            updateLocalToolAsync: async (request) => {
                updateCalls.push(request);
                return updateResult;
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

    test('renders one group per local tool manifest with relative paths, pinned badge and no Update all', async () => {
        manifests = [
            makeManifest({
                Path: 'D:/ws/.config/dotnet-tools.json',
                IsRoot: true,
                Tools: [
                    makeTool({ Id: 'dotnet-ef', Commands: ['dotnet-ef'], Version: '8.0.0', Pinned: true }),
                    makeTool({
                        Id: 'dotnet-format',
                        Commands: ['dotnet-format', 'dotnet-fmt'],
                        Version: '8.1.0',
                        LatestVersion: '8.1.0',
                        UpdateAvailable: false,
                    }),
                ],
            }),
            makeManifest({
                Path: 'D:/ws/sub/.config/dotnet-tools.json',
                IsRoot: false,
                Problems: ['duplicate command "dotnet-ef"'],
                Tools: [makeTool({ Id: 'gitversion.tool', Commands: ['dotnet-gitversion'] })],
            }),
        ];

        const view = new ToolchainView();
        view.projectPaths = ['D:/ws/src/App/App.csproj', 'D:/ws/tests/App.Tests/App.Tests.csproj'];
        document.body.appendChild(view);
        await waitForAsync(() => (view.shadowRoot?.querySelectorAll('.tool-path').length ?? 0) > 0);

        const root = view.shadowRoot!;
        const text = root.textContent ?? '';

        assert.deepStrictEqual(lastToolsRequest, {
            WorkspaceRoots: [],
            ProjectPaths: ['D:/ws/src/App/App.csproj', 'D:/ws/tests/App.Tests/App.Tests.csproj'],
            ResolveLatest: true,
        });

        // Workspace-relative headers, with the isRoot marker on the root manifest only.
        const paths = Array.from(root.querySelectorAll('.tool-path')).map((node) => (node.textContent ?? '').trim());
        assert.deepStrictEqual(paths, ['.config/dotnet-tools.json', 'sub/.config/dotnet-tools.json']);
        assert.strictEqual(root.querySelectorAll('.badge-root').length, 1);

        // Command names are the primary label, the tool id the secondary one.
        assert.match(text, /dotnet-format, dotnet-fmt/);
        assert.match(text, /gitversion\.tool/);
        assert.match(text, /dotnet-gitversion/);

        // Only the tool with UpdateAvailable gets a button, and only one per row.
        const updateButtons = Array.from(root.querySelectorAll('button')).filter(
            (button) => (button.textContent ?? '').trim() === 'Update'
        );
        assert.strictEqual(updateButtons.length, 2, 'one Update button per updatable tool');
        assert.strictEqual(findButton(root, 'Update all'), undefined);
        assert.doesNotMatch(text, /update all/i);

        // A pinned tool still offers the explicit update.
        assert.strictEqual(root.querySelectorAll('.badge').length >= 1, true);
        assert.match(text, /pinned/);

        // Problems render as a warning line and the manifest keeps its tools.
        assert.match(text, /duplicate command "dotnet-ef"/);
        assert.strictEqual(root.querySelectorAll('.tool-group').length, 2);

        view.remove();
    });

    test('updates one tool, then refreshes the list and shows the success status', async () => {
        manifests = [makeManifest()];

        const view = new ToolchainView();
        view.projectPaths = ['D:/ws/App/App.csproj'];
        document.body.appendChild(view);
        await waitForAsync(() => findButton(view.shadowRoot!, 'Update') !== undefined);
        assert.strictEqual(toolsCalls, 1);

        // The host would report the new version on the next read.
        manifests = [makeManifest({
            Tools: [makeTool({ Version: '9.0.0', LatestVersion: '9.0.0', UpdateAvailable: false })],
        })];

        findButton(view.shadowRoot!, 'Update')!.click();
        await waitForAsync(() => (view.shadowRoot?.textContent ?? '').includes('Updated dotnet-ef'));
        await waitForAsync(() => toolsCalls > 1);

        assert.deepStrictEqual(updateCalls, [{
            ManifestPath: 'D:/ws/.config/dotnet-tools.json',
            ToolId: 'dotnet-ef',
            ExpectedVersion: '8.0.0',
            Version: '9.0.0',
            WorkspaceRoots: [],
        }]);
        assert.strictEqual(toolsCalls > 1, true, 'a successful update re-reads the manifests');

        const text = view.shadowRoot!.textContent ?? '';
        assert.match(text, /Updated dotnet-ef to 9\.0\.0 — dotnet tool restore succeeded\./);
        assert.match(text, /9\.0\.0/);
        assert.strictEqual(findButton(view.shadowRoot!, 'Update'), undefined, 'no update left after the refresh');

        view.remove();
    });

    test('reports a failed restore while keeping the new version', async () => {
        manifests = [makeManifest()];
        updateResult = ok(makeUpdateResponse({ Restore: { Ok: false, TimedOut: false, Message: 'error NU1101: unable to find package' } }));

        const view = new ToolchainView();
        view.projectPaths = ['D:/ws/App/App.csproj'];
        document.body.appendChild(view);
        await waitForAsync(() => findButton(view.shadowRoot!, 'Update') !== undefined);

        manifests = [makeManifest({
            Tools: [makeTool({ Version: '9.0.0', LatestVersion: '9.0.0', UpdateAvailable: false })],
        })];

        findButton(view.shadowRoot!, 'Update')!.click();
        await waitForAsync(() => (view.shadowRoot?.textContent ?? '').includes('restore failed'));

        const text = view.shadowRoot!.textContent ?? '';
        assert.match(text, /manifest updated - restore failed: error NU1101: unable to find package/);
        assert.match(text, /9\.0\.0/, 'the manifest keeps the new version');

        view.remove();
    });

    test('reports a timed-out restore', async () => {
        manifests = [makeManifest()];
        updateResult = ok(makeUpdateResponse({ Restore: { Ok: false, TimedOut: true } }));

        const view = new ToolchainView();
        view.projectPaths = ['D:/ws/App/App.csproj'];
        document.body.appendChild(view);
        await waitForAsync(() => findButton(view.shadowRoot!, 'Update') !== undefined);

        findButton(view.shadowRoot!, 'Update')!.click();
        await waitForAsync(() => (view.shadowRoot?.textContent ?? '').includes('restore timed out'));

        assert.match(view.shadowRoot!.textContent ?? '', /manifest updated - restore timed out/);
        view.remove();
    });

    test('shows the host error text when the update fails', async () => {
        manifests = [makeManifest()];
        updateResult = fail('the manifest changed on disk; re-check and try again');

        const view = new ToolchainView();
        view.projectPaths = ['D:/ws/App/App.csproj'];
        document.body.appendChild(view);
        await waitForAsync(() => findButton(view.shadowRoot!, 'Update') !== undefined);

        findButton(view.shadowRoot!, 'Update')!.click();
        await waitForAsync(() => (view.shadowRoot?.textContent ?? '').includes('Could not update'));

        const text = view.shadowRoot!.textContent ?? '';
        assert.match(text, /Could not update dotnet-ef: the manifest changed on disk; re-check and try again/);
        assert.strictEqual(toolsCalls, 1, 'a failed update does not re-read the manifests');

        // The row is usable again.
        assert.strictEqual(findButton(view.shadowRoot!, 'Update')!.disabled, false);
        view.remove();
    });

    test('disables only the row whose update is running', async () => {
        manifests = [
            makeManifest({
                Tools: [makeTool({ Id: 'dotnet-ef' }), makeTool({ Id: 'dotnet-format', Commands: ['dotnet-format'] })],
            }),
        ];
        const gate: { release?: () => void } = {};
        mockHostApi.updateLocalToolAsync = async (request) => {
            updateCalls.push(request);
            return await new Promise((resolve) => { gate.release = () => resolve(ok(makeUpdateResponse())); });
        };

        const view = new ToolchainView();
        view.projectPaths = ['D:/ws/App/App.csproj'];
        document.body.appendChild(view);
        await waitForAsync(() => findButton(view.shadowRoot!, 'Update') !== undefined);

        const buttons = (): HTMLButtonElement[] => Array.from(view.shadowRoot!.querySelectorAll('button')).filter(
            (button) => (button.textContent ?? '').trim() === 'Update'
        ) as HTMLButtonElement[];

        buttons()[0]!.click();
        await waitForAsync(() => buttons()[0]!.disabled);
        assert.strictEqual(buttons()[0]!.disabled, true);
        assert.strictEqual(buttons()[1]!.disabled, false);
        assert.match(view.shadowRoot!.textContent ?? '', /Updating dotnet-ef to 9\.0\.0/);

        gate.release?.();
        await waitForAsync(() => !buttons()[0]!.disabled);
        view.remove();
    });

    test('shows the empty state when the workspace has no local tool manifest', async () => {
        manifests = [];

        const view = new ToolchainView();
        view.projectPaths = ['D:/ws/App/App.csproj'];
        document.body.appendChild(view);
        await waitForAsync(() => (view.shadowRoot?.textContent ?? '').includes('No local tool manifest'));

        const text = view.shadowRoot!.textContent ?? '';
        assert.match(text, /No local tool manifest in this workspace/);
        assert.match(text, /\.config\/dotnet-tools\.json/);
        view.remove();
    });

    test('falls back to the absolute manifest path when it is outside the project folders', async () => {
        manifests = [makeManifest({ Path: 'E:/other/.config/dotnet-tools.json' })];

        const view = new ToolchainView();
        view.projectPaths = ['D:/ws/App/App.csproj'];
        document.body.appendChild(view);
        await waitForAsync(() => (view.shadowRoot?.querySelectorAll('.tool-path').length ?? 0) > 0);

        const paths = Array.from(view.shadowRoot!.querySelectorAll('.tool-path')).map((node) => (node.textContent ?? '').trim());
        assert.deepStrictEqual(paths, ['E:/other/.config/dotnet-tools.json']);
        view.remove();
    });

    test('Re-check also refreshes the local tool list', async () => {
        manifests = [makeManifest()];

        const view = new ToolchainView();
        view.projectPaths = ['D:/ws/App/App.csproj'];
        document.body.appendChild(view);
        await waitForAsync(() => toolsCalls > 0);
        assert.strictEqual(toolsCalls, 1);

        findButton(view.shadowRoot!, 'Re-check')!.click();
        await waitForAsync(() => toolsCalls > 1);
        assert.strictEqual(toolsCalls, 2);
        view.remove();
    });
});
