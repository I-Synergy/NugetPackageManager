import '@/web/web-setup';
import * as assert from 'assert';
import { DependencyIssues } from '@/web/components/dependency-issues';
import { ok } from '@/common/rpc/result';
import * as registrations from '@/web/registrations';
import type { HostAPI, DependencyIssue } from '@/common/rpc/types';

const redundant: DependencyIssue = {
    ProjectPath: 'd:/ws/App.csproj',
    Tfm: 'net10.0',
    PackageId: 'NodaTime',
    DirectVersion: '3.3.7',
    ResolvedVersion: '3.3.7',
    Kind: 'Redundant',
    Chain: 'I-Synergy.Framework.Core -> NodaTime',
};

const pinned: DependencyIssue = {
    ...redundant,
    PackageId: 'System.Text.Json',
    DirectVersion: '10.0.0',
    Kind: 'Pinned',
    Chain: 'I-Synergy.Framework.Core -> System.Text.Json',
};

async function waitForAsync(predicate: () => boolean, timeoutMs = 2000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (!predicate() && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 5));
    }
}

suite('DependencyIssues Component', () => {
    let originalHostApi: HostAPI;
    let mockHostApi: Partial<HostAPI>;
    let updateRequests: Array<{ Type: string; PackageId: string }> = [];
    let requestedPaths: string[] = [];

    setup(() => {
        originalHostApi = registrations.hostApi;
        updateRequests = [];
        requestedPaths = [];

        mockHostApi = {
            getDependencyIssuesAsync: async (request) => {
                requestedPaths = request.ProjectPaths ?? [];
                return ok({
                Issues: [redundant, pinned],
                ProjectsScanned: 1,
                ProjectsSkipped: 0,
                SkippedProjectPaths: [],
                });
            },
            restoreProjectsAsync: async () => ok(undefined),
            startProjectUpdateAsync: async (request) => {
                updateRequests.push({ Type: request.Type, PackageId: request.PackageId });
                return ok({ JobId: 'job-1' });
            },
            getJobAsync: async () => ok({
                Kind: 'projectUpdate',
                State: 'completed',
                Stage: 'Completed',
                Percent: 100,
                Response: {
                    Project: { Name: 'App', Path: 'd:/ws/App.csproj', Packages: [], CpmEnabled: false },
                    IsCpmEnabled: false,
                },
            }),
            showConfirmationAsync: async () => ok({ Confirmed: true }),
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

    test('summarises the issues and separates pinned references', async () => {
        const element = new DependencyIssues();
        element.projectPaths = ['d:/ws/App.csproj'];
        document.body.appendChild(element);
        await waitForAsync(() => (element.shadowRoot?.textContent ?? '').includes('transitively'));

        const text = element.shadowRoot!.textContent ?? '';
        assert.deepStrictEqual(requestedPaths, ['d:/ws/App.csproj']);
        assert.match(text, /2 direct references also arrive transitively/);
        assert.match(text, /1 removable · 1 pinned/);

        (element.shadowRoot!.querySelector('.header') as HTMLButtonElement).click();
        await element.updateComplete;

        const rows = element.shadowRoot!.querySelectorAll('.issue');
        assert.strictEqual(rows.length, 2);
        assert.strictEqual(element.shadowRoot!.querySelectorAll('.issue button').length, 1, 'pinned rows are not removable');
        assert.match(element.shadowRoot!.textContent ?? '', /pinned — kept/);

        element.remove();
    });

    test('reports the removable count under its own event', async () => {
        const element = new DependencyIssues();
        element.projectPaths = ['d:/ws/App.csproj'];
        const counts: number[] = [];
        element.addEventListener('dependency-count-changed', (event) => {
            counts.push((event as CustomEvent<number>).detail);
        });
        document.body.appendChild(element);
        await waitForAsync(() => counts.length > 0);

        assert.deepStrictEqual(counts, [1], 'only the redundant reference is removable');
        element.remove();
    });

    test('restores unrestored projects once, then analyses them', async () => {
        let calls = 0;
        const restored: string[][] = [];
        const signals: Array<AbortSignal | undefined> = [];
        (mockHostApi.getDependencyIssuesAsync as unknown) = async () => {
            calls++;
            return ok(calls === 1
                ? {
                    Issues: [],
                    ProjectsScanned: 0,
                    ProjectsSkipped: 1,
                    SkippedProjectPaths: ['d:/ws/New.csproj'],
                }
                : {
                    Issues: [redundant],
                    ProjectsScanned: 1,
                    ProjectsSkipped: 0,
                    SkippedProjectPaths: [],
                });
        };
        (mockHostApi.restoreProjectsAsync as unknown) = async (
            request: { ProjectPaths: string[] },
            signal?: AbortSignal
        ) => {
            restored.push(request.ProjectPaths);
            signals.push(signal);
            return ok(undefined);
        };

        const element = new DependencyIssues();
        element.projectPaths = ['d:/ws/New.csproj'];
        document.body.appendChild(element);
        await waitForAsync(() => (element.shadowRoot?.textContent ?? '').includes('NodaTime'));

        assert.deepStrictEqual(restored, [['d:/ws/New.csproj']]);
        assert.deepStrictEqual(signals, [undefined],
            'the restore must not be tied to the analysis task signal');
        assert.strictEqual(calls, 2, 'analysis runs again after the restore');
        assert.match(element.shadowRoot!.textContent ?? '', /also arrives? transitively/);

        element.remove();
    });

    test('restores every skipped project in bounded batches', async () => {
        const skippedPaths = Array.from({ length: 25 }, (_, index) => `d:/ws/P${index}.csproj`);
        const batches: string[][] = [];
        let calls = 0;
        (mockHostApi.getDependencyIssuesAsync as unknown) = async () => {
            calls++;
            return ok(calls === 1
                ? {
                    Issues: [],
                    ProjectsScanned: 0,
                    ProjectsSkipped: skippedPaths.length,
                    SkippedProjectPaths: skippedPaths,
                }
                : {
                    Issues: [redundant],
                    ProjectsScanned: 1,
                    ProjectsSkipped: 0,
                    SkippedProjectPaths: [],
                });
        };
        (mockHostApi.restoreProjectsAsync as unknown) = async (request: { ProjectPaths: string[] }) => {
            batches.push(request.ProjectPaths);
            return ok(undefined);
        };

        const element = new DependencyIssues();
        element.projectPaths = ['d:/ws/App.csproj'];
        document.body.appendChild(element);
        await waitForAsync(() => (element.shadowRoot?.textContent ?? '').includes('NodaTime'));

        assert.deepStrictEqual(batches.map((batch) => batch.length), [20, 5]);
        assert.deepStrictEqual(batches.flat(), skippedPaths, 'every skipped project is restored');

        element.remove();
    });

    test('surfaces a restore failure with a retry action', async () => {
        (mockHostApi.getDependencyIssuesAsync as unknown) = async () => ok({
            Issues: [],
            ProjectsScanned: 0,
            ProjectsSkipped: 1,
            SkippedProjectPaths: ['d:/ws/New.csproj'],
        });
        (mockHostApi.restoreProjectsAsync as unknown) = async () => ({
            ok: false as const,
            error: 'restore failed',
        });

        const element = new DependencyIssues();
        element.projectPaths = ['d:/ws/New.csproj'];
        document.body.appendChild(element);
        await waitForAsync(() => (element.shadowRoot?.textContent ?? '').includes('restore failed'));

        assert.match(element.shadowRoot!.textContent ?? '', /Restoring 1 project\(s\) failed/);
        const retry = Array.from(element.shadowRoot!.querySelectorAll('button')).find(
            (candidate) => (candidate.textContent ?? '').trim() === 'Restore again'
        );
        assert.ok(retry, 'a retry action should be offered');

        element.remove();
    });

    test('offers a remove-all action in the header for non-pinned references', async () => {
        const element = new DependencyIssues();
        element.projectPaths = ['d:/ws/App.csproj'];
        document.body.appendChild(element);
        await waitForAsync(() => (element.shadowRoot?.textContent ?? '').includes('transitively'));

        // The bulk action lives in the card header, so it is reachable without expanding
        // the (possibly very long) issue list.
        const action = element.shadowRoot!.querySelector('.card-header .bulk-action') as HTMLButtonElement;
        assert.ok(action, 'the header should offer a remove-all action');
        assert.match(action.textContent ?? '', /Remove all non-pinned \(1\)/);
        assert.strictEqual(element.shadowRoot!.querySelectorAll('.issue').length, 0,
            'the action is visible while the list is collapsed');

        action.click();
        await waitForAsync(() => updateRequests.length > 0);
        await waitForAsync(() => (element.shadowRoot?.textContent ?? '').includes('Removed 1 redundant reference'));

        assert.deepStrictEqual(updateRequests, [{ Type: 'UNINSTALL', PackageId: 'NodaTime' }],
            'only the redundant reference is removed');
        element.remove();
    });

    test('removing a redundant reference runs the uninstall job and notifies', async () => {
        const element = new DependencyIssues();
        element.projectPaths = ['d:/ws/App.csproj'];
        let updated = 0;
        element.addEventListener('project-updated', () => { updated += 1; });
        document.body.appendChild(element);
        await waitForAsync(() => (element.shadowRoot?.textContent ?? '').includes('transitively'));

        (element.shadowRoot!.querySelector('.header') as HTMLButtonElement).click();
        await element.updateComplete;

        const remove = element.shadowRoot!.querySelector('.issue button') as HTMLButtonElement;
        remove.click();
        await waitForAsync(() => updateRequests.length > 0);
        await waitForAsync(() => updated > 0);

        assert.deepStrictEqual(updateRequests, [{ Type: 'UNINSTALL', PackageId: 'NodaTime' }]);
        assert.strictEqual(updated, 1);
        assert.match(element.shadowRoot!.textContent ?? '', /Removed the direct reference to NodaTime/);

        element.remove();
    });
});
