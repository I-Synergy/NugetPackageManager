import '@/web/web-setup'; // Must be first
import * as assert from 'assert';
import * as sinon from 'sinon';
import { SettingsView } from '@/web/components/settings-view';
import * as registrations from '@/web/registrations';
import { configuration } from '@/web/registrations';
import { ok } from '@/common/rpc/result';
import type { HostAPI } from '@/common/rpc/types';

suite('SettingsView Component', () => {
    let view: SettingsView;
    let sandbox: sinon.SinonSandbox;
    let originalHostApi: HostAPI;
    let updateConfigurationStub: (request: Parameters<HostAPI['updateConfigurationAsync']>[0]) => Promise<unknown>;

    function baseConfiguration(allowMajorVersionOverride: boolean): Configuration {
        return {
            Prerelease: false,
            SkipRestore: false,
            EnablePackageVersionInlineInfo: false,
            StatusBarLoadingIndicator: false,
            AllowMajorVersionOverride: allowMajorVersionOverride,
            Sources: [{ Name: 'NuGet.org', Url: 'https://api.nuget.org/v3/index.json' }],
        };
    }

    function installMock(allowMajorVersionOverride: boolean): void {
        originalHostApi = registrations.hostApi;
        updateConfigurationStub = () => Promise.resolve(ok(undefined));

        const mockHostApi = {
            updateConfigurationAsync: (request: Parameters<HostAPI['updateConfigurationAsync']>[0]) =>
                updateConfigurationStub(request),
            getConfigurationAsync: () => Promise.resolve(ok({ Configuration: baseConfiguration(allowMajorVersionOverride) })),
            getToolchainHealthAsync: () => Promise.resolve({ ok: false as const, error: 'not under test' }),
        } as unknown as HostAPI;
        Object.defineProperty(registrations, 'hostApi', { value: mockHostApi, writable: true, configurable: true });

        (configuration as unknown as { configuration: Configuration }).configuration =
            baseConfiguration(allowMajorVersionOverride);
    }

    function overrideCheckbox(): HTMLInputElement {
        const labels = Array.from(view.shadowRoot?.querySelectorAll('label') ?? []);
        const label = labels.find((candidate) =>
            (candidate.textContent ?? '').includes('cross their target framework')
        );
        assert.ok(label, 'the allow-major-override label renders');
        const checkbox = label!.querySelector('input[type="checkbox"]') as HTMLInputElement | null;
        assert.ok(checkbox, 'the allow-major-override checkbox renders');
        return checkbox!;
    }

    setup(() => {
        sandbox = sinon.createSandbox();
        installMock(false);
        // The ConfigurationService dispatches a DOM Event on every UpdateLocal; the test's
        // EventTarget realm differs from the webview's, so that dispatch throws. Stub it and
        // assert the patch instead of relying on the DOM event.
        sandbox.stub(configuration, 'UpdateLocal');
        view = new SettingsView();
        document.body.appendChild(view);
    });

    teardown(() => {
        document.body.removeChild(view);
        Object.defineProperty(registrations, 'hostApi', { value: originalHostApi, writable: true, configurable: true });
        sandbox.restore();
    });

    test('reads the allow-major-override checkbox from configuration', async () => {
        (view as unknown as { allowMajorVersionOverride: boolean }).allowMajorVersionOverride = true;
        await view.updateComplete;
        assert.strictEqual(overrideCheckbox().checked, true);
    });

    test('toggling the allow-major-override checkbox persists the setting and updates local configuration', async () => {
        await view.updateComplete;

        let received: Parameters<HostAPI['updateConfigurationAsync']>[0] | undefined;
        updateConfigurationStub = (request) => {
            received = request;
            return Promise.resolve(ok(undefined));
        };

        const checkbox = overrideCheckbox();
        assert.strictEqual(checkbox.checked, false);

        checkbox.checked = true;
        checkbox.dispatchEvent(new Event('change', { bubbles: true }));

        await new Promise((resolve) => setTimeout(resolve, 0));

        assert.strictEqual((view as unknown as { allowMajorVersionOverride: boolean }).allowMajorVersionOverride, true);
        assert.ok(received, 'updateConfigurationAsync was called');
        assert.strictEqual(received!.Configuration.AllowMajorVersionOverride, true);
        assert.ok(
            (configuration.UpdateLocal as sinon.SinonStub).calledWithMatch({ AllowMajorVersionOverride: true }),
            'local configuration is updated with the new setting'
        );
    });
});
