import '@/web/web-setup';
import * as assert from 'assert';
import { ProjectRow } from '@/web/components/project-row';
import { ProjectViewModel } from '@/web/types';
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

suite('ProjectRow Component', () => {
    let projectRow: ProjectRow;
    let mockHostApi: Partial<HostAPI>;
    let originalHostApi: HostAPI;

    const createMockProject = (name: string, path: string, packages: { Id: string, Version: string, IsPinned?: boolean }[]): ProjectViewModel => {
        return new ProjectViewModel({
            Name: name,
            Path: path,
            Packages: packages.map(p => ({ ...p, IsPinned: p.IsPinned ?? false, VersionSource: "project" as VersionSource })),
            CpmEnabled: false,
        });
    };

    setup(() => {
        originalHostApi = registrations.hostApi;

        mockHostApi = {
            startProjectUpdateAsync: async () => ok({ JobId: 'job-project' }),
            getJobAsync: async () => ok({
                Kind: 'projectUpdate',
                State: 'completed',
                Stage: 'Completed',
                Percent: 100,
                Response: {
                    Project: {
                        Name: 'TestProject',
                        Path: 'path/to/project',
                        Packages: [],
                        CpmEnabled: false,
                    },
                    IsCpmEnabled: false,
                },
            }),
        };

        // Replace the module-level hostApi
        Object.defineProperty(registrations, 'hostApi', {
            value: mockHostApi,
            writable: true,
            configurable: true,
        });

        projectRow = new ProjectRow();
        projectRow.project = createMockProject('TestProject', 'path/to/project', [
            { Id: 'TestPackage', Version: '1.0.0' },
            { Id: 'OtherPackage', Version: '2.0.0' }
        ]);
        projectRow.packageId = 'TestPackage';
        projectRow.packageVersion = '1.0.0';

        document.body.appendChild(projectRow);
    });

    teardown(() => {
        document.body.removeChild(projectRow);
        Object.defineProperty(registrations, 'hostApi', {
            value: originalHostApi,
            writable: true,
            configurable: true,
        });
    });

    test('should render project name', async () => {
        await projectRow.updateComplete;
        const shadowRoot = projectRow.shadowRoot;
        const nameSpan = shadowRoot?.querySelector('.project-title .name');
        assert.strictEqual(nameSpan?.textContent, 'TestProject');
    });

    test('should show uninstall button when package is installed and version matches', async () => {
        projectRow.packageId = 'TestPackage';
        projectRow.packageVersion = '1.0.0';
        await projectRow.updateComplete;

        const shadowRoot = projectRow.shadowRoot;
        const uninstallIcon = shadowRoot?.querySelector('.icon-btn .codicon-diff-removed');
        assert.ok(uninstallIcon, 'Uninstall icon should be present');
    });

    test('should show update and uninstall buttons when version differs', async () => {
        projectRow.packageId = 'TestPackage';
        projectRow.packageVersion = '1.1.0';
        await projectRow.updateComplete;

        const shadowRoot = projectRow.shadowRoot;
        const updateIcon = shadowRoot?.querySelector('.icon-btn .codicon-arrow-circle-up');
        const uninstallIcon = shadowRoot?.querySelector('.icon-btn .codicon-diff-removed');

        assert.ok(updateIcon, 'Update icon should be present');
        assert.ok(uninstallIcon, 'Uninstall icon should be present');
    });

    test('should show install button when package is not installed', async () => {
        projectRow.packageId = 'NewPackage';
        projectRow.packageVersion = '1.0.0';
        await projectRow.updateComplete;

        const shadowRoot = projectRow.shadowRoot;
        const installIcon = shadowRoot?.querySelector('.icon-btn .codicon-diff-added');
        assert.ok(installIcon, 'Install icon should be present');
    });

    test('Install click should call hostApi.updateProject with INSTALL', async () => {
        projectRow.packageId = 'NewPackage';
        projectRow.packageVersion = '1.0.0';
        await projectRow.updateComplete;

        let calledWith: any;
        mockHostApi.startProjectUpdateAsync = async (req) => {
            calledWith = req;
            return ok({ JobId: 'job-install' });
        };

        const installButton = projectRow.shadowRoot?.querySelector('.icon-btn') as HTMLElement;
        installButton?.click();

        await new Promise(r => setTimeout(r, 50));

        assert.ok(calledWith, 'updateProject should have been called');
        assert.strictEqual(calledWith.Type, 'INSTALL');
        assert.strictEqual(calledWith.PackageId, 'NewPackage');
    });

    test('offers cancel while an update job is running', async () => {
        projectRow.packageId = 'NewPackage';
        projectRow.packageVersion = '1.0.0';
        await projectRow.updateComplete;

        let running = true;
        const cancelled: string[] = [];
        mockHostApi.startProjectUpdateAsync = async () => ok({ JobId: 'job-row' });
        mockHostApi.getJobAsync = async () => running
            ? ok({ Kind: 'projectUpdate', State: 'running', Stage: 'Restoring project…', Percent: 60 })
            : ok({ Kind: 'projectUpdate', State: 'cancelled', Stage: 'Cancelled', Percent: 60 });
        mockHostApi.cancelJobAsync = async ({ JobId }: { JobId: string }) => {
            cancelled.push(JobId);
            running = false;
            return ok(undefined);
        };

        const installButton = projectRow.shadowRoot?.querySelector('.icon-btn') as HTMLElement;
        installButton?.click();

        await waitForAsync(() => projectRow.shadowRoot?.querySelector('button[aria-label="Cancel"]') != null);
        const cancelButton = projectRow.shadowRoot?.querySelector('button[aria-label="Cancel"]') as HTMLElement;
        assert.ok(cancelButton, 'the busy row offers a cancel button');
        cancelButton.click();

        await waitForAsync(() => cancelled.length > 0, 2000);
        assert.deepStrictEqual(cancelled, ['job-row']);
        const row = projectRow as unknown as { errorMessage: string };
        await waitForAsync(() => /cancelled/i.test(row.errorMessage), 2000);
        assert.match(row.errorMessage, /rolled back/);
    });

    test('should emit project-updated event after successful update', async () => {
        projectRow.packageId = 'NewPackage';
        projectRow.packageVersion = '1.0.0';
        await projectRow.updateComplete;

        mockHostApi.getJobAsync = async () => ok({
            Kind: 'projectUpdate',
            State: 'completed',
            Stage: 'Completed',
            Percent: 100,
            Response: {
                Project: {
                    Name: 'TestProject',
                    Path: 'path/to/project',
                    Packages: [],
                    CpmEnabled: false,
                },
                IsCpmEnabled: true,
            },
        });

        let eventDetail: any;
        projectRow.addEventListener('project-updated', (e: any) => {
            eventDetail = e.detail;
        });

        const installButton = projectRow.shadowRoot?.querySelector('.icon-btn') as HTMLElement;
        installButton?.click();

        await new Promise(r => setTimeout(r, 50));

        assert.ok(eventDetail, 'project-updated event should have been dispatched');
        assert.strictEqual(eventDetail.isCpmEnabled, true);
    });
});
