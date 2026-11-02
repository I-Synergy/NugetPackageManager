import '@/web/web-setup';
import * as assert from 'assert';
import { VulnerabilitiesView } from '@/web/components/vulnerabilities-view';
import { VulnerablePackageViewModel } from '@/web/types';
import { render, type TemplateResult } from 'lit';

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

    setup(() => {
        view = new VulnerabilitiesView();
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
});
