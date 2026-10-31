import '../web-setup';
import * as assert from 'assert';
import { ActionableError } from '@/web/components/actionable-error';
import { ok } from '@/common/rpc/result';
import * as registrations from '@/web/registrations';
import type { HostAPI } from '@/common/rpc/types';

suite('ActionableError Component', () => {
    let originalHostApi: HostAPI;
    let copyCalls = 0;
    let fixCalls: Array<{ ProjectPath: string; PackageId: string; Version: string }> = [];

    setup(() => {
        originalHostApi = registrations.hostApi;
        copyCalls = 0;
        fixCalls = [];
        const mockHostApi: Partial<HostAPI> = {
            runToolchainDiagnosticsAsync: async () => {
                copyCalls += 1;
                return ok({ Report: '--- toolchain report ---' });
            },
            fixRestoreConflictAsync: async (request) => {
                fixCalls.push({
                    ProjectPath: request.ProjectPath,
                    PackageId: request.PackageId,
                    Version: request.Version,
                });
                return ok({ Applied: true });
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

    const failure = {
        Kind: 'WorkloadManifestConflict' as const,
        Summary: 'The .NET SDK 11.0.100-rc.3 on this machine has conflicting workload manifests.',
        Hint: 'Run `dotnet workload update`.',
        Detail: 'error MSB4242: SDK Resolver Failure',
    };

    test('renders the summary and the hint, not the raw output', async () => {
        const element = new ActionableError();
        element.failure = failure;
        document.body.appendChild(element);
        await element.updateComplete;

        const text = element.shadowRoot!.textContent ?? '';
        assert.match(text, /conflicting workload manifests/);
        assert.match(text, /dotnet workload update/);
        assert.strictEqual(element.shadowRoot!.querySelector('pre'), null);

        element.remove();
    });

    test('toggles the raw output', async () => {
        const element = new ActionableError();
        element.failure = failure;
        document.body.appendChild(element);
        await element.updateComplete;

        (element.shadowRoot!.querySelectorAll('button')[1] as HTMLButtonElement).click();
        await element.updateComplete;

        const pre = element.shadowRoot!.querySelector('pre');
        assert.ok(pre);
        assert.match(pre!.textContent ?? '', /MSB4242/);

        element.remove();
    });

    test('copy diagnostics asks the host for the toolchain report', async () => {
        const element = new ActionableError();
        element.failure = { ...failure, ProjectPath: 'd:/ws/App.csproj' };
        document.body.appendChild(element);
        await element.updateComplete;

        (element.shadowRoot!.querySelectorAll('button')[0] as HTMLButtonElement).click();
        await new Promise((resolve) => setTimeout(resolve, 10));

        assert.strictEqual(copyCalls, 1);
        element.remove();
    });

    test('pins a suggested conflict version through the host', async () => {
        const element = new ActionableError();
        element.failure = {
            ...failure,
            ProjectPath: 'd:/ws/App.csproj',
            Conflicts: [{
                Code: 'NU1107',
                PackageId: 'Microsoft.EntityFrameworkCore.Relational',
                SuggestedVersion: '11.0.0',
                Message: 'Version conflict detected',
                Chains: ['App -> Npgsql (= 11.0.0)'],
            }],
        };
        let restored = 0;
        element.addEventListener('restored', () => { restored += 1; });
        document.body.appendChild(element);
        await element.updateComplete;

        const button = Array.from(element.shadowRoot!.querySelectorAll('button')).find(
            (candidate) => (candidate.textContent ?? '').includes('Pin Microsoft.EntityFrameworkCore.Relational')
        ) as HTMLButtonElement;
        assert.ok(button, 'conflict action should be rendered');
        button.click();
        await new Promise((resolve) => setTimeout(resolve, 10));

        assert.deepStrictEqual(fixCalls, [{
            ProjectPath: 'd:/ws/App.csproj',
            PackageId: 'Microsoft.EntityFrameworkCore.Relational',
            Version: '11.0.0',
        }]);
        assert.strictEqual(restored, 1);
        assert.match(element.shadowRoot!.textContent ?? '', /restored successfully/);

        element.remove();
    });

    test('offers the advisory link from a vulnerability-audit failure', async () => {
        const opened: string[] = [];
        Object.defineProperty(registrations, 'hostApi', {
            value: {
                ...(registrations.hostApi as object),
                openUrlAsync: async (request: { Url: string }) => {
                    opened.push(request.Url);
                    return ok(undefined);
                },
            },
            writable: true,
            configurable: true,
        });

        const element = new ActionableError();
        element.failure = {
            Kind: 'VulnerabilityAudit',
            Summary: 'The vulnerability audit fails the build: SQLitePCLRaw.lib.e_sqlite3 2.1.11 (high).',
            Hint: 'Advisory: https://github.com/advisories/GHSA-2m69-gcr7-jv3q',
            Detail: '',
        };
        document.body.appendChild(element);
        await element.updateComplete;

        const button = Array.from(element.shadowRoot!.querySelectorAll('button')).find(
            (candidate) => (candidate.textContent ?? '').trim() === 'Open advisory'
        ) as HTMLButtonElement;
        assert.ok(button, 'the advisory link should be rendered');
        button.click();
        await new Promise((resolve) => setTimeout(resolve, 10));
        assert.deepStrictEqual(opened, ['https://github.com/advisories/GHSA-2m69-gcr7-jv3q']);

        element.remove();
    });

    test('renders nothing without a failure', async () => {
        const element = new ActionableError();
        document.body.appendChild(element);
        await element.updateComplete;

        assert.strictEqual(element.shadowRoot!.querySelector('.card'), null);
        element.remove();
    });
});
