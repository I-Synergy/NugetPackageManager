import '@/web/web-setup';
import * as assert from 'assert';
import { VulnerabilitiesView } from '@/web/components/vulnerabilities-view';
import { VulnerablePackageViewModel } from '@/web/types';
import { render, type TemplateResult } from 'lit';
import { ok } from '@/common/rpc/result';
import * as registrations from '@/web/registrations';
import type { HostAPI } from '@/common/rpc/types';

function vulnerableModel(overrides: Partial<VulnerablePackage> = {}): VulnerablePackageViewModel {
    return new VulnerablePackageViewModel({
        Id: 'Vuln.Package',
        InstalledVersion: '1.0.0',
        Severity: 3,
        AdvisoryUrl: 'https://example.com/advisory',
        AffectedVersionRange: '<=1.0.0',
        Projects: [{ Name: 'A', Path: '/ws/A.csproj' }],
        CpmFrameworks: ['net8.0'],
        IsTransitive: true,
        DependencyOf: [],
        ...overrides,
    });
}

suite('VulnerabilitiesView', () => {
    let view: VulnerabilitiesView;
    let originalHostApi: HostAPI;

    setup(() => {
        originalHostApi = registrations.hostApi;
        view = new VulnerabilitiesView();
    });

    teardown(() => {
        Object.defineProperty(registrations, 'hostApi', {
            value: originalHostApi,
            writable: true,
            configurable: true,
        });
    });

    test('renders each card through <package-row> with the severity badge slotted', () => {
        view.packages = [vulnerableModel()];

        const host = document.createElement('div');
        render(view.render() as TemplateResult, host);

        assert.ok(host.querySelector('package-row'), 'the card uses <package-row>');

        const severity = host.querySelector('.severity-badge');
        assert.ok(severity, 'the severity badge is rendered');
        assert.strictEqual(severity!.getAttribute('slot'), 'leading');
        assert.strictEqual(severity!.textContent?.trim(), 'Critical');

        const advisory = host.querySelector('.advisory-link');
        assert.ok(advisory, 'the advisory link is rendered');
        assert.strictEqual(advisory!.getAttribute('slot'), 'actions');

        // No legacy standalone header markup remains.
        assert.strictEqual(host.querySelector('.row-header'), null);
        assert.strictEqual(host.querySelector('.package-name'), null);
    });

    test('a forced load issues one request and the following update issues none', async () => {
        const requests: Array<{ ForceReload?: boolean }> = [];
        Object.defineProperty(registrations, 'hostApi', {
            value: {
                getVulnerablePackagesAsync: async (request: { ForceReload?: boolean }) => {
                    requests.push(request);
                    return ok({ Packages: [] });
                },
            },
            writable: true,
            configurable: true,
        });

        view.projectPaths = ['/ws/A.csproj'];
        await view.LoadVulnerablePackagesAsync(true);
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
});
