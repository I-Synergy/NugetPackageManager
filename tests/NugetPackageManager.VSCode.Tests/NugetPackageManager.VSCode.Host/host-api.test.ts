import * as assert from 'assert';
import * as sinon from 'sinon';
import * as vscode from 'vscode';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { repositoryPath } from '../test-paths';
import { createHostAPI } from '@/host/host-api';
import nugetApiFactory from '@/host/nuget/api-factory';
import coreProcess from '@/host/nuget/core-process';
import NuGetConfigResolver from '@/host/utilities/nuget-config-resolver';
import CpmResolver from '@/host/utilities/cpm-resolver';
import TaskExecutorDefault, { DotnetError } from '@/host/utilities/task-executor';
import { OperationJobs } from '@/host/utilities/operation-jobs';
import type { Result } from '@/common/rpc/result';
import type { GetJobResponse } from '@/common/rpc/types';
import { Logger } from '@/common/logger';

function fixturesRoot(): string {
    return repositoryPath('tests', '__fixtures__');
}

/**
 * Routes the core's `getProjects` call. The host sends every path in one request and the core
 * skips projects it cannot read, so `resolve` returns null for an unreadable project.
 */
/**
 * Routes the core's calls for the host tests.
 *
 * `getProjects` is answered by whichever resolver the test installs with `useProjects`.
 * The write methods are bridged to the TypeScript writer here only so the orchestration tests
 * (rollback, job state, conflict attribution) can assert what landed on disk; in production the
 * core does the writing, and its behaviour is pinned by the golden files in
 * `tests/__fixtures__/cpm/expected`.
 */
let projectResolver: ((projectPath: string) => Project | null) | null = null;

function installCoreStub(sandbox: sinon.SinonSandbox): sinon.SinonStub {
    projectResolver = null;

    return sandbox.stub(coreProcess, 'CallAsync').callsFake((async (
        method: string,
        params: Record<string, never>
    ) => {
        switch (method) {
            case 'getProjects': {
                const projects: Project[] = [];
                for (const projectPath of (params as unknown as { projectPaths?: string[] }).projectPaths ?? []) {
                    const project = projectResolver?.(projectPath) ?? null;
                    if (project) projects.push(project);
                }

                return projects;
            }

            case 'updateCpmVersions': {
                const request = params as unknown as {
                    propsFilePath: string;
                    changes: Array<{ packageId: string; version: string; condition?: string; scope?: 'group' | 'unconditional' | 'all' | 'first' }>;
                };
                await CpmResolver.UpdateCpmVersionsAsync(request.propsFilePath, request.changes);
                return { applied: request.changes.length };
            }

            case 'removePackageVersion': {
                const request = params as unknown as { propsFilePath: string; packageId: string };
                return { removed: await CpmResolver.RemovePackageVersionAsync(request.propsFilePath, request.packageId) };
            }

            case 'updatePackageVersion': {
                const request = params as unknown as {
                    projectPath: string;
                    packageId: string;
                    version: string;
                    condition?: string;
                    scope?: 'group' | 'unconditional' | 'all' | 'first';
                };
                await CpmResolver.UpdatePackageVersionAsync(
                    request.projectPath,
                    request.packageId,
                    request.version,
                    request.condition,
                    request.scope
                );
                return { updated: true };
            }

            default:
                throw new Error(`unexpected core method: ${method}`);
        }
    }) as never);
}

let coreStub: sinon.SinonStub | undefined;

/** Installs the projects the core should report; the router is created in `setup`. */
function stubProjectParsing(
    resolve: (projectPath: string) => Project | null
): sinon.SinonStub {
    projectResolver = resolve;
    return coreStub as sinon.SinonStub;
}

