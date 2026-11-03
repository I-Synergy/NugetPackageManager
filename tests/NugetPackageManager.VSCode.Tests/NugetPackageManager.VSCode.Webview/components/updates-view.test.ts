import '@/web/web-setup';
import * as assert from 'assert';
import { render, type TemplateResult } from 'lit';
import { UpdatesView } from '@/web/components/updates-view';
import { OutdatedPackageViewModel } from '@/web/types';
import { ok } from '@/common/rpc/result';
import * as registrations from '@/web/registrations';
import type { BatchUpdateRequest, GetOutdatedPackagesRequest, HostAPI, UpdateCentralVersionsRequest } from '@/common/rpc/types';

/** Waits for an async UI effect instead of assuming a fixed delay. */
async function waitForAsync(predicate: () => boolean, timeoutMs = 2000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (!predicate() && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 5));
    }
}

suite('UpdatesView', () => {
    let view: UpdatesView;
    let originalHostApi: HostAPI;
    let captured: BatchUpdateRequest | undefined;

    function makePackage(condition: string, framework: string): OutdatedPackageViewModel {
        return new OutdatedPackageViewModel({
            Id: 'Pkg.Shared',
            InstalledVersion: '1.0.0',
            LatestVersion: '2.0.0',
            Projects: [{ Name: 'A', Path: '/ws/A.csproj', Version: '1.0.0' }],
            SourceUrl: 'https://api.nuget.org/v3/index.json',
            SourceName: 'nuget.org',
            CpmCondition: condition,
            CpmFramework: framework,
        });
    }

    setup(() => {
        originalHostApi = registrations.hostApi;
        captured = undefined;
        Object.defineProperty(registrations, 'hostApi', {
            value: {
                startBatchUpdateAsync: async (request: BatchUpdateRequest) => {
                    captured = request;
                    return ok({ JobId: 'job-1' });
                },
                getJobAsync: async () => ok({
                    Kind: 'batchUpdate',
                    State: 'completed',
                    Stage: 'Completed',
                    Percent: 100,
                    Response: {
                        Results: [{
                            PackageId: captured?.Updates[0]?.PackageId ?? 'Pkg.Shared',
                            Success: true,
                        }],
                    },
                }),
                checkBatchUpdateAsync: async () => ok({ Conflicts: [] }),
                showConfirmationAsync: async () => ok({ Confirmed: true }),
                cancelJobAsync: async () => ok(undefined),
                restoreProjectsAsync: async () => ok(undefined),
                updateBadgeAsync: async () => ok(undefined),
                getOutdatedScanProgressAsync: async () => ok({ Stage: "", Percent: 0, Completed: 0, Total: 0, Active: false }),
            },
            writable: true,
            configurable: true,
        });
        view = new UpdatesView();
    });

    teardown(() => {
        Object.defineProperty(registrations, 'hostApi', {
            value: originalHostApi,
            writable: true,
            configurable: true,
        });
    });

    test('drops conflicting rows after confirmation and updates the rest', async () => {
        const requests: BatchUpdateRequest[] = [];
        Object.defineProperty(registrations, 'hostApi', {
            value: {
                checkBatchUpdateAsync: async () => ok({
                    Conflicts: [{
                        PackageId: 'Pkg.Bad',
                        RequestedVersion: '2.0.0',
                        BlockedByPackageId: 'Pkg.Pin',
                        BlockedByVersion: '1.0.0',
                        RequiredRange: '[1.0.0]',
                        EffectiveVersion: '1.0.0',
                        ProjectPath: '/ws/A.csproj',
                        Reason: 'Pkg.Pin 1.0.0 requires Pkg.Bad [1.0.0]',
                    }],
                }),
                showConfirmationAsync: async () => ok({ Confirmed: true }),
                startBatchUpdateAsync: async (request: BatchUpdateRequest) => {
                    requests.push(request);
                    return ok({ JobId: 'job-preflight' });
                },
                getJobAsync: async () => ok({
                    Kind: 'batchUpdate',
                    State: 'completed',
                    Stage: 'Completed',
                    Percent: 100,
                    Response: { Results: [{ PackageId: 'Pkg.Shared', Success: true }] },
                }),
                updateBadgeAsync: async () => ok(undefined),
                getOutdatedScanProgressAsync: async () => ok({ Stage: "", Percent: 0, Completed: 0, Total: 0, Active: false }),
            },
            writable: true,
            configurable: true,
        });

        const good = makePackage('', '');
        const bad = makePackage('', '');
        bad.Id = 'Pkg.Bad';
        bad.LatestVersion = '2.0.0';
        view.packages = [good, bad];

        await (view as unknown as {
            updatePackagesSequentiallyAsync(packages: OutdatedPackageViewModel[]): Promise<void>;
        }).updatePackagesSequentiallyAsync([good, bad]);

        assert.strictEqual(requests.length, 1);
        assert.deepStrictEqual(requests[0]!.Updates.map((update) => update.PackageId), ['Pkg.Shared']);
        assert.deepStrictEqual(view.packages.map((pkg) => pkg.Id), ['Pkg.Bad'], 'the skipped row stays visible');
        assert.match(view.statusText, /1 package updated and restored/);
    });

    test('writes nothing when the user declines the conflicting rows', async () => {
        let started = 0;
        Object.defineProperty(registrations, 'hostApi', {
            value: {
                checkBatchUpdateAsync: async () => ok({
                    Conflicts: [{
                        PackageId: 'Pkg.Shared',
                        RequestedVersion: '2.0.0',
                        BlockedByPackageId: 'Pkg.Pin',
                        BlockedByVersion: '1.0.0',
                        RequiredRange: '[1.0.0]',
                        EffectiveVersion: '1.0.0',
                        ProjectPath: '/ws/A.csproj',
                        Reason: 'Pkg.Pin 1.0.0 requires Pkg.Shared [1.0.0]',
                    }],
                }),
                showConfirmationAsync: async () => ok({ Confirmed: false }),
                startBatchUpdateAsync: async () => {
                    started += 1;
                    return ok({ JobId: 'job-declined' });
                },
                updateBadgeAsync: async () => ok(undefined),
                getOutdatedScanProgressAsync: async () => ok({ Stage: "", Percent: 0, Completed: 0, Total: 0, Active: false }),
            },
            writable: true,
            configurable: true,
        });

        const pkg = makePackage('', '');
        view.packages = [pkg];

        await (view as unknown as {
            updatePackagesSequentiallyAsync(packages: OutdatedPackageViewModel[]): Promise<void>;
        }).updatePackagesSequentiallyAsync([pkg]);

        assert.strictEqual(started, 0, 'a declined preflight must not write anything');
        assert.match(view.statusText, /cancelled before writing/);
        assert.strictEqual(view.packages.length, 1);
    });

    test('offers to include the sibling packages a preview set requires', async () => {
        const requests: BatchUpdateRequest[] = [];
        let checks = 0;
        Object.defineProperty(registrations, 'hostApi', {
            value: {
                checkBatchUpdateAsync: async (request: BatchUpdateRequest) => {
                    checks += 1;
                    const ids = request.Updates.map((update) => update.PackageId);
                    // First pass: the sibling is missing. Second pass: it is included.
                    return ok(ids.includes('Pkg.Required')
                        ? { Conflicts: [] }
                        : {
                            Conflicts: [{
                                PackageId: 'Pkg.Main',
                                RequestedVersion: '2.0.0-preview',
                                BlockedByPackageId: 'Pkg.Required',
                                BlockedByVersion: '1.0.0',
                                RequiredRange: '[2.0.0-preview, )',
                                EffectiveVersion: '1.0.0',
                                ProjectPath: '/ws/A.csproj',
                                Reason: 'Pkg.Main 2.0.0-preview requires Pkg.Required [2.0.0-preview, )',
                            }],
                        });
                },
                showConfirmationAsync: async () => ok({ Confirmed: true }),
                startBatchUpdateAsync: async (request: BatchUpdateRequest) => {
                    requests.push(request);
                    return ok({ JobId: 'job-expanded' });
                },
                getJobAsync: async () => ok({
                    Kind: 'batchUpdate',
                    State: 'completed',
                    Stage: 'Completed',
                    Percent: 100,
                    Response: { Results: [{ PackageId: 'Pkg.Main', Success: true }] },
                }),
                updateBadgeAsync: async () => ok(undefined),
                getOutdatedScanProgressAsync: async () => ok({ Stage: "", Percent: 0, Completed: 0, Total: 0, Active: false }),
            },
            writable: true,
            configurable: true,
        });

        const main = makePackage('', '');
        main.Id = 'Pkg.Main';
        main.LatestVersion = '2.0.0-preview';
        const required = makePackage('', '');
        required.Id = 'Pkg.Required';
        required.LatestVersion = '2.0.0-preview';
        view.packages = [main, required];

        await (view as unknown as {
            updatePackagesSequentiallyAsync(packages: OutdatedPackageViewModel[]): Promise<void>;
        }).updatePackagesSequentiallyAsync([main]);

        assert.strictEqual(checks, 2, 'the preflight runs again with the included package');
        assert.strictEqual(requests.length, 1);
        assert.deepStrictEqual(
            requests[0]!.Updates.map((update) => update.PackageId).sort(),
            ['Pkg.Main', 'Pkg.Required']
        );
        assert.strictEqual(
            requests[0]!.Updates.find((update) => update.PackageId === 'Pkg.Required')?.Version,
            '2.0.0-preview'
        );
    });

    test('raises central versions required by a preview set', async () => {
        const centralRequests: Array<{ ProjectPaths?: string[]; Updates: Array<{ PackageId: string; Version: string }> }> = [];
        let checks = 0;
        Object.defineProperty(registrations, 'hostApi', {
            value: {
                checkBatchUpdateAsync: async () => {
                    checks += 1;
                    return ok(checks === 1
                        ? {
                            Conflicts: [{
                                PackageId: 'Pkg.Main',
                                RequestedVersion: '2.0.0-preview',
                                BlockedByPackageId: 'Pkg.Central',
                                BlockedByVersion: '1.0.0',
                                RequiredRange: '[2.0.0-preview, )',
                                EffectiveVersion: '1.0.0',
                                ProjectPath: '/ws/A.csproj',
                                Reason: 'Pkg.Main 2.0.0-preview requires Pkg.Central [2.0.0-preview, )',
                            }],
                        }
                        : { Conflicts: [] });
                },
                updateCentralVersionsAsync: async (request: UpdateCentralVersionsRequest) => {
                    centralRequests.push({
                        ...(request.ProjectPaths ? { ProjectPaths: request.ProjectPaths } : {}),
                        Updates: request.Updates,
                    });
                    return ok({ Applied: ['Pkg.Central'], Skipped: [], PropsFile: '/ws/Directory.Packages.props' });
                },
                showConfirmationAsync: async () => ok({ Confirmed: true }),
                startBatchUpdateAsync: async () => ok({ JobId: 'job-central' }),
                getJobAsync: async () => ok({
                    Kind: 'batchUpdate',
                    State: 'completed',
                    Stage: 'Completed',
                    Percent: 100,
                    Response: { Results: [{ PackageId: 'Pkg.Main', Success: true }] },
                }),
                updateBadgeAsync: async () => ok(undefined),
                getOutdatedScanProgressAsync: async () => ok({ Stage: "", Percent: 0, Completed: 0, Total: 0, Active: false }),
            },
            writable: true,
            configurable: true,
        });

        const main = makePackage('', '');
        main.Id = 'Pkg.Main';
        main.LatestVersion = '2.0.0-preview';
        view.packages = [main];
        view.projectPaths = ['/ws/A.csproj'];

        await (view as unknown as {
            updatePackagesSequentiallyAsync(packages: OutdatedPackageViewModel[]): Promise<void>;
        }).updatePackagesSequentiallyAsync([main]);

        assert.deepStrictEqual(centralRequests, [{
            ProjectPaths: ['/ws/A.csproj'],
            Updates: [{ PackageId: 'Pkg.Central', Version: '2.0.0-preview' }],
        }]);
        assert.strictEqual(checks, 2, 'the preflight is retried after raising the central version');
    });

    test('writes conditional groups when target frameworks disagree', async () => {
        const centralRequests: Array<{
            Updates: Array<{ PackageId: string; Version: string; Condition?: string }>;
        }> = [];
        let checks = 0;

        Object.defineProperty(registrations, 'hostApi', {
            value: {
                checkBatchUpdateAsync: async () => {
                    checks += 1;
                    if (checks > 1) return ok({ Conflicts: [] });
                    return ok({
                        Conflicts: [
                            {
                                PackageId: 'Pkg.Main',
                                RequestedVersion: '2.0.0-preview',
                                BlockedByPackageId: 'Pkg.Central',
                                BlockedByVersion: '1.0.0',
                                RequiredRange: '[2.0.0-preview, )',
                                RequiredVersion: '2.0.0-preview',
                                Tfm: 'net10.0',
                                EffectiveVersion: '1.0.0',
                                ProjectPath: '/ws/Net10.csproj',
                                Reason: 'net10 needs 2.0.0-preview',
                            },
                            {
                                PackageId: 'Pkg.Main',
                                RequestedVersion: '2.0.0-preview',
                                BlockedByPackageId: 'Pkg.Central',
                                BlockedByVersion: '1.0.0',
                                RequiredRange: '[3.0.0-preview, )',
                                RequiredVersion: '3.0.0-preview',
                                Tfm: 'net11.0',
                                EffectiveVersion: '1.0.0',
                                ProjectPath: '/ws/Net11.csproj',
                                Reason: 'net11 needs 3.0.0-preview',
                            },
                        ],
                    });
                },
                updateCentralVersionsAsync: async (request: {
                    Updates: Array<{ PackageId: string; Version: string; Condition?: string }>;
                }) => {
                    centralRequests.push({ Updates: request.Updates });
                    return ok({
                        Applied: request.Updates.map((update) => update.PackageId),
                        Skipped: [],
                        PropsFile: '/ws/Directory.Packages.props',
                    });
                },
                showConfirmationAsync: async () => ok({ Confirmed: true }),
                startBatchUpdateAsync: async () => ok({ JobId: 'job-conditional' }),
                getJobAsync: async () => ok({
                    Kind: 'batchUpdate',
                    State: 'completed',
                    Stage: 'Completed',
                    Percent: 100,
                    Response: { Results: [{ PackageId: 'Pkg.Main', Success: true }] },
                }),
                updateBadgeAsync: async () => ok(undefined),
                getOutdatedScanProgressAsync: async () => ok({ Stage: "", Percent: 0, Completed: 0, Total: 0, Active: false }),
            },
            writable: true,
            configurable: true,
        });

        const main = makePackage('', '');
        main.Id = 'Pkg.Main';
        main.LatestVersion = '2.0.0-preview';
        view.packages = [main];
        view.projectPaths = ['/ws/A.csproj'];

        await (view as unknown as {
            updatePackagesSequentiallyAsync(packages: OutdatedPackageViewModel[]): Promise<void>;
        }).updatePackagesSequentiallyAsync([main]);

        assert.deepStrictEqual(centralRequests[0]!.Updates, [
            { PackageId: 'Pkg.Central', Version: '2.0.0-preview', Condition: "'$(TargetFramework)' == 'net10.0'" },
            { PackageId: 'Pkg.Central', Version: '3.0.0-preview', Condition: "'$(TargetFramework)' == 'net11.0'" },
        ]);
        assert.strictEqual(checks, 2, 'the preflight is retried after writing the groups');
    });

    test('cancels the running job from the progress banner', async () => {
        let running = true;
        const cancelledJobs: string[] = [];
        Object.defineProperty(registrations, 'hostApi', {
            value: {
                checkBatchUpdateAsync: async () => ok({ Conflicts: [] }),
                startBatchUpdateAsync: async (request: BatchUpdateRequest) => {
                    captured = request;
                    return ok({ JobId: 'job-cancel-me' });
                },
                getJobAsync: async () => running
                    ? ok({ Kind: 'batchUpdate', State: 'running', Stage: 'Restoring updated projects…', Percent: 80 })
                    : ok({
                        Kind: 'batchUpdate',
                        State: 'cancelled',
                        Stage: 'Cancelled',
                        Percent: 80,
                        Response: { Results: [], RolledBack: true, Cancelled: true },
                    }),
                cancelJobAsync: async ({ JobId }: { JobId: string }) => {
                    cancelledJobs.push(JobId);
                    running = false;
                    return ok(undefined);
                },
                updateBadgeAsync: async () => ok(undefined),
                getOutdatedScanProgressAsync: async () => ok({ Stage: "", Percent: 0, Completed: 0, Total: 0, Active: false }),
            },
            writable: true,
            configurable: true,
        });

        const pkg = makePackage('', '');
        view.packages = [pkg];
        const updating = (view as unknown as {
            updatePackagesSequentiallyAsync(packages: OutdatedPackageViewModel[]): Promise<void>;
        }).updatePackagesSequentiallyAsync([pkg]);

        await waitForAsync(() => view.jobProgress?.Percent === 80);

        const host = document.createElement('div');
        render(view.render() as TemplateResult, host);
        const cancelButton = Array.from(host.querySelectorAll('button'))
            .find((button) => button.textContent?.trim() === 'Cancel');
        assert.ok(cancelButton, 'the progress banner offers a cancel button');
        cancelButton!.click();

        await waitForAsync(() => cancelledJobs.length > 0, 2000);
        assert.deepStrictEqual(cancelledJobs, ['job-cancel-me']);

        await updating;
        assert.match(view.statusText, /cancelled/i);
        assert.strictEqual(view.packages.length, 1, 'a cancelled update keeps its rows');
    });

    test('offers to retry without the packages the failed restore names', async () => {
        const requests: BatchUpdateRequest[] = [];
        let confirmations = 0;
        Object.defineProperty(registrations, 'hostApi', {
            value: {
                checkBatchUpdateAsync: async () => ok({ Conflicts: [] }),
                showConfirmationAsync: async () => {
                    confirmations += 1;
                    return ok({ Confirmed: true });
                },
                startBatchUpdateAsync: async (request: BatchUpdateRequest) => {
                    requests.push(request);
                    return ok({ JobId: `job-retry-${requests.length}` });
                },
                getJobAsync: async ({ JobId }: { JobId: string }) => JobId === 'job-retry-1'
                    ? ok({
                        Kind: 'batchUpdate',
                        State: 'completed',
                        Stage: 'Completed',
                        Percent: 100,
                        Response: {
                            Results: [{ PackageId: 'Pkg.Bad', Success: true }],
                            RolledBack: true,
                            RestoreError: 'NU1107 for Pkg.Bad',
                            ConflictingPackages: ['Pkg.Bad'],
                        },
                    })
                    : ok({
                        Kind: 'batchUpdate',
                        State: 'completed',
                        Stage: 'Completed',
                        Percent: 100,
                        Response: { Results: [{ PackageId: 'Pkg.Shared', Success: true }] },
                    }),
                updateBadgeAsync: async () => ok(undefined),
                getOutdatedScanProgressAsync: async () => ok({ Stage: "", Percent: 0, Completed: 0, Total: 0, Active: false }),
            },
            writable: true,
            configurable: true,
        });

        const good = makePackage('', '');
        const bad = makePackage('', '');
        bad.Id = 'Pkg.Bad';
        view.packages = [good, bad];

        await (view as unknown as {
            updatePackagesSequentiallyAsync(packages: OutdatedPackageViewModel[]): Promise<void>;
        }).updatePackagesSequentiallyAsync([good, bad]);

        assert.strictEqual(confirmations, 1, 'the user is asked once before the retry');
        assert.strictEqual(requests.length, 2);
        assert.deepStrictEqual(
            requests[1]!.Updates.map((update) => update.PackageId),
            ['Pkg.Shared'],
            'the retry excludes the package named by the restore failure'
        );
        assert.deepStrictEqual(view.packages.map((pkg) => pkg.Id), ['Pkg.Bad']);
    });

    test('sends the unconditional scope for a shared package row', async () => {
        const pkg = makePackage('', '');
        view.packages = [pkg];

        await (view as unknown as { updateSingleAsync(p: OutdatedPackageViewModel, skip: boolean): Promise<void> })
            .updateSingleAsync(pkg, true);

        assert.strictEqual(captured?.Updates[0]!.Scope, 'unconditional');
        assert.strictEqual(captured?.Updates[0]!.CpmCondition, undefined);
    });

    test('groups visible packages by shared and framework line', () => {
        const shared = makePackage('', '');
        const net8 = makePackage("$(TargetFramework.StartsWith('net8.0'))", 'net8.0');
        const net9 = makePackage("$(TargetFramework.StartsWith('net9.0'))", 'net9.0');
        view.packages = [net9, shared, net8];

        const groups = (view as unknown as {
            groupedVisiblePackages: Array<{ label: string; packages: OutdatedPackageViewModel[] }>;
        }).groupedVisiblePackages;

        assert.deepStrictEqual(groups.map((group) => group.label), ['Shared', 'net8.0', 'net9.0']);
        assert.strictEqual(groups[0]!.packages.length, 1);
    });

    test('includes installed framework lines even when they have no outdated row', () => {
        const net10 = makePackage("$(TargetFramework.StartsWith('net10.0'))", 'net10.0');
        view.packages = [net10];
        view.availableFrameworks = [
            { value: '', label: 'All frameworks' },
            { value: 'net10.0', label: 'net10.0' },
            { value: 'net11.0', label: 'net11.0' },
        ];

        assert.deepStrictEqual(view.frameworkOptions, [
            { value: '', label: 'All frameworks' },
            { value: 'net10.0', label: 'net10.0' },
            { value: 'net11.0', label: 'net11.0' },
        ]);
    });

    test('exposes framework options and filters visible updates by framework', () => {
        const shared = makePackage('', '');
        const net10 = makePackage("$(TargetFramework.StartsWith('net10.0'))", 'net10.0');
        const net11 = makePackage("$(TargetFramework.StartsWith('net11.0'))", 'net11.0');
        view.packages = [shared, net11, net10];

        assert.deepStrictEqual(view.frameworkOptions, [
            { value: '', label: 'All frameworks' },
            { value: '__shared__', label: 'Shared' },
            { value: 'net10.0', label: 'net10.0' },
            { value: 'net11.0', label: 'net11.0' },
        ]);

        view.selectedFramework = 'net11.0';
        const visible = (view as unknown as { visiblePackages: OutdatedPackageViewModel[] }).visiblePackages;
        assert.deepStrictEqual(visible.map((pkg) => pkg.CpmFramework).sort((a, b) => a.localeCompare(b)), ['net11.0']);

        view.selectedFramework = '__shared__';
        const sharedOnly = (view as unknown as { visiblePackages: OutdatedPackageViewModel[] }).visiblePackages;
        assert.deepStrictEqual(sharedOnly.map((pkg) => pkg.CpmFramework), ['']);
    });

    test('does not duplicate the shared option from available frameworks', () => {
        const shared = makePackage('', '');
        view.packages = [shared];
        view.availableFrameworks = [
            { value: '', label: 'All frameworks' },
            { value: '__shared__', label: 'Shared' },
            { value: 'net10.0', label: 'net10.0' },
        ];

        assert.deepStrictEqual(view.frameworkOptions, [
            { value: '', label: 'All frameworks' },
            { value: '__shared__', label: 'Shared' },
            { value: 'net10.0', label: 'net10.0' },
        ]);
    });

    test('collapses platform TFMs into their base .NET line', () => {
        const windows = makePackage("$(TargetFramework.Contains('-windows'))", 'net10.0-windows10.0.26100.0');
        const android = makePackage("$(TargetFramework.Contains('-android'))", 'net10.0-android34.0');
        view.packages = [windows, android];

        assert.deepStrictEqual(view.frameworkOptions, [
            { value: '', label: 'All frameworks' },
            { value: 'net10.0', label: 'net10.0' },
        ]);

        view.selectedFramework = 'net10.0';
        const visible = (view as unknown as { visiblePackages: OutdatedPackageViewModel[] }).visiblePackages;
        assert.strictEqual(visible.length, 2);
    });

    test('selects and deselects all visible packages in a group', () => {
        const sharedA = makePackage('', '');
        const sharedB = makePackage('', '');
        const net10 = makePackage("$(TargetFramework.StartsWith('net10.0'))", 'net10.0');
        view.packages = [sharedA, sharedB, net10];
        view.selectedFramework = '';

        const groups = (view as unknown as {
            groupedVisiblePackages: Array<{ label: string; packages: OutdatedPackageViewModel[] }>;
        }).groupedVisiblePackages;
        const sharedGroup = groups.find((group) => group.label === 'Shared')!;
        const toggle = (view as unknown as {
            toggleGroupSelection(packages: OutdatedPackageViewModel[], selected: boolean): void;
        }).toggleGroupSelection.bind(view);

        toggle(sharedGroup.packages, true);
        assert.ok(sharedA.Selected && sharedB.Selected);
        assert.strictEqual(net10.Selected, false);

        toggle(sharedGroup.packages, false);
        assert.strictEqual(sharedA.Selected, false);
        assert.strictEqual(sharedB.Selected, false);
        assert.strictEqual(net10.Selected, false);
    });

    test('emits packages-updated after a successful update', async () => {
        const pkg = makePackage("$(TargetFramework.StartsWith('net10.0'))", 'net10.0');
        view.packages = [pkg];
        let events = 0;
        view.addEventListener('packages-updated', () => { events++; });

        const succeeded = await (view as unknown as {
            updateSingleAsync(p: OutdatedPackageViewModel, skip: boolean): Promise<boolean>;
        }).updateSingleAsync(pkg, true);

        assert.strictEqual(succeeded, true);
        assert.strictEqual(events, 1);
        // The header renders "<n> updates available"; the suffix must not repeat the count.
        assert.strictEqual(view.statusText, 'Updated Pkg.Shared to 2.0.0');
    });

    test('renders live progress while the update job runs and clears it afterwards', async () => {
        let running = true;
        Object.defineProperty(registrations, 'hostApi', {
            value: {
                startBatchUpdateAsync: async (request: BatchUpdateRequest) => {
                    captured = request;
                    return ok({ JobId: 'job-42' });
                },
                getJobAsync: async () => running
                    ? ok({ Kind: 'batchUpdate', State: 'running', Stage: 'Restoring updated projects…', Percent: 80 })
                    : ok({
                        Kind: 'batchUpdate',
                        State: 'completed',
                        Stage: 'Completed',
                        Percent: 100,
                        Response: { Results: [{ PackageId: 'Pkg.Shared', Success: true }] },
                    }),
                restoreProjectsAsync: async () => ok(undefined),
                updateBadgeAsync: async () => ok(undefined),
                getOutdatedScanProgressAsync: async () => ok({ Stage: "", Percent: 0, Completed: 0, Total: 0, Active: false }),
            },
            writable: true,
            configurable: true,
        });

        const pkg = makePackage('', '');
        view.packages = [pkg];
        const updating = (view as unknown as {
            updateSingleAsync(p: OutdatedPackageViewModel, skip: boolean): Promise<boolean>;
        }).updateSingleAsync(pkg, true);

        await waitForAsync(() => view.jobProgress?.Percent === 80);
        assert.deepStrictEqual(view.jobProgress, { Stage: 'Restoring updated projects…', Percent: 80 });

        running = false;
        assert.strictEqual(await updating, true);
        assert.strictEqual(view.jobProgress, null);
        assert.strictEqual(view.packages.length, 0);
    });

    test('surfaces a failed update job and keeps the row', async () => {
        Object.defineProperty(registrations, 'hostApi', {
            value: {
                startBatchUpdateAsync: async (request: BatchUpdateRequest) => {
                    captured = request;
                    return ok({ JobId: 'job-failed' });
                },
                getJobAsync: async () => ok({
                    Kind: 'batchUpdate',
                    State: 'failed',
                    Stage: 'Failed',
                    Percent: 0,
                    Error: 'dotnet restore failed',
                }),
                restoreProjectsAsync: async () => ok(undefined),
                updateBadgeAsync: async () => ok(undefined),
                getOutdatedScanProgressAsync: async () => ok({ Stage: "", Percent: 0, Completed: 0, Total: 0, Active: false }),
            },
            writable: true,
            configurable: true,
        });

        const pkg = makePackage('', '');
        view.packages = [pkg];
        const succeeded = await (view as unknown as {
            updateSingleAsync(p: OutdatedPackageViewModel, skip: boolean): Promise<boolean>;
        }).updateSingleAsync(pkg, true);

        assert.strictEqual(succeeded, false);
        assert.match(view.statusText, /Failed to update Pkg\.Shared: dotnet restore failed/);
        assert.strictEqual(view.packages.length, 1);
        assert.strictEqual(view.jobProgress, null);
    });

    test('sends the group scope and condition for a framework row', async () => {
        const pkg = makePackage("$(TargetFramework.StartsWith('net10.0'))", 'net10.0');
        view.packages = [pkg];

        await (view as unknown as { updateSingleAsync(p: OutdatedPackageViewModel, skip: boolean): Promise<void> })
            .updateSingleAsync(pkg, true);

        assert.strictEqual(captured?.Updates[0]!.Scope, 'group');
        assert.strictEqual(captured?.Updates[0]!.CpmCondition, "$(TargetFramework.StartsWith('net10.0'))");
        assert.strictEqual(captured?.Updates[0]!.CpmTfm, 'net10.0');
    });

    test('renders the pinning dependency for a held-back update', () => {
        const pkg = makePackage('', '');
        pkg.LatestOverallVersion = '3.0.0';
        const blockedBy = [{
            PackageId: 'Npgsql.EntityFrameworkCore.PostgreSQL',
            InstalledVersion: '11.0.0-rc.2',
            Range: '[11.0.0-rc.2.26504.105]',
        }];
        pkg.BlockedBy = blockedBy;
        view.packages = [pkg];
        view.blockedPackages = [{
            Id: 'Microsoft.EntityFrameworkCore.Relational',
            InstalledVersion: '11.0.0-rc.2.26504.105',
            BlockedVersion: '11.0.0-rc.3.26522.148',
            Reason: pkg.blockedReason,
            BlockedBy: blockedBy,
        }];

        const host = document.createElement('div');
        render(view.render() as TemplateResult, host);

        assert.strictEqual(host.querySelectorAll('.conflict-row').length, 1);
        assert.match(host.textContent ?? '', /Dependency conflicts \(1\)/);
        assert.match(host.textContent ?? '', /11\.0\.0-rc\.2\.26504\.105 → 11\.0\.0-rc\.3\.26522\.148 blocked/);
        assert.match(host.textContent ?? '', /Npgsql\.EntityFrameworkCore\.PostgreSQL 11\.0\.0-rc\.2 requires \[11\.0\.0-rc\.2\.26504\.105\]/);
    });

    test('does not claim everything is up to date when every update is blocked', () => {
        const blockedBy = [{
            PackageId: 'Npgsql.EntityFrameworkCore.PostgreSQL',
            InstalledVersion: '11.0.0-rc.2',
            Range: '[11.0.0-rc.2.26504.105]',
        }];
        view.packages = [];
        view.blockedPackages = [{
            Id: 'Microsoft.EntityFrameworkCore.Relational',
            InstalledVersion: '11.0.0-rc.2.26504.105',
            BlockedVersion: '11.0.0-rc.3.26522.148',
            Reason: 'Npgsql.EntityFrameworkCore.PostgreSQL 11.0.0-rc.2 requires [11.0.0-rc.2.26504.105]',
            BlockedBy: blockedBy,
        }];

        const host = document.createElement('div');
        render(view.render() as TemplateResult, host);

        assert.doesNotMatch(host.textContent ?? '', /All packages are up to date/);
        assert.match(host.textContent ?? '', /Dependency conflicts \(1\)/);
    });

    test('paints cached rows and preserves selections across the refresh', () => {
        const raw = {
            Id: 'Pkg.Shared',
            InstalledVersion: '1.0.0',
            LatestVersion: '2.0.0',
            Projects: [{ Name: 'A', Path: '/ws/A.csproj', Version: '1.0.0' }],
            SourceUrl: 'https://api.nuget.org/v3/index.json',
            SourceName: 'nuget.org',
        };

        (view as unknown as {
            applyScan(response: { Packages: typeof raw[]; FromCache?: boolean; ScannedAt?: string }, fromCache: boolean): void;
        }).applyScan({ Packages: [raw], FromCache: true, ScannedAt: '2026-10-26T12:00:00.000Z' }, true);

        assert.strictEqual(view.packages.length, 1);
        assert.strictEqual(view.isRefreshing, true);
        assert.match(view.statusText, /cached results/);

        view.packages[0]!.Selected = false;
        (view as unknown as {
            applyScan(response: { Packages: typeof raw[]; FromCache?: boolean }, fromCache: boolean): void;
        }).applyScan({ Packages: [raw], FromCache: false }, false);

        assert.strictEqual(view.packages[0]!.Selected, false);
        assert.strictEqual(view.isRefreshing, false);
        assert.strictEqual(view.statusText, '');
    });

    test('requests the cached scan before the live job', async () => {
        const cachedRequests: boolean[] = [];
        const jobRequests: GetOutdatedPackagesRequest[] = [];
        Object.defineProperty(registrations, 'hostApi', {
            value: {
                // Only the pre-paint cache read still uses the request/response call.
                getOutdatedPackagesAsync: async (request: GetOutdatedPackagesRequest) => {
                    cachedRequests.push(request.PreferCache === true);
                    return ok({ Packages: [], FromCache: request.PreferCache === true });
                },
                startOutdatedScanAsync: async (request: GetOutdatedPackagesRequest) => {
                    jobRequests.push(request);
                    return ok({ JobId: 'job-outdated' });
                },
                getJobAsync: async () => ok({
                    Kind: 'outdatedScan',
                    State: 'completed',
                    Stage: 'Completed',
                    Percent: 100,
                    Response: { Packages: [] },
                }),
                startBatchUpdateAsync: async () => ok({ JobId: 'job-unused' }),
                restoreProjectsAsync: async () => ok(undefined),
                updateBadgeAsync: async () => ok(undefined),
                getOutdatedScanProgressAsync: async () => ok({ Stage: "", Percent: 0, Completed: 0, Total: 0, Active: false }),
            },
            writable: true,
            configurable: true,
        });

        await view.LoadOutdatedPackagesAsync();

        assert.deepStrictEqual(cachedRequests, [true], 'the cached scan is read, not scanned');
        assert.strictEqual(jobRequests.length, 1, 'the live scan runs as one job');
        assert.strictEqual(jobRequests[0]!.PreferCache, undefined, 'the live job scans');
    });

    test('discards a scan that completes after a mutation changed the epoch', async () => {
        let started = false;
        let release!: () => void;
        const gate = new Promise<void>((resolve) => { release = resolve; });

        Object.defineProperty(registrations, 'hostApi', {
            value: {
                startOutdatedScanAsync: async () => {
                    started = true;
                    return ok({ JobId: 'job-mutated' });
                },
                // The scan is still running when the update lands; it answers afterwards with the
                // list it was asked for before the write.
                getJobAsync: async () => {
                    await gate;
                    return ok({
                        Kind: 'outdatedScan',
                        State: 'completed',
                        Stage: 'Completed',
                        Percent: 100,
                        Response: {
                            Packages: [{
                                Id: 'Pkg.Shared',
                                InstalledVersion: '1.0.0',
                                LatestVersion: '2.0.0',
                                Projects: [{ Name: 'A', Path: '/ws/A.csproj', Version: '1.0.0' }],
                                SourceUrl: 'https://api.nuget.org/v3/index.json',
                                SourceName: 'nuget.org',
                            }],
                        },
                    });
                },
                getOutdatedPackagesAsync: async () => ok({ Packages: [] }),
                updateBadgeAsync: async () => ok(undefined),
                getOutdatedScanProgressAsync: async () => ok({ Stage: "", Percent: 0, Completed: 0, Total: 0, Active: false }),
            },
            writable: true,
            configurable: true,
        });

        const load = view.LoadOutdatedPackagesAsync(true);
        await waitForAsync(() => started);
        (view as unknown as { _mutationEpoch: number })._mutationEpoch += 1;
        release();
        await load;

        assert.strictEqual(view.packages.length, 0, 'a pre-mutation scan must not be painted');
    });

    test('a forced load starts one job and the following update starts none', async () => {
        const requests: GetOutdatedPackagesRequest[] = [];
        Object.defineProperty(registrations, 'hostApi', {
            value: {
                startOutdatedScanAsync: async (request: GetOutdatedPackagesRequest) => {
                    requests.push(request);
                    return ok({ JobId: 'job-forced' });
                },
                getJobAsync: async () => ok({
                    Kind: 'outdatedScan',
                    State: 'completed',
                    Stage: 'Completed',
                    Percent: 100,
                    Response: { Packages: [] },
                }),
                getOutdatedPackagesAsync: async () => ok({ Packages: [] }),
                updateBadgeAsync: async () => ok(undefined),
                getOutdatedScanProgressAsync: async () => ok({ Stage: "", Percent: 0, Completed: 0, Total: 0, Active: false }),
            },
            writable: true,
            configurable: true,
        });

        view.projectPaths = ['/ws/A.csproj'];
        await view.LoadOutdatedPackagesAsync(true);
        assert.strictEqual(requests.length, 1, 'a forced load is exactly one job');
        assert.strictEqual(requests[0]!.ForceReload, true, 'the forced load bypasses the host cache');

        // The host update that follows used to differ from the args the run started with, which
        // aborted the in-flight request and started a second one.
        document.body.appendChild(view);
        try {
            await view.updateComplete;
            await view.updateComplete;
            assert.strictEqual(view.hasUpdated, true, 'the update cycle that checks the task args really ran');
            assert.strictEqual(requests.length, 1, 'a re-render must not restart the scan');
        } finally {
            document.body.removeChild(view);
        }
    });

    test('renders no error card when the job was cancelled', async () => {
        Object.defineProperty(registrations, 'hostApi', {
            value: {
                startOutdatedScanAsync: async () => ok({ JobId: 'job-cancelled' }),
                getJobAsync: async () => ok({
                    Kind: 'outdatedScan',
                    State: 'cancelled',
                    Stage: 'Cancelled',
                    Percent: 0,
                }),
                getOutdatedPackagesAsync: async () => ok({ Packages: [] }),
                updateBadgeAsync: async () => ok(undefined),
                getOutdatedScanProgressAsync: async () => ok({ Stage: "", Percent: 0, Completed: 0, Total: 0, Active: false }),
            },
            writable: true,
            configurable: true,
        });

        await view.LoadOutdatedPackagesAsync(true);

        const host = document.createElement('div');
        render(view.render() as TemplateResult, host);
        assert.doesNotMatch(host.textContent ?? '', /Failed to check for updates/);
    });

    test('polls the scan job and paints its stage into the existing banner', async () => {
        let polls = 0;
        const seenStages: string[] = [];
        Object.defineProperty(registrations, 'hostApi', {
            value: {
                startOutdatedScanAsync: async () => ok({ JobId: 'job-progress' }),
                getJobAsync: async () => {
                    polls += 1;
                    if (polls === 1) {
                        return ok({
                            Kind: 'outdatedScan',
                            State: 'running',
                            Stage: 'Parsing projects (1/2)…',
                            Percent: 20,
                        });
                    }
                    // The job's last progress has already reached the banner by the next poll.
                    seenStages.push(view.scanProgress?.Stage ?? '');
                    return ok({
                        Kind: 'outdatedScan',
                        State: 'completed',
                        Stage: 'Completed',
                        Percent: 100,
                        Response: { Packages: [] },
                    });
                },
                getOutdatedPackagesAsync: async () => ok({ Packages: [] }),
                updateBadgeAsync: async () => ok(undefined),
                getOutdatedScanProgressAsync: async () => ok({ Stage: "", Percent: 0, Completed: 0, Total: 0, Active: false }),
            },
            writable: true,
            configurable: true,
        });

        await view.LoadOutdatedPackagesAsync(true);

        assert.ok(polls >= 2, 'the view polls the job until it settles');
        assert.strictEqual(seenStages[0], 'Parsing projects (1/2)…');
        assert.strictEqual(view.scanProgress, null, 'the banner is cleared once the scan is over');
    });

    test('renders the host message when the job really failed', async () => {
        Object.defineProperty(registrations, 'hostApi', {
            value: {
                startOutdatedScanAsync: async () => ok({ JobId: 'job-failed' }),
                getJobAsync: async () => ok({
                    Kind: 'outdatedScan',
                    State: 'failed',
                    Stage: 'Failed',
                    Percent: 30,
                    Error: 'NuGet feed unreachable',
                }),
                getOutdatedPackagesAsync: async () => ok({ Packages: [] }),
                updateBadgeAsync: async () => ok(undefined),
                getOutdatedScanProgressAsync: async () => ok({ Stage: "", Percent: 0, Completed: 0, Total: 0, Active: false }),
            },
            writable: true,
            configurable: true,
        });

        await view.LoadOutdatedPackagesAsync(true);

        const host = document.createElement('div');
        render(view.render() as TemplateResult, host);
        const alert = host.querySelector('[role="alert"]');
        assert.ok(alert, 'a real failure keeps the alert card');
        assert.match(alert!.textContent ?? '', /Failed to check for updates/);
        assert.match(alert!.textContent ?? '', /NuGet feed unreachable/, 'the host message is kept for diagnosis');
    });

    test('emits the tree badge payload with the blocked count', () => {
        const emitted: Array<{ Count: number; BlockedCount: number }> = [];
        view.addEventListener('badge-changed', (e) => {
            emitted.push((e as CustomEvent<{ Count: number; BlockedCount: number }>).detail);
        });

        const raw = {
            Id: 'Pkg.Shared',
            InstalledVersion: '1.0.0',
            LatestVersion: '2.0.0',
            Projects: [{ Name: 'A', Path: '/ws/A.csproj', Version: '1.0.0' }],
            SourceUrl: 'https://api.nuget.org/v3/index.json',
            SourceName: 'nuget.org',
        };

        (view as unknown as {
            applyScan(response: unknown, fromCache: boolean): void;
        }).applyScan({
            Packages: [raw],
            BlockedPackages: [{
                Id: 'Blocked.Package',
                InstalledVersion: '1.0.0',
                BlockedVersion: '2.0.0',
                Reason: 'pinned',
                BlockedBy: [{ PackageId: 'Pinned.Package', InstalledVersion: '1.0.0', Range: '[1.0.0]' }],
            }],
        }, false);

        assert.deepStrictEqual(emitted, [{ Count: 1, BlockedCount: 1 }]);
    });

    test('updates the visible stage and counts from the scan progress RPC', async () => {
        Object.defineProperty(registrations, 'hostApi', {
            value: {
                getOutdatedScanProgressAsync: async () => ok({
                    Stage: 'Checking latest versions (3/10)…',
                    Percent: 48,
                    Completed: 3,
                    Total: 10,
                    Active: true,
                }),
            },
            writable: true,
            configurable: true,
        });

        (view as unknown as { _activeScanId: string })._activeScanId = 'scan-1';
        await (view as unknown as { refreshScanProgressAsync(id: string): Promise<void> })
            .refreshScanProgressAsync('scan-1');

        assert.deepStrictEqual(view.scanProgress, {
            Stage: 'Checking latest versions (3/10)…',
            Percent: 48,
            Completed: 3,
            Total: 10,
        });
    });

    test('ignores progress reported for a superseded scan', async () => {
        let polled = false;
        Object.defineProperty(registrations, 'hostApi', {
            value: {
                getOutdatedScanProgressAsync: async () => {
                    polled = true;
                    return ok({ Stage: 'stale', Percent: 60, Completed: 6, Total: 10, Active: true });
                },
            },
            writable: true,
            configurable: true,
        });

        (view as unknown as { _activeScanId: string })._activeScanId = 'scan-2';
        await (view as unknown as { refreshScanProgressAsync(id: string): Promise<void> })
            .refreshScanProgressAsync('scan-1');

        assert.strictEqual(polled, false);
        assert.strictEqual(view.scanProgress, null);
    });
});
