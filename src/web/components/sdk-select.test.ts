import '../web-setup';
import * as assert from 'assert';
import { SdkSelect } from '@/web/components/sdk-select';
import { ok } from '@/common/rpc/result';
import * as registrations from '@/web/registrations';
import type { HostAPI, SetWorkspaceSdkRequest, InstallSdkRequest } from '@/common/rpc/types';

suite('SdkSelect Component', () => {
    let originalHostApi: HostAPI;
    let sdkRequests: Array<SetWorkspaceSdkRequest> = [];
    let installCalls: Array<InstallSdkRequest> = [];
    let confirmAnswer = false;

    setup(() => {
        originalHostApi = registrations.hostApi;
        sdkRequests = [];
        installCalls = [];
        confirmAnswer = false;

        const mockHostApi: Partial<HostAPI> = {
            setWorkspaceSdkAsync: async (request: SetWorkspaceSdkRequest) => {
                sdkRequests.push(request);
                return ok({ GlobalJsonPath: 'D:/ws/global.json', Version: request.Version, Notes: [] });
            },
            installSdkAsync: async (request: InstallSdkRequest) => {
                installCalls.push(request);
                return ok({ Installed: true, InstallRoot: '~/.dotnet', SdkVersion: request.Version });
            },
            showConfirmationAsync: async () => ok({ Confirmed: confirmAnswer }),
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

    test('lists the installed SDKs for global.json', async () => {
        const element = new SdkSelect();
        element.sdks = [
            { Version: '10.0.403', Path: 'C:/dotnet/sdk', Source: 'system' },
            { Version: '9.0.100', Path: '~/.dotnet/sdk', Source: 'private' },
        ];
        element.selected = '10.0.403';
        document.body.appendChild(element);
        await element.updateComplete;

        const dropdown = element.shadowRoot!.querySelector('custom-dropdown') as unknown as {
            options: Array<{ value: string; label: string }>;
        };
        assert.deepStrictEqual(dropdown.options.map((option) => option.value), ['10.0.403', '9.0.100']);
        assert.match(dropdown.options[1]!.label, /installed by extension/);

        element.remove();
    });

    test('selecting a version writes it into global.json and notifies', async () => {
        const element = new SdkSelect();
        element.sdks = [{ Version: '10.0.403', Path: 'C:/dotnet/sdk', Source: 'system' }];
        element.selected = '9.0.320';
        element.projectPaths = ['d:/ws/App.csproj'];
        document.body.appendChild(element);
        await element.updateComplete;

        let changed = 0;
        element.addEventListener('sdk-changed', () => { changed += 1; });

        const dropdown = element.shadowRoot!.querySelector('custom-dropdown')!;
        dropdown.dispatchEvent(new CustomEvent('change', { detail: '10.0.403', bubbles: true, composed: true }));
        await new Promise((resolve) => setTimeout(resolve, 10));

        assert.deepStrictEqual(sdkRequests, [
            { Version: '10.0.403', ProjectPaths: ['d:/ws/App.csproj'] },
        ]);
        assert.strictEqual(changed, 1);
        assert.match(element.shadowRoot!.textContent ?? '', /global\.json updated/);

        element.remove();
    });

    test('selecting the current pin does not write anything', async () => {
        const element = new SdkSelect();
        element.sdks = [{ Version: '10.0.403', Path: 'C:/dotnet/sdk', Source: 'system' }];
        element.selected = '10.0.403';
        document.body.appendChild(element);
        await element.updateComplete;

        const dropdown = element.shadowRoot!.querySelector('custom-dropdown')!;
        dropdown.dispatchEvent(new CustomEvent('change', { detail: '10.0.403', bubbles: true, composed: true }));
        await new Promise((resolve) => setTimeout(resolve, 10));

        assert.deepStrictEqual(sdkRequests, []);
        element.remove();
    });

    test('offers to install a pinned SDK that is missing, and only after confirmation', async () => {
        const element = new SdkSelect();
        element.sdks = [{ Version: '10.0.403', Path: 'C:/dotnet/sdk', Source: 'system' }];
        element.recommended = '10.0.403';
        document.body.appendChild(element);
        await element.updateComplete;

        // Already installed: no install button.
        assert.strictEqual(element.shadowRoot!.querySelectorAll('button').length, 0);

        element.recommended = '9.0.100';
        await element.updateComplete;
        const installButton = element.shadowRoot!.querySelector('button') as HTMLButtonElement;
        assert.match(installButton.textContent ?? '', /Install 9\.0\.100/);

        // Declined confirmation must not install.
        installButton.click();
        await new Promise((resolve) => setTimeout(resolve, 10));
        assert.deepStrictEqual(installCalls, []);

        confirmAnswer = true;
        element.shadowRoot!.querySelector('button')!.dispatchEvent(new MouseEvent('click'));
        await new Promise((resolve) => setTimeout(resolve, 10));

        assert.deepStrictEqual(installCalls, [{ Version: '9.0.100' }]);
        element.remove();
    });
});
