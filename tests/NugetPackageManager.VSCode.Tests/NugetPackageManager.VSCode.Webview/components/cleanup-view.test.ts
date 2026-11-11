import '@/web/web-setup';
import * as assert from 'assert';
import { CleanupView } from '@/web/components/cleanup-view';
import { ok } from '@/common/rpc/result';
import * as registrations from '@/web/registrations';
import type { HostAPI } from '@/common/rpc/types';

/** Waits for an async UI effect instead of assuming a fixed delay. */
async function waitForAsync(predicate: () => boolean, timeoutMs = 2000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (!predicate() && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 5));
    }
}

suite('CleanupView Component', () => {
    let view: CleanupView;
    let originalHostApi: HostAPI;
    let cleanupCalls = 0;

    const report = {
        PropsFiles: [{
            Path: '/ws/Directory.Packages.props',
            Defined: ['Used.Package', 'Unused.One', 'Unused.Two'],
            Unused: ['Unused.One', 'Unused.Two'],
        }],
        Used: ['Used.Package'],
        Missing: [],
        Unused: ['Unused.One', 'Unused.Two'],
    };

    setup(() => {
        cleanupCalls = 0;
        originalHostApi = registrations.hostApi;
        Object.defineProperty(registrations, 'hostApi', {
            value: {
                getCleanupReportAsync: async () => ok(report),
                startCleanupAsync: async () => {
                    cleanupCalls++;
                    return ok({ JobId: 'job-cleanup' });
                },
                getJobAsync: async () => ok({
                    Kind: 'cleanup',
                    State: 'completed',
                    Stage: 'Completed',
                    Percent: 100,
                    Response: {
                        Report: { ...report, PropsFiles: [{ ...report.PropsFiles[0]!, Unused: [] }], Unused: [] },
                        Removed: ['Unused.One', 'Unused.Two'],
                        Backups: ['/ws/Directory.Packages.props.backup.test'],
                        Errors: [],
                    },
                }),
                showConfirmationAsync: async () => ok({ Confirmed: true }),
                getDependencyIssuesAsync: async () => ok({
                    Issues: [],
                    ProjectsScanned: 0,
                    ProjectsSkipped: 0,
                    SkippedProjectPaths: [],
                }),
            },
            writable: true,
            configurable: true,
        });
        view = new CleanupView();
        document.body.appendChild(view);
    });

    teardown(() => {
        document.body.removeChild(view);
        Object.defineProperty(registrations, 'hostApi', {
            value: originalHostApi,
            writable: true,
            configurable: true,
        });
    });

    test('hosts the transitive-duplicate section and adds it to the tab count', async () => {
        const counts: number[] = [];
        view.addEventListener('count-changed', (event) => {
            counts.push((event as CustomEvent<number>).detail);
        });

        await view.LoadCleanupReportAsync();
        await view.updateComplete;

        const section = view.shadowRoot!.querySelector('dependency-issues');
        assert.ok(section, 'the Cleanup tab should host dependency-issues');

        section!.dispatchEvent(new CustomEvent('dependency-count-changed', {
            detail: 3,
            bubbles: true,
            composed: true,
        }));

        await waitForAsync(() => counts.includes(5));
        assert.ok(counts.includes(2), 'unused entries alone are 2');
        assert.ok(counts.includes(5), 'badge includes 2 unused + 3 duplicates');
    });

    test('refresh reloads the report and the direct-reference analysis', async () => {
        let reportCalls = 0;
        Object.defineProperty(registrations, 'hostApi', {
            value: {
                getCleanupReportAsync: async () => {
                    reportCalls++;
                    return ok(report);
                },
                getDependencyIssuesAsync: async () => ok({
                    Issues: [],
                    ProjectsScanned: 0,
                    ProjectsSkipped: 0,
                    SkippedProjectPaths: [],
                }),
            },
            writable: true,
            configurable: true,
        });

        await view.LoadCleanupReportAsync();
        await view.updateComplete;

        const issues = view.shadowRoot!.querySelector('dependency-issues') as unknown as {
            reloadToken: number;
        };
        const tokenBefore = issues.reloadToken;

        const refresh = [...(view.shadowRoot?.querySelectorAll('button') ?? [])]
            .find((candidate) => candidate.textContent?.trim() === 'Refresh');
        assert.ok(refresh, 'Refresh button should be present');
        refresh.click();

        await waitForAsync(() => reportCalls >= 2 && issues.reloadToken > tokenBefore, 2000);
        assert.ok(reportCalls >= 2, 'the unused-entry report is reloaded');
        assert.ok(issues.reloadToken > tokenBefore, 'the direct-reference analysis is reloaded');
    });

    test('passes the scoped project list to the duplicate analysis', async () => {
        view.projectPaths = ['D:/ws/src/App/App.csproj'];
        await view.LoadCleanupReportAsync();
        await view.updateComplete;

        const section = view.shadowRoot!.querySelector('dependency-issues') as unknown as {
            projectPaths: string[];
        };
        assert.deepStrictEqual(section.projectPaths, ['D:/ws/src/App/App.csproj']);
    });

    test('renders unused packages grouped by props file', async () => {
        await view.LoadCleanupReportAsync();
        await view.updateComplete;

        const rows = view.shadowRoot?.querySelectorAll('.unused-row');
        assert.strictEqual(rows?.length, 2);
        assert.ok(view.shadowRoot?.textContent?.includes('Unused.One'));
        assert.ok(view.shadowRoot?.textContent?.includes('Unused.Two'));
    });

    test('keeps the header fixed and renders all content inside one scrollable body', async () => {
        await view.LoadCleanupReportAsync();
        await view.updateComplete;

        const container = view.shadowRoot!.querySelector('.cleanup-container');
        assert.ok(container, 'a cleanup container should render');
        assert.ok(container!.firstElementChild?.classList.contains('list-header'), '.list-header is a direct child of the container');

        const body = Array.from(container!.children).find((child) => child.classList.contains('cleanup-body'));
        assert.ok(body, '.cleanup-body is a direct child of the container');
        assert.ok(body!.querySelector('dependency-issues'), '.cleanup-body contains dependency-issues');
        assert.strictEqual(body!.querySelectorAll('.unused-row').length, 2);
        assert.strictEqual(body!.querySelector('.list-header'), null, '.list-header must stay outside .cleanup-body');
    });

    test('removes unused packages and emits completion', async () => {
        await view.LoadCleanupReportAsync();
        await view.updateComplete;

        let completed = false;
        view.addEventListener('cleanup-completed', () => { completed = true; });
        const button = [...(view.shadowRoot?.querySelectorAll('button') ?? [])]
            .find((candidate) => candidate.textContent?.includes('Remove unused'));
        assert.ok(button, 'Remove unused button should be present');
        button.click();
        await new Promise((resolve) => setTimeout(resolve, 50));
        await view.updateComplete;

        assert.strictEqual(cleanupCalls, 1);
        assert.strictEqual(completed, true);
        assert.ok(view.shadowRoot?.textContent?.includes('backup'));
    });
    test('cancels a running cleanup', async () => {
        await view.LoadCleanupReportAsync();
        await view.updateComplete;

        let running = true;
        const cancelled: string[] = [];
        Object.defineProperty(registrations, 'hostApi', {
            value: {
                getCleanupReportAsync: async () => ok(report),
                showConfirmationAsync: async () => ok({ Confirmed: true }),
                startCleanupAsync: async () => ok({ JobId: 'job-cleanup-cancel' }),
                getJobAsync: async () => running
                    ? ok({ Kind: 'cleanup', State: 'running', Stage: 'Cleaning Directory.Packages.props…', Percent: 40 })
                    : ok({ Kind: 'cleanup', State: 'cancelled', Stage: 'Cancelled', Percent: 40 }),
                cancelJobAsync: async ({ JobId }: { JobId: string }) => {
                    cancelled.push(JobId);
                    running = false;
                    return ok(undefined);
                },
            },
            writable: true,
            configurable: true,
        });

        const removeButton = [...(view.shadowRoot?.querySelectorAll('button') ?? [])]
            .find((candidate) => candidate.textContent?.includes('Remove unused'));
        assert.ok(removeButton, 'Remove unused button should be present');
        removeButton.click();

        await waitForAsync(
            () => [...(view.shadowRoot?.querySelectorAll('button') ?? [])].some((b) => b.textContent?.trim() === 'Cancel')
        );
        const cancelButton = [...(view.shadowRoot?.querySelectorAll('button') ?? [])]
            .find((b) => b.textContent?.trim() === 'Cancel');
        assert.ok(cancelButton, 'a running cleanup offers a cancel button');
        cancelButton.click();

        await waitForAsync(() => cancelled.length > 0, 2000);
        assert.deepStrictEqual(cancelled, ['job-cleanup-cancel']);
        const state = view as unknown as { statusText: string };
        await waitForAsync(() => /cancelled/i.test(state.statusText), 2000);
    });


    // ---- used-but-not-defined (missing definitions) ----

    function missingReport(missing: unknown[]): unknown {
        return { PropsFiles: [], Used: [], Missing: missing, Unused: [] };
    }

    const notActionableEntry = {
        Id: 'Pkg.NoVersion',
        Version: '',
        Projects: ['/ws/App.csproj'],
        PropsFiles: [],
        Actionable: false,
        Reason: 'noVersion',
    };

    const actionableEntry = {
        Id: 'Pkg.Missing',
        Version: '2.0.0',
        Projects: ['/ws/App.csproj'],
        PropsFiles: ['/ws/Directory.Packages.props'],
        Actionable: true,
    };

    test('disables Add definitions when nothing is actionable', async () => {
        Object.defineProperty(registrations, 'hostApi', {
            value: {
                getCleanupReportAsync: async () => ok(missingReport([notActionableEntry])),
                getDependencyIssuesAsync: async () => ok({
                    Issues: [], ProjectsScanned: 0, ProjectsSkipped: 0, SkippedProjectPaths: [],
                }),
            },
            writable: true,
            configurable: true,
        });

        await view.LoadCleanupReportAsync();
        await view.updateComplete;

        const button = [...(view.shadowRoot?.querySelectorAll('button') ?? [])]
            .find((candidate) => candidate.textContent?.includes('Add definitions'));
        assert.ok(button, 'Add definitions button should be present');
        assert.strictEqual(button!.disabled, true, 'disabled when no entry is actionable');
    });

    test('renders the reason for a non-actionable entry', async () => {
        Object.defineProperty(registrations, 'hostApi', {
            value: {
                getCleanupReportAsync: async () => ok(missingReport([notActionableEntry])),
                getDependencyIssuesAsync: async () => ok({
                    Issues: [], ProjectsScanned: 0, ProjectsSkipped: 0, SkippedProjectPaths: [],
                }),
            },
            writable: true,
            configurable: true,
        });

        await view.LoadCleanupReportAsync();
        await view.updateComplete;

        assert.ok(view.shadowRoot?.textContent?.includes('No version found — add it manually'));
    });

    test('renders the nonCpmOnly reason and omits the file count when there are no props files', async () => {
        const nonCpmEntry = {
            Id: 'Pkg.Loose',
            Version: '1.0.0',
            Projects: ['/ws/App.csproj'],
            PropsFiles: [],
            Actionable: false,
            Reason: 'nonCpmOnly',
        };
        Object.defineProperty(registrations, 'hostApi', {
            value: {
                getCleanupReportAsync: async () => ok(missingReport([nonCpmEntry])),
                getDependencyIssuesAsync: async () => ok({
                    Issues: [], ProjectsScanned: 0, ProjectsSkipped: 0, SkippedProjectPaths: [],
                }),
            },
            writable: true,
            configurable: true,
        });

        await view.LoadCleanupReportAsync();
        await view.updateComplete;

        assert.ok(view.shadowRoot?.textContent?.includes('Used without CPM — no definition needed'));
        assert.strictEqual(
            view.shadowRoot?.querySelector('.file-name'),
            null,
            'no file count should render when the entry has no props files'
        );
    });

    test('shows the first using project name and a +N overflow hint', async () => {
        const multiProjectEntry = {
            Id: 'Pkg.Shared',
            Version: '1.2.3',
            Projects: ['/ws/src/App/App.csproj', '/ws/src/Lib/Lib.csproj'],
            PropsFiles: ['/ws/Directory.Packages.props'],
            Actionable: true,
        };
        Object.defineProperty(registrations, 'hostApi', {
            value: {
                getCleanupReportAsync: async () => ok(missingReport([multiProjectEntry])),
                getDependencyIssuesAsync: async () => ok({
                    Issues: [], ProjectsScanned: 0, ProjectsSkipped: 0, SkippedProjectPaths: [],
                }),
            },
            writable: true,
            configurable: true,
        });

        await view.LoadCleanupReportAsync();
        await view.updateComplete;

        const projectName = view.shadowRoot?.querySelector('.missing-row .project-name');
        assert.ok(projectName, 'a project label should render');
        assert.strictEqual(projectName!.textContent?.trim(), 'App.csproj +1');
        assert.strictEqual(
            projectName!.getAttribute('title'),
            '/ws/src/App/App.csproj\n/ws/src/Lib/Lib.csproj'
        );
    });

    test('confirms, runs the job, refreshes the report and reports status', async () => {
        let reportCalls = 0;
        let addCalls = 0;
        let confirmCalls = 0;
        Object.defineProperty(registrations, 'hostApi', {
            value: {
                getCleanupReportAsync: async () => {
                    reportCalls++;
                    return ok(missingReport([actionableEntry]));
                },
                showConfirmationAsync: async () => {
                    confirmCalls++;
                    return ok({ Confirmed: true });
                },
                startAddMissingDefinitionsAsync: async () => {
                    addCalls++;
                    return ok({ JobId: 'job-add' });
                },
                getJobAsync: async () => ok({
                    Kind: 'addMissingDefinitions',
                    State: 'completed',
                    Stage: 'Completed',
                    Percent: 100,
                    Response: {
                        Added: [{ Id: 'Pkg.Missing', Version: '2.0.0', PropsFile: '/ws/Directory.Packages.props' }],
                        ChangedFiles: ['/ws/Directory.Packages.props'],
                        Backups: ['/ws/Directory.Packages.props.backup.test'],
                        Skipped: [],
                    },
                }),
                getDependencyIssuesAsync: async () => ok({
                    Issues: [], ProjectsScanned: 0, ProjectsSkipped: 0, SkippedProjectPaths: [],
                }),
            },
            writable: true,
            configurable: true,
        });

        await view.LoadCleanupReportAsync();
        await view.updateComplete;

        let completed = false;
        view.addEventListener('cleanup-completed', () => { completed = true; });

        const button = [...(view.shadowRoot?.querySelectorAll('button') ?? [])]
            .find((candidate) => candidate.textContent?.includes('Add definitions'));
        assert.ok(button);
        button!.click();

        await waitForAsync(() => addCalls === 1 && reportCalls >= 2, 2000);
        assert.strictEqual(confirmCalls, 1, 'a confirmation is shown');
        assert.strictEqual(addCalls, 1, 'the job is started');
        assert.ok(reportCalls >= 2, 'the report is refreshed');
        assert.strictEqual(completed, true, 'cleanup-completed is dispatched');

        const state = view as unknown as { statusText: string };
        assert.match(state.statusText, /Added 1 definition/);
        assert.match(state.statusText, /backup/);
    });

    test('offers a per-row Add button for actionable entries', async () => {
        Object.defineProperty(registrations, 'hostApi', {
            value: {
                getCleanupReportAsync: async () => ok(missingReport([actionableEntry, notActionableEntry])),
                getDependencyIssuesAsync: async () => ok({
                    Issues: [], ProjectsScanned: 0, ProjectsSkipped: 0, SkippedProjectPaths: [],
                }),
            },
            writable: true,
            configurable: true,
        });

        await view.LoadCleanupReportAsync();
        await view.updateComplete;

        const rows = view.shadowRoot?.querySelectorAll('.missing-row');
        assert.strictEqual(rows?.length, 2);
        const addRowButtons = [...(view.shadowRoot?.querySelectorAll('.missing-row button') ?? [])];
        assert.strictEqual(addRowButtons.length, 1, 'only the actionable row offers Add');
    });
});