suite('HostAPI Tests', () => {
    let sandbox: sinon.SinonSandbox;
    /** Flipped by the tests that exercise the .NET core path. */
    let coreConfigured = false;

    setup(() => {
        sandbox = sinon.createSandbox();
        sandbox.stub(Logger, 'info');
        sandbox.stub(Logger, 'debug');
        sandbox.stub(Logger, 'warn');
        sandbox.stub(Logger, 'error');

        // The in-process path is what these tests exercise; the .NET core has its own suite.
        coreConfigured = false;
        sandbox.stub(coreProcess, 'IsConfigured').get(() => coreConfigured);
        coreStub = installCoreStub(sandbox);
    });

    teardown(() => {
        sandbox.restore();
    });

    // ----------------------------------------------------------------
    // getProjects
    // ----------------------------------------------------------------
    suite('getProjects', () => {
        test('delegates to the .NET core when it is configured', async () => {
            coreConfigured = true;
            const projectUri = { fsPath: '/ws/MyApp/MyApp.csproj' } as vscode.Uri;
            sandbox.stub(vscode.workspace, 'findFiles').resolves([projectUri]);
            stubProjectParsing(() => ({
                Name: 'FromCore',
                Path: '/ws/MyApp/MyApp.csproj',
                Packages: [],
                CpmEnabled: false,
            } as Project));

            const api = createHostAPI();
            const result = await api.getProjectsAsync({});

            assert.ok(result.ok);
            assert.strictEqual(result.value.Projects[0]!.Name, 'FromCore');
            assert.strictEqual(coreStub!.firstCall.args[0], 'getProjects');
        });

        test('reports a failure when the core cannot parse the workspace', async () => {
            coreConfigured = true;
            const projectUri = { fsPath: '/ws/MyApp/MyApp.csproj' } as vscode.Uri;
            sandbox.stub(vscode.workspace, 'findFiles').resolves([projectUri]);
            projectResolver = () => {
                throw new Error('core exploded');
            };

            const api = createHostAPI();
            const result = await api.getProjectsAsync({});

            assert.strictEqual(result.ok, false);
        });

        test('returns sorted projects on success', async () => {
            const projectUri = { fsPath: '/ws/MyApp/MyApp.csproj' } as vscode.Uri;
            sandbox.stub(vscode.workspace, 'findFiles').resolves([projectUri]);
            stubProjectParsing(() => ({
                Name: 'MyApp',
                Path: '/ws/MyApp/MyApp.csproj',
                Packages: [],
                CpmEnabled: false,
            } as Project));

            const api = createHostAPI();
            const result = await api.getProjectsAsync({ ForceReload: false });

            assert.ok(result.ok);
            assert.strictEqual(result.value.Projects.length, 1);
            assert.strictEqual(result.value.Projects[0]!.Name, 'MyApp');
        });

        test('returns empty Projects when no project files found', async () => {
            sandbox.stub(vscode.workspace, 'findFiles').resolves([]);

            const api = createHostAPI();
            const result = await api.getProjectsAsync({});

            assert.ok(result.ok);
            assert.deepStrictEqual(result.value.Projects, []);
        });

        test('skips projects that fail to parse', async () => {
            const uri1 = { fsPath: '/ws/A.csproj' } as vscode.Uri;
            const uri2 = { fsPath: '/ws/B.csproj' } as vscode.Uri;
            sandbox.stub(vscode.workspace, 'findFiles').resolves([uri1, uri2]);

            stubProjectParsing((projectPath) =>
                projectPath === '/ws/A.csproj'
                    ? ({ Name: 'A', Path: '/ws/A.csproj', Packages: [], CpmEnabled: false } as Project)
                    : null
            );

            const api = createHostAPI();
            const result = await api.getProjectsAsync({});

            assert.ok(result.ok);
            assert.strictEqual(result.value.Projects.length, 1);
            assert.strictEqual(result.value.Projects[0]!.Name, 'A');
        });
    });

    // ----------------------------------------------------------------
    // getConfiguration
    // ----------------------------------------------------------------
    suite('getConfiguration', () => {
        test('returns configuration with sources', async () => {
            const configStub = {
                get: sandbox.stub(),
            };
            configStub.get.withArgs('skipRestore').returns(false);
            configStub.get.withArgs('enablePackageVersionInlineInfo').returns(false);
            configStub.get.withArgs('prerelease').returns(false);
            configStub.get.withArgs('statusBarLoadingIndicator').returns(false);
            configStub.get.withArgs('sources').returns([]);

            sandbox.stub(vscode.workspace, 'getConfiguration').returns(configStub as unknown as vscode.WorkspaceConfiguration);
            sandbox.stub(vscode.workspace, 'workspaceFolders').value([{ uri: { fsPath: '/ws' } }]);
            sandbox.stub(NuGetConfigResolver, 'GetSourcesAndDecodePasswordsAsync').resolves([
                { Name: 'nuget.org', Url: 'https://api.nuget.org/v3/index.json' },
            ]);

            const api = createHostAPI();
            const result = await api.getConfigurationAsync();

            assert.ok(result.ok);
            assert.strictEqual(result.value.Configuration.Sources.length, 1);
            assert.strictEqual(result.value.Configuration.Sources[0]!.Name, 'nuget.org');
            assert.strictEqual(result.value.Configuration.SkipRestore, false);
        });

        test('returns configuration with empty sources when none configured', async () => {
            const configStub = { get: sandbox.stub() };
            configStub.get.returns(false);
            configStub.get.withArgs('sources').returns([]);

            sandbox.stub(vscode.workspace, 'getConfiguration').returns(configStub as unknown as vscode.WorkspaceConfiguration);
            sandbox.stub(vscode.workspace, 'workspaceFolders').value(undefined);
            sandbox.stub(NuGetConfigResolver, 'GetSourcesAndDecodePasswordsAsync').resolves([]);

            const api = createHostAPI();
            const result = await api.getConfigurationAsync();

            assert.ok(result.ok);
            assert.deepStrictEqual(result.value.Configuration.Sources, []);
        });
    });

    // ----------------------------------------------------------------
    // getOperationProgress
    // ----------------------------------------------------------------
    suite('getOperationProgress', () => {
        test('returns Active=false when no operation is running', async () => {
            sandbox.stub(TaskExecutorDefault, 'GetProgress').returns(null);

            const api = createHostAPI();
            const result = await api.getOperationProgressAsync({ OperationId: 'op-123' });

            assert.ok(result.ok);
            assert.strictEqual(result.value.Active, false);
            assert.strictEqual(result.value.Percent, 0);
            assert.strictEqual(result.value.Stage, '');
        });

        test('returns Active=true with stage and percent when operation running', async () => {
            sandbox.stub(TaskExecutorDefault, 'GetProgress').returns({ stage: 'Resolving...', percent: 20 });

            const api = createHostAPI();
            const result = await api.getOperationProgressAsync({ OperationId: 'op-456' });

            assert.ok(result.ok);
            assert.strictEqual(result.value.Active, true);
            assert.strictEqual(result.value.Stage, 'Resolving...');
            assert.strictEqual(result.value.Percent, 20);
        });
    });

    // ----------------------------------------------------------------
    // showConfirmation
    // ----------------------------------------------------------------
    suite('showConfirmation', () => {
        test('returns Confirmed=true when user clicks Yes', async () => {
            sandbox.stub(vscode.window, 'showWarningMessage').resolves('Yes' as unknown as vscode.MessageItem);

            const api = createHostAPI();
            const result = await api.showConfirmationAsync({ Message: 'Are you sure?' });

            assert.ok(result.ok);
            assert.strictEqual(result.value.Confirmed, true);
        });

        test('returns Confirmed=false when user dismisses dialog', async () => {
            sandbox.stub(vscode.window, 'showWarningMessage').resolves(undefined);

            const api = createHostAPI();
            const result = await api.showConfirmationAsync({ Message: 'Are you sure?' });

            assert.ok(result.ok);
            assert.strictEqual(result.value.Confirmed, false);
        });
    });

    // ----------------------------------------------------------------
    // getPackages — error path
    // ----------------------------------------------------------------
    suite('getPackages', () => {
        test('returns fail result when API throws', async () => {
            sandbox.stub(vscode.workspace, 'workspaceFolders').value([{ uri: { fsPath: '/ws' } }]);
            sandbox.stub(NuGetConfigResolver, 'GetSourcesAndDecodePasswordsAsync').resolves([
                { Name: 'nuget.org', Url: 'https://api.nuget.org/v3/index.json' },
            ]);
            const mockApi = {
                GetPackagesAsync: sandbox.stub().rejects(new Error('Network error')),
                ClearPackageCache: sandbox.stub(),
            };
            sandbox.stub(nugetApiFactory, 'GetSourceApiAsync').resolves(mockApi as unknown as Awaited<ReturnType<typeof nugetApiFactory.GetSourceApiAsync>>);

            const api = createHostAPI();
            const result = await api.getPackagesAsync({
                Url: 'https://api.nuget.org/v3/index.json',
                Filter: 'Newtonsoft',
                Prerelease: false,
                Skip: 0,
                Take: 20,
            });

            assert.ok(!result.ok);
            assert.ok(result.error.includes('Network error'));
        });

        test('returns packages on success', async () => {
            sandbox.stub(vscode.workspace, 'workspaceFolders').value([{ uri: { fsPath: '/ws' } }]);
            sandbox.stub(NuGetConfigResolver, 'GetSourcesAndDecodePasswordsAsync').resolves([]);
            const mockApi = {
                GetPackagesAsync: sandbox.stub().resolves({ data: [{ Id: 'Newtonsoft.Json', Name: 'Newtonsoft.Json', Version: '13.0.1' }] }),
            };
            sandbox.stub(nugetApiFactory, 'GetSourceApiAsync').resolves(mockApi as unknown as Awaited<ReturnType<typeof nugetApiFactory.GetSourceApiAsync>>);

            const api = createHostAPI();
            const result = await api.getPackagesAsync({
                Url: 'https://api.nuget.org/v3/index.json',
                Filter: 'Newtonsoft',
                Prerelease: false,
                Skip: 0,
                Take: 20,
            });

            assert.ok(result.ok);
            assert.strictEqual(result.value.Packages.length, 1);
            assert.strictEqual(result.value.Packages[0]!.Id, 'Newtonsoft.Json');
        });
    });

    // ----------------------------------------------------------------
    // getOutdatedPackages
    // ----------------------------------------------------------------
    suite('getOutdatedPackages', () => {
        function makeProjectUri(fsPath: string): vscode.Uri {
            return { fsPath } as vscode.Uri;
        }

        function makeProject(name: string, pkgPath: string, pkgVersion: string): Project {
            return {
                Name: name,
                Path: pkgPath,
                CpmEnabled: false,
                Packages: [{ Id: 'Newtonsoft.Json', Version: pkgVersion, IsPinned: false }],
            } as unknown as Project;
        }

        function setupNugetApi(latestVersion: string) {
            const mockApi = {
                GetPackagesAsync: sandbox.stub().resolves({
                    data: [{ Name: 'Newtonsoft.Json', Id: 'Newtonsoft.Json', Version: latestVersion }],
                }),
            };
            sandbox.stub(nugetApiFactory, 'GetSourceApiAsync').resolves(
                mockApi as unknown as Awaited<ReturnType<typeof nugetApiFactory.GetSourceApiAsync>>
            );
        }

        setup(() => {
            sandbox.stub(vscode.workspace, 'workspaceFolders').value([{ uri: { fsPath: '/ws' } }]);
            sandbox.stub(NuGetConfigResolver, 'GetSourcesAndDecodePasswordsAsync').resolves([
                { Name: 'nuget.org', Url: 'https://api.nuget.org/v3/index.json' },
            ]);
            // No CPM for these tests
            sandbox.stub(CpmResolver, 'GetPackageVersionsAsync').resolves(null);
        });

        test('reports package as outdated when one project is behind latest (min-version aggregation)', async () => {
            // Project A has 1.0.0, Project B has 2.0.0, latest is 2.0.0.
            // With min-version tracking the entry version should be 1.0.0, which IS older than 2.0.0.
            const uriA = makeProjectUri('/ws/A.csproj');
            const uriB = makeProjectUri('/ws/B.csproj');
            sandbox.stub(vscode.workspace, 'findFiles').resolves([uriA, uriB]);

            stubProjectParsing((projectPath) =>
                projectPath === '/ws/A.csproj'
                    ? makeProject('A', '/ws/A.csproj', '1.0.0')
                    : makeProject('B', '/ws/B.csproj', '2.0.0')
            );

            setupNugetApi('2.0.0');

            const api = createHostAPI();
            const result = await api.getOutdatedPackagesAsync({ ForceReload: false, Prerelease: false });

            assert.ok(result.ok);
            assert.strictEqual(result.value.Packages.length, 1);
            assert.strictEqual(result.value.Packages[0]!.Id, 'Newtonsoft.Json');
            assert.strictEqual(result.value.Packages[0]!.InstalledVersion, '1.0.0');
            assert.strictEqual(result.value.Packages[0]!.LatestVersion, '2.0.0');
            assert.strictEqual(result.value.Packages[0]!.Projects.length, 2);
        });

        test('reports live scan progress for a ScanId and clears it when the scan finishes', async () => {
            const uri = makeProjectUri('/ws/A.csproj');
            let releaseFind: (() => void) | undefined;
            const gate = new Promise<void>((resolve) => { releaseFind = resolve; });
            sandbox.stub(vscode.workspace, 'findFiles').callsFake(async () => {
                await gate;
                return [uri];
            });
            stubProjectParsing(() => makeProject('A', '/ws/A.csproj', '1.0.0'));
            setupNugetApi('2.0.0');

            const api = createHostAPI();
            const scanId = 'scan-progress-test';
            const scan = api.getOutdatedPackagesAsync({ ForceReload: false, Prerelease: false, ScanId: scanId });

            let inFlight = await api.getOutdatedScanProgressAsync({ ScanId: scanId });
            for (let i = 0; i < 200; i += 1) {
                if (inFlight.ok && inFlight.value.Active) break;
                await new Promise((resolve) => setTimeout(resolve, 5));
                inFlight = await api.getOutdatedScanProgressAsync({ ScanId: scanId });
            }

            assert.ok(inFlight.ok);
            assert.strictEqual(inFlight.value.Active, true);
            assert.match(inFlight.value.Stage, /Resolving package sources|Reading project files|Parsing projects/);

            releaseFind!();
            const result = await scan;
            assert.ok(result.ok);

            const finished = await api.getOutdatedScanProgressAsync({ ScanId: scanId });
            assert.ok(finished.ok);
            assert.strictEqual(finished.value.Active, false);
        });

        test('keeps framework-scoped CPM resolutions when package has no single version', async () => {
            const uri = makeProjectUri('/ws/A.csproj');
            sandbox.stub(vscode.workspace, 'findFiles').resolves([uri]);

            const project = {
                Name: 'A',
                Path: '/ws/A.csproj',
                CpmEnabled: true,
                Packages: [{
                    Id: 'Newtonsoft.Json',
                    Version: '',
                    IsPinned: false,
                    CpmResolutions: [
                        { Tfm: 'net10.0', Version: '1.0.0', Condition: 'net10', ConditionLabel: 'net10.0', Matched: true },
                        { Tfm: 'net11.0', Version: '2.0.0', Condition: 'net11', ConditionLabel: 'net11.0', Matched: true },
                    ],
                }],
            } as unknown as Project;

            stubProjectParsing(() => project);
            setupNugetApi('3.0.0');

            const api = createHostAPI();
            const result = await api.getOutdatedPackagesAsync({ ForceReload: false, Prerelease: false });

            assert.ok(result.ok);
            assert.strictEqual(result.value.Packages.length, 2);
            assert.deepStrictEqual(
                result.value.Packages.map((pkg) => [pkg.CpmFramework, pkg.InstalledVersion]).sort((a, b) => a.join("\0").localeCompare(b.join("\0"))),
                [['net10.0', '1.0.0'], ['net11.0', '2.0.0']]
            );
        });

        test('does not report package as outdated when all projects are already at latest', async () => {
            const uriA = makeProjectUri('/ws/A.csproj');
            sandbox.stub(vscode.workspace, 'findFiles').resolves([uriA]);

            stubProjectParsing(() => makeProject('A', '/ws/A.csproj', '2.0.0'));

            setupNugetApi('2.0.0');

            const api = createHostAPI();
            const result = await api.getOutdatedPackagesAsync({ ForceReload: false, Prerelease: false });

            assert.ok(result.ok);
            assert.strictEqual(result.value.Packages.length, 0);
        });

        test('reports package as outdated when installed version is prerelease and latest is stable', async () => {
            // 1.0.0-beta should be treated as less than 1.0.0 (NuGet SemVer)
            const uri = makeProjectUri('/ws/A.csproj');
            sandbox.stub(vscode.workspace, 'findFiles').resolves([uri]);

            stubProjectParsing(() => makeProject('A', '/ws/A.csproj', '1.0.0-beta'));

            setupNugetApi('1.0.0');

            const api = createHostAPI();
            const result = await api.getOutdatedPackagesAsync({ ForceReload: false, Prerelease: false });

            assert.ok(result.ok);
            assert.strictEqual(result.value.Packages.length, 1);
            assert.strictEqual(result.value.Packages[0]!.InstalledVersion, '1.0.0-beta');
            assert.strictEqual(result.value.Packages[0]!.LatestVersion, '1.0.0');
        });

        test('serves the persisted scan when PreferCache is set', async () => {
            const uri = makeProjectUri('/ws/A.csproj');
            const findFiles = sandbox.stub(vscode.workspace, 'findFiles').resolves([uri]);
            const parseStub = stubProjectParsing(() => makeProject('A', '/ws/A.csproj', '1.0.0'));
            setupNugetApi('2.0.0');

            let stored: unknown;
            const memento = {
                get: <T>(_key: string, defaultValue?: T): T | undefined => (stored as T | undefined) ?? defaultValue,
                update: async (_key: string, value: unknown) => { stored = value; },
                keys: () => [],
                setKeysForSync: () => undefined,
            } as unknown as vscode.Memento;
            const context = { workspaceState: memento } as unknown as vscode.ExtensionContext;

            const live = await createHostAPI(context).getOutdatedPackagesAsync({ ForceReload: false, Prerelease: false });
            assert.ok(live.ok);
            assert.strictEqual(live.value.Packages.length, 1);

            findFiles.rejects(new Error('the cache path must not scan the workspace'));
            parseStub.rejects(new Error('the cache path must not parse projects'));

            const cached = await createHostAPI(context).getOutdatedPackagesAsync({ Prerelease: false, PreferCache: true });
            assert.ok(cached.ok);
            assert.strictEqual(cached.value.FromCache, true);
            assert.strictEqual(cached.value.Packages.length, 1);
            assert.ok(cached.value.ScannedAt);

            const otherFilter = await createHostAPI(context).getOutdatedPackagesAsync({ Prerelease: true, PreferCache: true });
            assert.ok(otherFilter.ok);
            assert.strictEqual(otherFilter.value.Packages.length, 0);
        });
    });

    test('cleanup ignores projects under .ai scratch directories', async () => {
        const fake = { fsPath: '/ws/.ai/tmp/fakesrc/fake.csproj' } as vscode.Uri;
        const real = { fsPath: '/ws/Real.csproj' } as vscode.Uri;
        sandbox.stub(vscode.workspace, 'getConfiguration').returns({
            get: () => undefined,
        } as unknown as vscode.WorkspaceConfiguration);
        sandbox.stub(vscode.workspace, 'findFiles').callsFake(async (pattern: vscode.GlobPattern) =>
            String(pattern).includes('Directory.Packages.props') ? [] : [fake, real]
        );
        const parseStub = stubProjectParsing((projectPath) =>
            projectPath === fake.fsPath
                ? null
                : ({ Name: 'Real', Path: real.fsPath, Packages: [] } as unknown as Project)
        );

        const api = createHostAPI();
        const result = await api.getCleanupReportAsync({});

        assert.ok(result.ok);
        assert.strictEqual(parseStub.callCount, 1);
        assert.ok(!JSON.stringify(parseStub.firstCall.args[1]).includes('fake.csproj'));
    });

    // ----------------------------------------------------------------
    // CPM multi-framework projects
    // ----------------------------------------------------------------
    suite('CPM multi-framework projects', () => {
        test('keeps framework lines separate when grouping inconsistencies', async () => {
            const projects = [
                { name: 'net10-a', condition: "net", tfm: 'net10.0', version: '1.0.0' },
                { name: 'net10-b', condition: "net", tfm: 'net10.0', version: '1.1.0' },
                { name: 'net11-a', condition: "net", tfm: 'net11.0', version: '2.0.0' },
            ];
            const uris = projects.map((p) => ({ fsPath: `/ws/${p.name}.csproj` }) as vscode.Uri);

            sandbox.stub(vscode.workspace, 'findFiles').resolves(uris);
            sandbox.stub(CpmResolver, 'FindCpmFilePathAsync').resolves(null);
            stubProjectParsing((projectPath) => {
                const name = path.basename(projectPath, '.csproj');
                const fixture = projects.find((p) => p.name === name);
                if (!fixture) return null;
                return {
                    Path: projectPath,
                    Name: fixture.name,
                    CpmEnabled: true,
                    Packages: [{
                        Id: 'Pkg.Line',
                        Version: fixture.version,
                        IsPinned: false,
                        VersionSource: 'central',
                        CpmResolutions: [{
                            Tfm: fixture.tfm,
                            Version: fixture.version,
                            Condition: fixture.condition,
                            ConditionLabel: fixture.condition,
                            Matched: true,
                        }],
                    }],
                } as Project;
            });

            const configStub = { get: sandbox.stub() };
            configStub.get.withArgs('excludeGlobs').returns([]);
            configStub.get.withArgs('extraTargetFrameworks').returns([]);
            configStub.get.withArgs('frameworkAlignedPackages').returns([]);
            sandbox.stub(vscode.workspace, 'getConfiguration').returns(configStub as unknown as vscode.WorkspaceConfiguration);

            const api = createHostAPI();
            const result = await api.getInconsistentPackagesAsync({});
            assert.ok(result.ok);

            const inconsistent = result.value.Packages.find((pkg) => pkg.Id === 'Pkg.Line');
            assert.ok(inconsistent, 'the net10 line is inconsistent');
            assert.strictEqual(inconsistent!.Versions.length, 2);
            assert.ok(
                inconsistent!.Versions.every((version) => version.CpmFramework === 'net10.0'),
                'the net11 line must not be merged into the net10 card'
            );
        });

        test('reports one outdated row per TFM with version-aligned latest', async () => {
            const uris = [
                { fsPath: '/ws/net10.csproj' } as vscode.Uri,
                { fsPath: '/ws/net11.csproj' } as vscode.Uri,
            ];
            sandbox.stub(vscode.workspace, 'findFiles').callsFake(async (pattern: vscode.GlobPattern) =>
                String(pattern).includes('sln') ? [] : uris
            );

            // The core supplies the per-TFM resolutions; this test covers the host's row shaping.
            stubProjectParsing((projectPath) => {
                const net11 = projectPath.includes('net11');
                const tfm = net11 ? 'net11.0' : 'net10.0';
                const version = net11 ? '11.0.0-rc.2.26504.105' : '10.0.13';
                return {
                    Path: projectPath,
                    Name: path.basename(projectPath),
                    CpmEnabled: true,
                    TargetFrameworks: [tfm],
                    TfmSource: 'msbuild',
                    Packages: [{
                        Id: 'Microsoft.Extensions.Logging',
                        Version: version,
                        IsPinned: false,
                        VersionSource: 'central',
                        CpmFramework: net11 ? undefined : 'not net11.0',
                        CpmResolutions: [{
                            Tfm: tfm,
                            Version: version,
                            Condition: net11 ? "$(TargetFramework.StartsWith('net11.0'))" : "!$(TargetFramework.StartsWith('net11.0'))",
                            ConditionLabel: net11 ? 'net11.0' : 'not net11.0',
                            Matched: true,
                        }],
                    }],
                } as Project;
            });

            sandbox.stub(NuGetConfigResolver, 'GetSourcesAndDecodePasswordsAsync').resolves([
                { Name: 'nuget.org', Url: 'https://api.nuget.org/v3/index.json' },
            ]);

            const mockApi = {
                GetPackagesAsync: sandbox.stub().resolves({
                    data: [{
                        Name: 'Microsoft.Extensions.Logging',
                        Id: 'Microsoft.Extensions.Logging',
                        Version: '11.0.0-rc.3',
                        Versions: [
                            { Version: '10.0.14', Id: '' },
                            { Version: '11.0.0-rc.3', Id: '' },
                        ],
                    }],
                }),
            };
            sandbox.stub(nugetApiFactory, 'GetSourceApiAsync').resolves(
                mockApi as unknown as Awaited<ReturnType<typeof nugetApiFactory.GetSourceApiAsync>>
            );

            const api = createHostAPI();
            const result = await api.getOutdatedPackagesAsync({ ForceReload: false, Prerelease: true });
            assert.ok(result.ok);

            const loggingRows = result.value.Packages.filter(
                (pkg) => pkg.Id === 'Microsoft.Extensions.Logging'
            );
            assert.strictEqual(loggingRows.length, 2, 'one row per framework line');

            const net10Row = loggingRows.find((pkg) => pkg.CpmFramework === 'net10.0')!;
            assert.ok(net10Row);
            assert.strictEqual(net10Row.InstalledVersion, '10.0.13');
            assert.strictEqual(net10Row.LatestVersion, '10.0.14', 'stays on the net10 major line');
            assert.strictEqual(net10Row.LatestOverallVersion, '11.0.0-rc.3');
            assert.strictEqual(net10Row.CpmConditionLabel, 'not net11.0');

            const net11Row = loggingRows.find((pkg) => pkg.CpmFramework === 'net11.0')!;
            assert.ok(net11Row);
            assert.strictEqual(net11Row.InstalledVersion, '11.0.0-rc.2.26504.105');
            assert.strictEqual(net11Row.LatestVersion, '11.0.0-rc.3');
            assert.strictEqual(net11Row.LatestOverallVersion, undefined);
        });
    });

    // ----------------------------------------------------------------
    // CPM write scope
    // ----------------------------------------------------------------
    suite('CPM write scope', () => {
        let workspaceDir: string;
        let projectPath: string;

        function setupWorkspace(fixture: string): void {
            workspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), 'host-cpm-write-'));
            fs.writeFileSync(
                path.join(workspaceDir, 'Directory.Packages.props'),
                fs.readFileSync(path.join(fixturesRoot(), 'cpm', fixture), 'utf8')
            );
            projectPath = path.join(workspaceDir, 'App.csproj');
            fs.writeFileSync(
                projectPath,
                '<Project Sdk="Microsoft.NET.Sdk"><PropertyGroup><TargetFramework>net10.0</TargetFramework><ManagePackageVersionsCentrally>true</ManagePackageVersionsCentrally></PropertyGroup><ItemGroup><PackageReference Include="Pkg.Shared" /><PackageReference Include="Microsoft.Extensions.Logging" /></ItemGroup></Project>'
            );

            sandbox.stub(vscode.workspace, 'workspaceFolders').value([{ uri: { fsPath: workspaceDir } }]);
        }

        teardown(() => {
            if (workspaceDir) {
                fs.rmSync(workspaceDir, { recursive: true, force: true });
            }
        });

        test('unconditional scope leaves conditional framework lines untouched', async () => {
            setupWorkspace('unconditional-plus-conditional.props');

            const api = createHostAPI();
            const result = await api.batchUpdatePackagesAsync({
                Updates: [{
                    PackageId: 'Pkg.Shared',
                    Version: '1.5.0',
                    ProjectPaths: [projectPath],
                    Scope: 'unconditional',
                }],
            });

            assert.ok(result.ok);
            assert.strictEqual(result.value.Results[0]!.Success, true);

            const map = await CpmResolver.ParseCpmFileAsync(path.join(workspaceDir, 'Directory.Packages.props'));
            assert.strictEqual(map.unconditional.get('Pkg.Shared'), '1.5.0');
            assert.strictEqual(
                map.conditional.find((entry) => entry.framework === 'net10.0')!.versions.get('Pkg.Shared'),
                '2.0.0'
            );
        });

        test('consolidates only the requested framework line', async () => {
            setupWorkspace('negated-positive.props');

            const configStub = { get: sandbox.stub() };
            configStub.get.withArgs('skipRestore').returns('true');
            sandbox.stub(vscode.workspace, 'getConfiguration').returns(
                configStub as unknown as vscode.WorkspaceConfiguration
            );

            const api = createHostAPI();
            const result = await api.consolidatePackagesAsync({
                PackageId: 'Microsoft.Extensions.Logging',
                TargetVersion: '10.0.14',
                ProjectPaths: [projectPath],
                CpmCondition: "!$(TargetFramework.StartsWith('net11.0'))",
                Scope: 'group',
            });

            assert.ok(result.ok, result.ok ? '' : result.error);

            const map = await CpmResolver.ParseCpmFileAsync(path.join(workspaceDir, 'Directory.Packages.props'));
            const net10 = map.conditional.find((entry) => entry.condition.startsWith('!'))!;
            const net11 = map.conditional.find((entry) => !entry.condition.startsWith('!'))!;
            assert.strictEqual(net10.versions.get('Microsoft.Extensions.Logging'), '10.0.14');
            assert.strictEqual(net11.versions.get('Microsoft.Extensions.Logging'), '11.0.0-rc.2.26504.105');
        });

        test('refuses a blanket consolidation of a framework-scoped package', async () => {
            setupWorkspace('negated-positive.props');

            const configStub = { get: sandbox.stub() };
            configStub.get.withArgs('skipRestore').returns('true');
            sandbox.stub(vscode.workspace, 'getConfiguration').returns(
                configStub as unknown as vscode.WorkspaceConfiguration
            );

            const api = createHostAPI();
            const result = await api.consolidatePackagesAsync({
                PackageId: 'Microsoft.Extensions.Logging',
                TargetVersion: '10.0.14',
                ProjectPaths: [projectPath],
                Scope: 'all',
            });

            assert.strictEqual(result.ok, false);
            if (!result.ok) {
                assert.match(result.error, /framework-scoped versions/);
            }

            const map = await CpmResolver.ParseCpmFileAsync(path.join(workspaceDir, 'Directory.Packages.props'));
            const net10 = map.conditional.find((entry) => entry.condition.startsWith('!'))!;
            const net11 = map.conditional.find((entry) => !entry.condition.startsWith('!'))!;
            assert.strictEqual(net10.versions.get('Microsoft.Extensions.Logging'), '10.0.13');
            assert.strictEqual(net11.versions.get('Microsoft.Extensions.Logging'), '11.0.0-rc.2.26504.105');
        });

        test('refuses an ambiguous multi-framework update without a condition', async () => {
            setupWorkspace('shared-id-positive-groups.props');

            const api = createHostAPI();
            const result = await api.batchUpdatePackagesAsync({
                Updates: [{
                    PackageId: 'Microsoft.Extensions.Http',
                    Version: '9.0.2',
                    ProjectPaths: [projectPath],
                }],
            });

            assert.ok(result.ok);
            assert.strictEqual(result.value.Results[0]!.Success, false);
            assert.match(result.value.Results[0]!.Error ?? '', /multiple framework-scoped versions/);
        });

        test('updates restore but never build', async () => {
            setupWorkspace('unconditional-plus-conditional.props');

            const commands: string[][] = [];
            sandbox.stub(TaskExecutorDefault, 'ExecuteCommandAsync').callsFake(
                async (command: string, args: string[]) => {
                    commands.push([command, ...args]);
                }
            );

            const api = createHostAPI();
            const result = await api.batchUpdatePackagesAsync({
                Updates: [{
                    PackageId: 'Pkg.Shared',
                    Version: '1.5.0',
                    ProjectPaths: [projectPath],
                    Scope: 'unconditional',
                }],
                Transactional: true,
                SkipRestore: false,
            });

            assert.ok(result.ok, result.ok ? '' : result.error);
            assert.ok(commands.length > 0, 'the update must at least restore');
            assert.ok(
                commands.some(([, subcommand]) => subcommand === 'restore'),
                'the update must restore the affected project'
            );
            for (const [command, ...args] of commands) {
                assert.strictEqual(command, 'dotnet');
                assert.notStrictEqual(args[0], 'build', 'building is left to the user');
                assert.ok(
                    ['restore', 'add', 'remove'].includes(args[0] ?? ''),
                    `unexpected dotnet command: ${args.join(' ')}`
                );
            }
        });

        test('rejects update and restore paths outside the workspace', async () => {
            setupWorkspace('single-group.props');
            const outside = path.join(workspaceDir, '..', 'Evil.csproj');

            const api = createHostAPI();
            const update = await api.updateProjectAsync({
                ProjectPath: outside,
                PackageId: 'Newtonsoft.Json',
                Version: '13.0.3',
                Type: 'UPDATE',
            });
            assert.strictEqual(update.ok, false);

            const restore = await api.restoreProjectsAsync({ ProjectPaths: [outside] });
            assert.strictEqual(restore.ok, false);

            const batch = await api.batchUpdatePackagesAsync({
                Updates: [{
                    PackageId: 'Newtonsoft.Json',
                    Version: '13.0.3',
                    ProjectPaths: [outside],
                }],
            });
            assert.strictEqual(batch.ok, false);
        });

        test('rejects invalid package IDs and versions before writing', async () => {
            setupWorkspace('single-group.props');
            const api = createHostAPI();

            const badId = await api.updateProjectAsync({
                ProjectPath: projectPath,
                PackageId: 'Evil" /><PackageVersion Include="X',
                Version: '1.0.0',
                Type: 'UPDATE',
            });
            assert.strictEqual(badId.ok, false);

            const badVersion = await api.updateProjectAsync({
                ProjectPath: projectPath,
                PackageId: 'Pkg.Shared',
                Version: '1.0.0" /><Import Project="evil.props"',
                Type: 'UPDATE',
            });
            assert.strictEqual(badVersion.ok, false);
        });

        test('matches vulnerabilities case-insensitively and returns the original package ID', async () => {
            setupWorkspace('negated-positive.props');

            sandbox.stub(vscode.workspace, 'findFiles').callsFake(async (pattern: vscode.GlobPattern) =>
                String(pattern).includes('sln') ? [] : [{ fsPath: projectPath }] as vscode.Uri[]
            );
            stubProjectParsing(() => ({
                Path: projectPath,
                Name: 'App.csproj',
                CpmEnabled: true,
                TargetFrameworks: ['net10.0'],
                TfmSource: 'msbuild',
                Packages: [{
                    Id: 'Microsoft.Extensions.Logging',
                    Version: '10.0.13',
                    IsPinned: false,
                    VersionSource: 'central',
                    CpmFramework: 'not net11.0',
                    CpmResolutions: [{
                        Tfm: 'net10.0',
                        Version: '10.0.13',
                        Condition: "!$(TargetFramework.StartsWith('net11.0'))",
                        ConditionLabel: 'not net11.0',
                        Matched: true,
                    }],
                }],
            } as Project));
            sandbox.stub(NuGetConfigResolver, 'GetSourcesAndDecodePasswordsAsync').resolves([
                { Name: 'nuget.org', Url: 'https://api.nuget.org/v3/index.json' },
            ]);
            sandbox.stub(nugetApiFactory, 'GetSourceApiAsync').resolves({
                GetVulnerabilitiesAsync: async () => new Map([
                    ['MICROSOFT.EXTENSIONS.LOGGING', [{
                        url: 'https://advisory.example/1',
                        severity: 3,
                        versions: '[0.0.0, )',
                    }]],
                ]),
            } as unknown as Awaited<ReturnType<typeof nugetApiFactory.GetSourceApiAsync>>);

            const api = createHostAPI();
            const result = await api.getVulnerablePackagesAsync({ ForceReload: false });

            assert.ok(result.ok);
            const row = result.value.Packages.find((pkg) => pkg.Id === 'Microsoft.Extensions.Logging');
            assert.ok(row, 'the original package ID must be preserved');
            assert.strictEqual(row!.InstalledVersion, '10.0.13');
            assert.deepStrictEqual(row!.CpmFrameworks, ['net10.0']);
        });
    });

    // ----------------------------------------------------------------
    // Restore diagnostics and transactional single update
    // ----------------------------------------------------------------
    suite('restore diagnostics', () => {
        const NU1107_OUTPUT = [
            'C:\\ws\\Sample.Api.csproj : error NU1107: Version conflict detected for Microsoft.EntityFrameworkCore.Relational. Install/reference Microsoft.EntityFrameworkCore.Relational 11.0.0-rc.3.26522.148 directly to project Sample.Api to resolve this issue.',
            'C:\\ws\\Sample.Api.csproj :  Sample.Api -> I-Synergy.Framework.EventSourcing.EntityFramework -> Microsoft.EntityFrameworkCore.Relational (>= 11.0.0-rc.3.26522.148)',
            'C:\\ws\\Sample.Api.csproj :  Sample.Api -> Npgsql.EntityFrameworkCore.PostgreSQL 11.0.0-rc.2 -> Microsoft.EntityFrameworkCore.Relational (= 11.0.0-rc.2.26504.105).',
        ].join('\n');

        let workspaceDir: string;

        setup(() => {
            workspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), 'host-restore-'));
            sandbox.stub(vscode.workspace, 'workspaceFolders').value([{ uri: { fsPath: workspaceDir } }]);
            sandbox.stub(vscode.workspace, 'getConfiguration').returns({
                get: () => undefined,
            } as unknown as vscode.WorkspaceConfiguration);
        });

        teardown(() => {
            fs.rmSync(workspaceDir, { recursive: true, force: true });
        });

        test('reports the NU1107 constraint chain instead of a generic message', async () => {
            const projectPath = path.join(workspaceDir, 'App.csproj');
            fs.writeFileSync(projectPath, '<Project Sdk="Microsoft.NET.Sdk"></Project>');
            sandbox.stub(TaskExecutorDefault, 'ExecuteCommandAsync').rejects(
                new DotnetError('dotnet exited with code 1', NU1107_OUTPUT)
            );

            const api = createHostAPI();
            const result = await api.restoreProjectsAsync({ ProjectPaths: [projectPath] });

            assert.strictEqual(result.ok, false);
            if (!result.ok) {
                assert.match(result.error, /NU1107/);
                assert.match(result.error, /Microsoft\.EntityFrameworkCore\.Relational/);
                assert.match(result.error, /Npgsql\.EntityFrameworkCore\.PostgreSQL 11\.0\.0-rc\.2/);
                assert.match(result.error, /= 11\.0\.0-rc\.2\.26504\.105/);
                assert.match(result.error, />= 11\.0\.0-rc\.3\.26522\.148/);
            }
        });

        test('rolls back the project and props files when a single update cannot restore', async () => {
            const projectPath = path.join(workspaceDir, 'App.csproj');
            const propsPath = path.join(workspaceDir, 'Directory.Packages.props');
            const projectContent = '<Project Sdk="Microsoft.NET.Sdk"></Project>';
            const propsContent = [
                '<Project>',
                '  <ItemGroup>',
                '    <PackageVersion Include="Microsoft.EntityFrameworkCore.Relational" Version="11.0.0-rc.2.26504.105" />',
                '  </ItemGroup>',
                '</Project>',
            ].join('\n');
            fs.writeFileSync(projectPath, projectContent);
            fs.writeFileSync(propsPath, propsContent);

            sandbox.stub(CpmResolver, 'FindCpmFilePathAsync').resolves(propsPath);
            sandbox.stub(CpmResolver, 'GetFrameworkPackageMapAsync').resolves({
                unconditional: new Map([['Microsoft.EntityFrameworkCore.Relational', '11.0.0-rc.2.26504.105']]),
                conditional: [],
                hasConditionalGroups: false,
            } as unknown as Awaited<ReturnType<typeof CpmResolver.GetFrameworkPackageMapAsync>>);
            sandbox.stub(CpmResolver, 'HasPackage').returns(true);
            sandbox.stub(CpmResolver, 'UpdatePackageVersionAsync').callsFake(async () => {
                fs.writeFileSync(
                    propsPath,
                    propsContent.replace('11.0.0-rc.2.26504.105', '11.0.0-rc.3.26522.148')
                );
            });
            sandbox.stub(TaskExecutorDefault, 'ExecuteCommandAsync').callsFake(async (_command, _args, operationId) => {
                if (String(operationId).startsWith('rollback-restore-')) return;
                throw new DotnetError('dotnet exited with code 1', NU1107_OUTPUT);
            });

            const api = createHostAPI();
            const result = await api.updateProjectAsync({
                ProjectPath: projectPath,
                PackageId: 'Microsoft.EntityFrameworkCore.Relational',
                Version: '11.0.0-rc.3.26522.148',
                Type: 'UPDATE',
            });

            assert.strictEqual(result.ok, false);
            if (!result.ok) {
                assert.match(result.error, /rolled back/);
                assert.match(result.error, /NU1107/);
            }
            assert.strictEqual(fs.readFileSync(propsPath, 'utf8'), propsContent);
            assert.strictEqual(fs.readFileSync(projectPath, 'utf8'), projectContent);
        });
    });

    // ----------------------------------------------------------------
    // Mutation jobs
    // ----------------------------------------------------------------
    suite('mutation jobs', () => {
        let workspaceDir: string;
        let projectPath: string;

        function setupWorkspace(fixture: string): void {
            workspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), 'host-batch-job-'));
            fs.writeFileSync(
                path.join(workspaceDir, 'Directory.Packages.props'),
                fs.readFileSync(path.join(fixturesRoot(), 'cpm', fixture), 'utf8')
            );
            projectPath = path.join(workspaceDir, 'App.csproj');
            fs.writeFileSync(
                projectPath,
                '<Project Sdk="Microsoft.NET.Sdk"><PropertyGroup><TargetFramework>net10.0</TargetFramework><ManagePackageVersionsCentrally>true</ManagePackageVersionsCentrally></PropertyGroup><ItemGroup><PackageReference Include="Pkg.Shared" /></ItemGroup></Project>'
            );
            sandbox.stub(vscode.workspace, 'workspaceFolders').value([{ uri: { fsPath: workspaceDir } }]);
        }

        function gate(): { wait: Promise<void>; open: () => void } {
            let open!: () => void;
            const wait = new Promise<void>((resolve) => { open = resolve; });
            return { wait, open };
        }

        async function waitForJobAsync(
            api: ReturnType<typeof createHostAPI>,
            jobId: string
        ): Promise<Result<GetJobResponse>> {
            let status = await api.getJobAsync({ JobId: jobId });
            for (let i = 0; i < 400; i += 1) {
                if (!status.ok || status.value.State !== 'running') return status;
                await new Promise((resolve) => setTimeout(resolve, 5));
                status = await api.getJobAsync({ JobId: jobId });
            }
            return status;
        }

        function batchJob(status: Result<GetJobResponse>) {
            assert.ok(status.ok, status.ok ? '' : status.error);
            if (status.value.Kind !== 'batchUpdate') {
                throw new Error(`Unexpected job kind: ${status.value.Kind}`);
            }
            return status.value;
        }

        function skipRestoreConfig(): void {
            const configStub = { get: sandbox.stub() };
            configStub.get.withArgs('skipRestore').returns('true');
            sandbox.stub(vscode.workspace, 'getConfiguration').returns(
                configStub as unknown as vscode.WorkspaceConfiguration
            );
        }

        teardown(() => {
            OperationJobs.Reset();
            if (workspaceDir) {
                fs.rmSync(workspaceDir, { recursive: true, force: true });
            }
        });

        test('runs a batch update as a job and serves the final response', async () => {
            setupWorkspace('unconditional-plus-conditional.props');
            skipRestoreConfig();

            const api = createHostAPI();
            const started = await api.startBatchUpdateAsync({
                Updates: [{
                    PackageId: 'Pkg.Shared',
                    Version: '1.5.0',
                    ProjectPaths: [projectPath],
                    Scope: 'unconditional',
                }],
                Transactional: true,
                SkipRestore: true,
            });

            assert.ok(started.ok, started.ok ? '' : started.error);
            const status = await waitForJobAsync(api, started.value.JobId);

            assert.strictEqual(batchJob(status).State, 'completed');
            assert.strictEqual(batchJob(status).Percent, 100);
            assert.strictEqual(batchJob(status).Response?.Results[0]?.Success, true);
            assert.strictEqual(batchJob(status).Response?.RolledBack, undefined);

            const map = await CpmResolver.ParseCpmFileAsync(path.join(workspaceDir, 'Directory.Packages.props'));
            assert.strictEqual(map.unconditional.get('Pkg.Shared'), '1.5.0');
        });

        test('rolls back inside the job when the restore fails', async () => {
            setupWorkspace('unconditional-plus-conditional.props');
            const propsPath = path.join(workspaceDir, 'Directory.Packages.props');
            const propsBefore = fs.readFileSync(propsPath, 'utf8');
            sandbox.stub(TaskExecutorDefault, 'ExecuteCommandAsync').rejects(
                new DotnetError('dotnet exited with code 1', '')
            );

            const api = createHostAPI();
            const started = await api.startBatchUpdateAsync({
                Updates: [{
                    PackageId: 'Pkg.Shared',
                    Version: '1.5.0',
                    ProjectPaths: [projectPath],
                    Scope: 'unconditional',
                }],
                Transactional: true,
                SkipRestore: false,
            });

            assert.ok(started.ok, started.ok ? '' : started.error);
            const status = await waitForJobAsync(api, started.value.JobId);

            assert.strictEqual(batchJob(status).State, 'completed');
            assert.strictEqual(batchJob(status).Response?.RolledBack, true);
            assert.ok(batchJob(status).Response?.RestoreError);
            assert.strictEqual(fs.readFileSync(propsPath, 'utf8'), propsBefore);
        });

        test('refuses to start a second job while one is running', async () => {
            setupWorkspace('unconditional-plus-conditional.props');
            skipRestoreConfig();

            const blocker = gate();
            sandbox.stub(CpmResolver, 'UpdateCpmVersionsAsync').callsFake(async () => {
                await blocker.wait;
            });

            const api = createHostAPI();
            const request = {
                Updates: [{
                    PackageId: 'Pkg.Shared',
                    Version: '1.5.0',
                    ProjectPaths: [projectPath],
                    Scope: 'unconditional' as const,
                }],
                Transactional: true,
                SkipRestore: true,
            };

            const first = await api.startBatchUpdateAsync(request);
            assert.ok(first.ok, first.ok ? '' : first.error);

            const second = await api.startBatchUpdateAsync(request);
            assert.strictEqual(second.ok, false);
            if (!second.ok) {
                assert.match(second.error, /already running/);
            }

            blocker.open();
            await waitForJobAsync(api, first.value.JobId);
        });

        test('cancel aborts the job and rolls back the writes it already applied', async () => {
            setupWorkspace('unconditional-plus-conditional.props');
            const propsPath = path.join(workspaceDir, 'Directory.Packages.props');
            const propsBefore = fs.readFileSync(propsPath, 'utf8');

            let written = false;
            let writeStarted!: () => void;
            const reachedWrite = new Promise<void>((resolve) => { writeStarted = resolve; });
            const blocker = gate();
            sandbox.stub(CpmResolver, 'UpdateCpmVersionsAsync').callsFake(async (propsFilePath) => {
                writeStarted();
                await blocker.wait;
                fs.writeFileSync(
                    propsFilePath,
                    fs.readFileSync(propsFilePath, 'utf8').replace('Version="1.0.0"', 'Version="1.5.0"')
                );
                written = true;
            });

            const api = createHostAPI();
            const started = await api.startBatchUpdateAsync({
                Updates: [{
                    PackageId: 'Pkg.Shared',
                    Version: '1.5.0',
                    ProjectPaths: [projectPath],
                    Scope: 'unconditional',
                }],
                Transactional: true,
                SkipRestore: true,
            });
            assert.ok(started.ok, started.ok ? '' : started.error);

            // Cancel only once the transaction is mid-write, so the abort has
            // something to roll back.
            await reachedWrite;
            const cancelled = await api.cancelJobAsync({ JobId: started.value.JobId });
            assert.ok(cancelled.ok, cancelled.ok ? '' : cancelled.error);

            // The runner is parked inside the CPM write, so let it finish the
            // iteration; the aborted signal then triggers the rollback.
            blocker.open();
            const status = await waitForJobAsync(api, started.value.JobId);

            assert.strictEqual(batchJob(status).State, 'cancelled');
            assert.strictEqual(batchJob(status).Response?.RolledBack, true);
            assert.strictEqual(batchJob(status).Response?.Cancelled, true);
            assert.strictEqual(written, true, 'the cancelled job must have written before rolling back');
            assert.strictEqual(fs.readFileSync(propsPath, 'utf8'), propsBefore);
        });

        test('runs a package update as a job', async () => {
            setupWorkspace('unconditional-plus-conditional.props');
            sandbox.stub(TaskExecutorDefault, 'ExecuteCommandAsync').resolves();
            stubProjectParsing(() => ({
                Path: projectPath,
                Name: 'App.csproj',
                CpmEnabled: true,
                Packages: [],
            } as Project));

            const api = createHostAPI();
            const started = await api.startProjectUpdateAsync({
                ProjectPath: projectPath,
                PackageId: 'Pkg.Shared',
                Version: '1.5.0',
                Type: 'UPDATE',
                CpmCondition: "$(TargetFramework.StartsWith('net10.0'))",
            });

            assert.ok(started.ok, started.ok ? '' : started.error);
            const status = await waitForJobAsync(api, started.value.JobId);
            assert.ok(status.ok);
            assert.strictEqual(status.value.Kind, 'projectUpdate');
            assert.strictEqual(status.value.State, 'completed');

            const map = await CpmResolver.ParseCpmFileAsync(path.join(workspaceDir, 'Directory.Packages.props'));
            const net10 = map.conditional.find((entry) => entry.framework === 'net10.0');
            assert.strictEqual(net10?.versions.get('Pkg.Shared'), '1.5.0');
            assert.strictEqual(map.unconditional.get('Pkg.Shared'), '1.0.0', 'the other line is untouched');
        });

        test('runs a consolidation as a job', async () => {
            setupWorkspace('unconditional-plus-conditional.props');
            skipRestoreConfig();

            const api = createHostAPI();
            const started = await api.startConsolidateAsync({
                PackageId: 'Pkg.Shared',
                TargetVersion: '3.0.0',
                ProjectPaths: [projectPath],
                Scope: 'unconditional',
            });

            assert.ok(started.ok, started.ok ? '' : started.error);
            const status = await waitForJobAsync(api, started.value.JobId);
            assert.ok(status.ok);
            assert.strictEqual(status.value.Kind, 'consolidate');
            assert.strictEqual(status.value.State, 'completed');

            const map = await CpmResolver.ParseCpmFileAsync(path.join(workspaceDir, 'Directory.Packages.props'));
            assert.strictEqual(map.unconditional.get('Pkg.Shared'), '3.0.0');
        });

        test('runs a cleanup as a job', async () => {
            setupWorkspace('unconditional-plus-conditional.props');
            sandbox.stub(vscode.workspace, 'findFiles').resolves([]);

            const api = createHostAPI();
            const started = await api.startCleanupAsync({});

            assert.ok(started.ok, started.ok ? '' : started.error);
            const status = await waitForJobAsync(api, started.value.JobId);
            assert.ok(status.ok);
            assert.strictEqual(status.value.Kind, 'cleanup');
            assert.strictEqual(status.value.State, 'completed');
            if (status.value.Kind === 'cleanup') {
                assert.deepStrictEqual(status.value.Response?.Removed, []);
            }
        });

        function writeAssets(libraries: Record<string, string>, edges: Record<string, Record<string, string>> = {}): void {
            const assetsLibraries: Record<string, { type: string }> = {};
            for (const [id, version] of Object.entries(libraries)) {
                assetsLibraries[`${id}/${version}`] = { type: 'package' };
            }
            const target: Record<string, { dependencies?: Record<string, string> }> = {};
            for (const [id, version] of Object.entries(libraries)) {
                target[`${id}/${version}`] = edges[id] ? { dependencies: edges[id] } : {};
            }
            fs.mkdirSync(path.join(workspaceDir, 'obj'), { recursive: true });
            fs.writeFileSync(
                path.join(workspaceDir, 'obj', 'project.assets.json'),
                JSON.stringify({ libraries: assetsLibraries, targets: { 'net10.0': target } })
            );
        }

        function stubPackageMetadataByVersion(
            packages: Record<string, Record<string, Array<{ package: string; versionRange: string }>>>
        ): void {
            // The assets graph keys packages by their lowercased id.
            const byLowerId = new Map(
                Object.entries(packages).map(([id, versions]) => [id.toLowerCase(), versions] as const)
            );
            const api = {
                GetPackageAsync: async (packageId: string) => ({
                    data: {
                        Versions: Object.entries(byLowerId.get(packageId.toLowerCase()) ?? {}).map(([version]) => ({
                            Id: `${packageId}@${version}`,
                            Version: version,
                        })),
                    },
                }),
                GetPackageDetailsAsync: async (versionId: string) => {
                    const at = versionId.lastIndexOf('@');
                    const packageId = versionId.slice(0, at);
                    const version = versionId.slice(at + 1);
                    return {
                        data: {
                            dependencies: {
                                frameworks: {
                                    'net10.0': byLowerId.get(packageId.toLowerCase())?.[version] ?? [],
                                },
                            },
                        },
                    };
                },
            };
            sandbox.stub(nugetApiFactory, 'GetSourceApiAsync').resolves(
                api as unknown as Awaited<ReturnType<typeof nugetApiFactory.GetSourceApiAsync>>
            );
            sandbox.stub(NuGetConfigResolver, 'GetSourcesAndDecodePasswordsAsync').resolves([
                { Name: 'nuget.org', Url: 'https://api.nuget.org/v3/index.json' },
            ]);
        }

        function stubPackageMetadata(
            version: string,
            dependencies: Array<{ package: string; versionRange: string }>
        ): void {
            const api = {
                GetPackageAsync: async (packageId: string) => ({
                    data: { Versions: [{ Id: `reg-${packageId}`, Version: version }] },
                }),
                GetPackageDetailsAsync: async () => ({
                    data: { dependencies: { frameworks: { 'net10.0': dependencies } } },
                }),
            };
            sandbox.stub(nugetApiFactory, 'GetSourceApiAsync').resolves(
                api as unknown as Awaited<ReturnType<typeof nugetApiFactory.GetSourceApiAsync>>
            );
            sandbox.stub(NuGetConfigResolver, 'GetSourcesAndDecodePasswordsAsync').resolves([
                { Name: 'nuget.org', Url: 'https://api.nuget.org/v3/index.json' },
            ]);
        }

        test('preflight reports a selected version that violates the graph', async () => {
            setupWorkspace('unconditional-plus-conditional.props');
            // The installed graph resolves Pkg.Leaf 2.0.0, but the new
            // Pkg.Shared 1.5.0 requires it at exactly 1.0.0.
            writeAssets({ 'Pkg.Shared': '1.0.0', 'Pkg.Leaf': '2.0.0' });
            stubPackageMetadata('1.5.0', [{ package: 'Pkg.Leaf', versionRange: '[1.0.0]' }]);

            const api = createHostAPI();
            const result = await api.checkBatchUpdateAsync({
                Updates: [{
                    PackageId: 'Pkg.Shared',
                    Version: '1.5.0',
                    ProjectPaths: [projectPath],
                    Scope: 'unconditional',
                }],
                Transactional: true,
            });

            assert.ok(result.ok, result.ok ? '' : result.error);
            assert.strictEqual(result.value.Conflicts.length, 1);
            const conflict = result.value.Conflicts[0]!;
            assert.strictEqual(conflict.PackageId, 'Pkg.Shared');
            assert.strictEqual(conflict.BlockedByPackageId, 'Pkg.Leaf');
            assert.strictEqual(conflict.RequiredRange, '[1.0.0]');
            assert.strictEqual(conflict.EffectiveVersion, '2.0.0');
            assert.match(conflict.Reason, /requires Pkg\.Leaf \[1\.0\.0\]/);
        });

        test('preflight accepts a compatible selection', async () => {
            setupWorkspace('unconditional-plus-conditional.props');
            writeAssets({ 'Pkg.Shared': '1.0.0', 'Pkg.Leaf': '2.0.0' });
            stubPackageMetadata('1.5.0', [{ package: 'Pkg.Leaf', versionRange: '[2.0.0, )' }]);

            const api = createHostAPI();
            const result = await api.checkBatchUpdateAsync({
                Updates: [{
                    PackageId: 'Pkg.Shared',
                    Version: '1.5.0',
                    ProjectPaths: [projectPath],
                    Scope: 'unconditional',
                }],
                Transactional: true,
            });

            assert.ok(result.ok, result.ok ? '' : result.error);
            assert.deepStrictEqual(result.value.Conflicts, []);
        });

        test('preflight reports installed ranges that the selection would break', async () => {
            setupWorkspace('unconditional-plus-conditional.props');
            // Pkg.Pinner pins Pkg.Shared to exactly 1.0.0 and is not updated.
            writeAssets(
                { 'Pkg.Shared': '1.0.0', 'Pkg.Pinner': '1.0.0' },
                { 'Pkg.Pinner': { 'Pkg.Shared': '[1.0.0]' } }
            );
            stubPackageMetadataByVersion({
                'Pkg.Shared': { '1.5.0': [] },
                'Pkg.Pinner': { '1.0.0': [{ package: 'Pkg.Shared', versionRange: '[1.0.0]' }] },
            });

            const api = createHostAPI();
            const result = await api.checkBatchUpdateAsync({
                Updates: [{
                    PackageId: 'Pkg.Shared',
                    Version: '1.5.0',
                    ProjectPaths: [projectPath],
                    Scope: 'unconditional',
                }],
                Transactional: true,
            });

            assert.ok(result.ok, result.ok ? '' : result.error);
            assert.strictEqual(result.value.Conflicts.length, 1);
            // A transitive package has no project-file casing to borrow.
            assert.strictEqual(result.value.Conflicts[0]!.BlockedByPackageId.toLowerCase(), 'pkg.pinner');
            assert.strictEqual(result.value.Conflicts[0]!.RequiredRange, '[1.0.0]');
        });

        test('a transactional batch defers non-CPM restores to the single final restore', async () => {
            setupWorkspace('unconditional-plus-conditional.props');
            const commands: string[][] = [];
            sandbox.stub(TaskExecutorDefault, 'ExecuteCommandAsync').callsFake(
                async (command: string, args: string[]) => {
                    commands.push([command, ...args]);
                }
            );

            const api = createHostAPI();
            const result = await api.batchUpdatePackagesAsync({
                Updates: [{
                    PackageId: 'Pkg.AddedOnly',
                    Version: '1.5.0',
                    ProjectPaths: [projectPath],
                }],
                Transactional: true,
                SkipRestore: false,
            });

            assert.ok(result.ok, result.ok ? '' : result.error);
            const adds = commands.filter(([, subcommand]) => subcommand === 'add');
            const restores = commands.filter(([, subcommand]) => subcommand === 'restore');
            assert.strictEqual(adds.length, 1, 'the non-CPM row goes through dotnet add');
            assert.ok(adds[0]!.includes('--no-restore'), 'the add must not restore on its own');
            assert.strictEqual(restores.length, 1, 'one restore covers the whole batch');
        });

        test('names the batch rows a failed restore points at', async () => {
            setupWorkspace('unconditional-plus-conditional.props');
            fs.writeFileSync(
                path.join(workspaceDir, 'Directory.Packages.props'),
                [
                    '<Project>',
                    '  <PropertyGroup>',
                    '    <ManagePackageVersionsCentrally>true</ManagePackageVersionsCentrally>',
                    '  </PropertyGroup>',
                    '  <ItemGroup>',
                    '    <PackageVersion Include="Microsoft.EntityFrameworkCore.Relational" Version="11.0.0-rc.2.26504.105" />',
                    '  </ItemGroup>',
                    '</Project>',
                ].join('\n')
            );

            const output = [
                '/ws/Sample.Api.csproj : error NU1107: Version conflict detected for Microsoft.EntityFrameworkCore.Relational. Install/reference Microsoft.EntityFrameworkCore.Relational 11.0.0-rc.3.26522.148 directly to project Sample.Api to resolve this issue.',
                '/ws/Sample.Api.csproj :  Sample.Api -> Npgsql.EntityFrameworkCore.PostgreSQL 11.0.0-rc.2 -> Microsoft.EntityFrameworkCore.Relational (= 11.0.0-rc.2.26504.105).',
            ].join('\n');
            sandbox.stub(TaskExecutorDefault, 'ExecuteCommandAsync').rejects(
                new DotnetError('dotnet exited with code 1', output)
            );

            const api = createHostAPI();
            const result = await api.batchUpdatePackagesAsync({
                Updates: [{
                    PackageId: 'Microsoft.EntityFrameworkCore.Relational',
                    Version: '11.0.0-rc.3.26522.148',
                    ProjectPaths: [projectPath],
                    Scope: 'unconditional',
                }],
                Transactional: true,
                SkipRestore: false,
            });

            assert.ok(result.ok, result.ok ? '' : result.error);
            assert.strictEqual(result.value.RolledBack, true);
            assert.deepStrictEqual(
                result.value.ConflictingPackages,
                ['Microsoft.EntityFrameworkCore.Relational'],
                'the contested package is a batch row, so the UI can offer a retry without it'
            );
        });

        test('streams the restore stage into the job progress', async () => {
            setupWorkspace('unconditional-plus-conditional.props');
            let releaseRestore!: () => void;
            const restoreGate = new Promise<void>((resolve) => { releaseRestore = resolve; });

            sandbox.stub(TaskExecutorDefault, 'ExecuteCommandAsync').callsFake(
                async (_command: string, args: string[], _operationId, _signal, _timeout, onProgress) => {
                    if (args[0] === 'restore') {
                        onProgress?.({ stage: 'Restoring packages...', percent: 40 });
                        await restoreGate;
                    }
                }
            );

            const api = createHostAPI();
            const started = await api.startBatchUpdateAsync({
                Updates: [{
                    PackageId: 'Pkg.Shared',
                    Version: '1.5.0',
                    ProjectPaths: [projectPath],
                    Scope: 'unconditional',
                }],
                Transactional: true,
                SkipRestore: false,
            });
            assert.ok(started.ok, started.ok ? '' : started.error);

            let status = await api.getJobAsync({ JobId: started.value.JobId });
            for (let i = 0; i < 400; i += 1) {
                if (status.ok && status.value.Stage.includes('Restoring packages')) break;
                await new Promise((resolve) => setTimeout(resolve, 5));
                status = await api.getJobAsync({ JobId: started.value.JobId });
            }

            assert.ok(status.ok);
            assert.match(status.value.Stage, /Restoring packages\.\.\. — App\.csproj \(1\/1\)/);
            assert.ok(status.value.Percent >= 80 && status.value.Percent <= 95, `percent ${status.value.Percent}`);

            releaseRestore();
            const finished = await waitForJobAsync(api, started.value.JobId);
            assert.strictEqual(batchJob(finished).State, 'completed');
        });

        test('reports an unknown job id and refuses to cancel one', async () => {
            const api = createHostAPI();

            const status = await api.getJobAsync({ JobId: 'missing' });
            assert.strictEqual(status.ok, false);

            const cancelled = await api.cancelJobAsync({ JobId: 'missing' });
            assert.strictEqual(cancelled.ok, false);
        });
    });

    // ----------------------------------------------------------------
    // Dependency-aware update suggestions
    // ----------------------------------------------------------------
    suite('dependency-aware updates', () => {
        let workspaceDir: string;
        let projectPath: string;

        setup(() => {
            workspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), 'host-constraints-'));
            projectPath = path.join(workspaceDir, 'App.csproj');
            fs.writeFileSync(projectPath, '<Project Sdk="Microsoft.NET.Sdk"></Project>');
            fs.mkdirSync(path.join(workspaceDir, 'obj'), { recursive: true });
            fs.writeFileSync(
                path.join(workspaceDir, 'obj', 'project.assets.json'),
                JSON.stringify({
                    libraries: {
                        'Microsoft.EntityFrameworkCore.Relational/11.0.0-rc.1.26425.128': { type: 'package' },
                        'Npgsql.EntityFrameworkCore.PostgreSQL/11.0.0-rc.2': { type: 'package' },
                    },
                    targets: {
                        'net11.0': {
                            'Npgsql.EntityFrameworkCore.PostgreSQL/11.0.0-rc.2': {
                                dependencies: {
                                    'Microsoft.EntityFrameworkCore.Relational': '11.0.0-rc.2.26504.105',
                                },
                            },
                        },
                    },
                })
            );

            sandbox.stub(vscode.workspace, 'workspaceFolders').value([{ uri: { fsPath: workspaceDir } }]);
            sandbox.stub(vscode.workspace, 'getConfiguration').returns({
                get: () => undefined,
            } as unknown as vscode.WorkspaceConfiguration);
            sandbox.stub(CpmResolver, 'FindCpmFilePathAsync').resolves(null);
            sandbox.stub(NuGetConfigResolver, 'GetSourcesAndDecodePasswordsAsync').resolves([
                { Name: 'nuget.org', Url: 'https://api.nuget.org/v3/index.json' },
            ]);
        });

        teardown(() => {
            fs.rmSync(workspaceDir, { recursive: true, force: true });
        });

        test('caps the suggested EF Core version to the pin declared by the installed provider', async () => {
            const project = {
                Name: 'App',
                Path: projectPath,
                CpmEnabled: false,
                Packages: [{
                    Id: 'Microsoft.EntityFrameworkCore.Relational',
                    Version: '11.0.0-rc.1.26425.128',
                    IsPinned: false,
                    CpmResolutions: [{
                        Tfm: 'net11.0',
                        Version: '11.0.0-rc.1.26425.128',
                        Condition: '',
                        ConditionLabel: 'net11.0',
                        Matched: true,
                    }],
                }, {
                    Id: 'Npgsql.EntityFrameworkCore.PostgreSQL',
                    Version: '11.0.0-rc.2',
                    IsPinned: false,
                    CpmResolutions: [{
                        Tfm: 'net11.0',
                        Version: '11.0.0-rc.2',
                        Condition: '',
                        ConditionLabel: 'net11.0',
                        Matched: true,
                    }],
                }],
            } as unknown as Project;
            stubProjectParsing(() => project);
            sandbox.stub(vscode.workspace, 'findFiles').resolves([{ fsPath: projectPath } as vscode.Uri]);

            const relationalVersions = [
                '11.0.0-rc.1.26425.128',
                '11.0.0-rc.2.26504.105',
                '11.0.0-rc.3.26522.148',
            ];
            const providerDependencies = {
                dependencies: {
                    frameworks: {
                        'net11.0': [{
                            package: 'Microsoft.EntityFrameworkCore.Relational',
                            versionRange: '[11.0.0-rc.2.26504.105]',
                        }],
                    },
                },
            };
            sandbox.stub(nugetApiFactory, 'GetSourceApiAsync').resolves({
                GetPackagesAsync: async (id: string) => ({
                    data: [{
                        Name: id,
                        Version: relationalVersions[relationalVersions.length - 1],
                        Versions: relationalVersions.map((version) => ({ Version: version, Id: `leaf-${version}` })),
                    }],
                }),
                GetPackageAsync: async () => ({
                    data: {
                        Name: 'Npgsql.EntityFrameworkCore.PostgreSQL',
                        Versions: [{ Version: '11.0.0-rc.2', Id: 'leaf-npgsql' }],
                    },
                }),
                GetPackageDetailsAsync: async () => ({ data: providerDependencies }),
            } as unknown as Awaited<ReturnType<typeof nugetApiFactory.GetSourceApiAsync>>);

            const api = createHostAPI();
            const result = await api.getOutdatedPackagesAsync({ ForceReload: false, Prerelease: true });

            assert.ok(result.ok, result.ok ? '' : result.error);
            const row = result.value.Packages.find((pkg) => pkg.Id === 'Microsoft.EntityFrameworkCore.Relational');
            assert.ok(row, 'the safe update must still be offered');
            assert.strictEqual(row!.LatestVersion, '11.0.0-rc.2.26504.105');
            assert.strictEqual(row!.LatestOverallVersion, '11.0.0-rc.3.26522.148');
            assert.deepStrictEqual(row!.BlockedBy, [{
                PackageId: 'Npgsql.EntityFrameworkCore.PostgreSQL',
                InstalledVersion: '11.0.0-rc.2',
                Range: '[11.0.0-rc.2.26504.105]',
            }]);
        });

        test('lists a fully blocked package with the version and the pinning dependency', async () => {
            const project = {
                Name: 'App',
                Path: projectPath,
                CpmEnabled: false,
                Packages: [{
                    Id: 'Microsoft.EntityFrameworkCore.Relational',
                    Version: '11.0.0-rc.2.26504.105',
                    IsPinned: false,
                    CpmResolutions: [{
                        Tfm: 'net11.0',
                        Version: '11.0.0-rc.2.26504.105',
                        Condition: '',
                        ConditionLabel: 'net11.0',
                        Matched: true,
                    }],
                }, {
                    Id: 'Npgsql.EntityFrameworkCore.PostgreSQL',
                    Version: '11.0.0-rc.2',
                    IsPinned: false,
                    CpmResolutions: [{
                        Tfm: 'net11.0',
                        Version: '11.0.0-rc.2',
                        Condition: '',
                        ConditionLabel: 'net11.0',
                        Matched: true,
                    }],
                }],
            } as unknown as Project;
            stubProjectParsing(() => project);
            sandbox.stub(vscode.workspace, 'findFiles').resolves([{ fsPath: projectPath } as vscode.Uri]);

            const relationalVersions = [
                '11.0.0-rc.1.26425.128',
                '11.0.0-rc.2.26504.105',
                '11.0.0-rc.3.26522.148',
            ];
            sandbox.stub(nugetApiFactory, 'GetSourceApiAsync').resolves({
                GetPackagesAsync: async (id: string) => ({
                    data: [{
                        Name: id,
                        Version: relationalVersions[relationalVersions.length - 1],
                        Versions: relationalVersions.map((version) => ({ Version: version, Id: `leaf-${version}` })),
                    }],
                }),
                GetPackageAsync: async () => ({
                    data: {
                        Name: 'Npgsql.EntityFrameworkCore.PostgreSQL',
                        Versions: [{ Version: '11.0.0-rc.2', Id: 'leaf-npgsql' }],
                    },
                }),
                GetPackageDetailsAsync: async () => ({
                    data: {
                        dependencies: {
                            frameworks: {
                                'net11.0': [{
                                    package: 'Microsoft.EntityFrameworkCore.Relational',
                                    versionRange: '[11.0.0-rc.2.26504.105]',
                                }],
                            },
                        },
                    },
                }),
            } as unknown as Awaited<ReturnType<typeof nugetApiFactory.GetSourceApiAsync>>);

            const api = createHostAPI();
            const result = await api.getOutdatedPackagesAsync({ ForceReload: false, Prerelease: true });

            assert.ok(result.ok, result.ok ? '' : result.error);
            const row = result.value.Packages.find((pkg) => pkg.Id === 'Microsoft.EntityFrameworkCore.Relational');
            assert.strictEqual(row, undefined, 'no unsafe version may be offered');

            const blocked = result.value.BlockedPackages?.find(
                (pkg) => pkg.Id === 'Microsoft.EntityFrameworkCore.Relational'
            );
            assert.ok(blocked, 'the conflict must stay visible');
            assert.strictEqual(blocked!.InstalledVersion, '11.0.0-rc.2.26504.105');
            assert.strictEqual(blocked!.BlockedVersion, '11.0.0-rc.3.26522.148');
            assert.match(blocked!.Reason, /Npgsql\.EntityFrameworkCore\.PostgreSQL/);
            assert.deepStrictEqual(blocked!.BlockedBy, [{
                PackageId: 'Npgsql.EntityFrameworkCore.PostgreSQL',
                InstalledVersion: '11.0.0-rc.2',
                Range: '[11.0.0-rc.2.26504.105]',
            }]);
        });
    });
});
