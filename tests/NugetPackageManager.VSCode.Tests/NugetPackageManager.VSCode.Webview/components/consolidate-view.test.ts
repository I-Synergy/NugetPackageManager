import '@/web/web-setup';
import * as assert from 'assert';
import { ConsolidateView } from '@/web/components/consolidate-view';
import { InconsistentPackageViewModel } from '@/web/types';
import { render, type TemplateResult } from 'lit';
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

suite('ConsolidateView', () => {
    let view: ConsolidateView;
    let mockHostApi: Partial<HostAPI>;
    let originalHostApi: HostAPI;

    function packageModel(condition: string, framework: string): InconsistentPackageViewModel {
        return new InconsistentPackageViewModel({
            Id: 'Pkg.Shared',
            Versions: [
                { Version: '1.0.0', Projects: [{ Name: 'A', Path: '/ws/A.csproj' }], CpmCondition: condition, CpmFramework: framework },
                { Version: '2.0.0', Projects: [{ Name: 'B', Path: '/ws/B.csproj' }], CpmCondition: condition, CpmFramework: framework },
            ],
            LatestInstalledVersion: '2.0.0',
            CpmManaged: true,
        });
    }

    setup(() => {
        originalHostApi = registrations.hostApi;
        mockHostApi = {
            startConsolidateAsync: async () => ok({ JobId: 'job-consolidate' }),
            getJobAsync: async () => ok({
                Kind: 'consolidate',
                State: 'completed',
                Stage: 'Completed',
                Percent: 100,
            }),
        };
        Object.defineProperty(registrations, 'hostApi', {
            value: mockHostApi,
            writable: true,
            configurable: true,
        });
        view = new ConsolidateView();
    });

    teardown(() => {
        Object.defineProperty(registrations, 'hostApi', {
            value: originalHostApi,
            writable: true,
            configurable: true,
        });
    });

    test('groups cards by framework line', () => {
        const shared = packageModel('', '');
        const net10 = packageModel("$(TargetFramework.StartsWith('net10.0'))", 'net10.0');
        const net11 = packageModel("$(TargetFramework.StartsWith('net11.0'))", 'net11.0');
        view.packages = [net11, shared, net10];

        const groups = (view as unknown as {
            groupedVisiblePackages: Array<{ label: string; packages: InconsistentPackageViewModel[] }>;
        }).groupedVisiblePackages;

        assert.deepStrictEqual(groups.map((group) => group.label), ['Shared', 'net10.0', 'net11.0']);
    });

    test('renders no group header when every card belongs to one framework line', () => {
        view.packages = [packageModel('', ''), packageModel('', '')];

        const host = document.createElement('div');
        render(view.render() as TemplateResult, host);

        assert.strictEqual(
            host.querySelectorAll('.group-header').length,
            0,
            'a single framework line has nothing to separate, so it gets no header'
        );
        assert.strictEqual(host.querySelectorAll('.package-list package-row').length, 2, 'the cards still render');
    });

    test('sends only the selected framework line when a card contains two lines', async () => {
        const calls: Array<{ CpmCondition?: string; Scope?: string; ProjectPaths: string[] }> = [];
        mockHostApi.startConsolidateAsync = async (req) => {
            calls.push(req as { CpmCondition?: string; Scope?: string; ProjectPaths: string[] });
            return ok({ JobId: 'job-consolidate' });
        };

        const mixed = new InconsistentPackageViewModel({
            Id: 'Pkg.Mixed',
            Versions: [
                { Version: '1.0.0', Projects: [{ Name: 'A', Path: '/ws/A.csproj' }], CpmCondition: 'net10', CpmFramework: 'net10.0' },
                { Version: '2.0.0', Projects: [{ Name: 'B', Path: '/ws/B.csproj' }], CpmCondition: 'net11', CpmFramework: 'net11.0' },
            ],
            LatestInstalledVersion: '2.0.0',
            CpmManaged: true,
        });
        mixed.TargetVersion = '1.0.0';
        view.packages = [mixed];

        const success = await (view as unknown as { consolidateSingleAsync(p: InconsistentPackageViewModel): Promise<boolean> })
            .consolidateSingleAsync(mixed);

        assert.strictEqual(success, true);
        assert.strictEqual(calls.length, 1);
        assert.strictEqual(calls[0]!.CpmCondition, 'net10');
        assert.strictEqual(calls[0]!.Scope, 'group');
        assert.deepStrictEqual(calls[0]!.ProjectPaths, ['/ws/A.csproj']);
    });

    test('keeps same-condition cards for other frameworks', async () => {
        const net10 = packageModel('net', 'net10.0');
        const net11 = packageModel('net', 'net11.0');
        view.packages = [net10, net11];

        const success = await (view as unknown as { consolidateSingleAsync(p: InconsistentPackageViewModel): Promise<boolean> })
            .consolidateSingleAsync(net10);

        assert.strictEqual(success, true);
        assert.deepStrictEqual(view.packages, [net11]);
    });

    test('keeps the row and reports the error when consolidation fails', async () => {
        mockHostApi.getJobAsync = async () => ok({
            Kind: 'consolidate',
            State: 'failed',
            Stage: 'Failed',
            Percent: 0,
            Error: 'boom',
        });
        const pkg = packageModel('$(TargetFramework.StartsWith(\'net10.0\'))', 'net10.0');
        view.packages = [pkg];

        const success = await (view as unknown as { consolidateSingleAsync(p: InconsistentPackageViewModel): Promise<boolean> })
            .consolidateSingleAsync(pkg);

        assert.strictEqual(success, false);
        assert.strictEqual(view.packages.length, 1);
        assert.match((view as unknown as { statusText: string }).statusText, /boom/);
    });

    test('removes only the consolidated framework line', async () => {
        const net10 = packageModel('$(TargetFramework.StartsWith(\'net10.0\'))', 'net10.0');
        const net11 = packageModel('$(TargetFramework.StartsWith(\'net11.0\'))', 'net11.0');
        view.packages = [net10, net11];

        const success = await (view as unknown as { consolidateSingleAsync(p: InconsistentPackageViewModel): Promise<boolean> })
            .consolidateSingleAsync(net10);

        assert.strictEqual(success, true);
        assert.strictEqual(view.packages.length, 1);
        assert.strictEqual(view.packages[0]!.Versions[0]!.CpmCondition, net11.Versions[0]!.CpmCondition);
    });
    test('renders each card through <package-row> with the CPM badge slotted', () => {
        const pkg = packageModel('', 'net8.0');
        view.packages = [pkg];

        const host = document.createElement('div');
        render(view.render() as TemplateResult, host);

        assert.ok(host.querySelector('package-row'), 'the card uses <package-row>');
        const cpmBadge = host.querySelector('.cpm-badge');
        assert.ok(cpmBadge, 'the CPM badge is rendered');
        assert.strictEqual(cpmBadge!.getAttribute('slot'), 'badges');
        // The framework badge moves into the same badges slot.
        assert.strictEqual(host.querySelectorAll('package-row [slot="badges"]').length, 2);
        // No legacy standalone header markup remains.
        assert.strictEqual(host.querySelector('.package-name'), null);
    });

    test('a forced load issues one request and the following update issues none', async () => {
        const requests: Array<{ ForceReload?: boolean }> = [];
        mockHostApi.getInconsistentPackagesAsync = async (request) => {
            requests.push(request as { ForceReload?: boolean });
            return ok({ Packages: [] });
        };

        view.projectPaths = ['/ws/A.csproj'];
        await view.LoadInconsistentPackagesAsync(true);
        assert.strictEqual(requests.length, 1, 'a forced load is exactly one request');
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

    test('cancels a running consolidation from the card action', async () => {
        let running = true;
        const cancelled: string[] = [];
        mockHostApi.startConsolidateAsync = async () => ok({ JobId: 'job-consolidate-cancel' });
        mockHostApi.getJobAsync = async () => running
            ? ok({ Kind: 'consolidate', State: 'running', Stage: 'Writing package versions…', Percent: 60 })
            : ok({ Kind: 'consolidate', State: 'cancelled', Stage: 'Cancelled', Percent: 60 });
        mockHostApi.cancelJobAsync = async ({ JobId }: { JobId: string }) => {
            cancelled.push(JobId);
            running = false;
            return ok(undefined);
        };

        const pkg = packageModel('', '');
        view.packages = [pkg];

        const pending = (view as unknown as {
            consolidateSingleAsync(p: InconsistentPackageViewModel): Promise<boolean>;
        }).consolidateSingleAsync(pkg);

        const jobs = (view as unknown as { _jobIds: Map<string, string> })._jobIds;
        await waitForAsync(() => jobs.size > 0);

        const host = document.createElement('div');
        render(view.render() as TemplateResult, host);
        const cancelButton = Array.from(host.querySelectorAll('button'))
            .find((button) => (button.getAttribute('aria-label') ?? '').startsWith('Cancel consolidation'));
        assert.ok(cancelButton, 'a running consolidation offers a cancel button');
        cancelButton!.click();

        await waitForAsync(() => cancelled.length > 0, 2000);
        assert.deepStrictEqual(cancelled, ['job-consolidate-cancel']);
        assert.strictEqual(await pending, false);
    });

});
