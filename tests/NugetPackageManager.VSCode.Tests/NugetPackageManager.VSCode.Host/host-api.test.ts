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
import type { CoreCallOptions } from '@/host/nuget/core-client';
import NuGetConfigResolver from '@/host/utilities/nuget-config-resolver';
import CpmReader, { type CpmPackageMap } from '@/host/utilities/cpm-reader';
import TaskExecutorDefault, { DotnetError } from '@/host/utilities/task-executor';
import { OperationJobs } from '@/host/utilities/operation-jobs';
import { outdatedScans } from '@/host/utilities/outdated-scan-coordinator';
import { workspaceSnapshot } from '@/host/utilities/workspace-snapshot';
import { ScanProgress } from '@/host/utilities/scan-progress';
import type { Result } from '@/common/rpc/result';
import type { GetJobResponse } from '@/common/rpc/types';
import { Logger } from '@/common/logger';

function fixturesRoot(): string {
    return repositoryPath('tests', 'NugetPackageManager.TestUtilities', 'Fixtures');
}

type CpmMapSpec = {
    unconditional?: Record<string, string>;
    conditional?: Array<{
        condition: string;
        framework: string;
        versions: Record<string, string>;
        order: number;
    }>;
};

function cpmMap(spec: CpmMapSpec = {}): CpmPackageMap {
    const conditional = (spec.conditional ?? []).map((entry) => ({
        ...entry,
        versions: new Map(Object.entries(entry.versions)),
    }));
    return {
        unconditional: new Map(Object.entries(spec.unconditional ?? {})),
        conditional,
        hasConditionalGroups: conditional.length > 0,
    };
}

/**
 * The maps the core would return for the fixtures these orchestration tests use. Parsing is pinned
 * by the core's CpmPropsReader tests, so here the map is plain test data.
 */
const FIXTURE_MAPS: Record<string, CpmPackageMap> = {
    'single-group.props': cpmMap({
        unconditional: { 'Newtonsoft.Json': '13.0.3', Serilog: '2.11.0' },
    }),
    'unconditional-plus-conditional.props': cpmMap({
        unconditional: { 'Pkg.Shared': '1.0.0', 'Pkg.UnconditionalOnly': '5.0.0' },
        conditional: [{
            condition: "$(TargetFramework.StartsWith('net10.0'))",
            framework: 'net10.0',
            versions: { 'Pkg.Shared': '2.0.0' },
            order: 3,
        }],
    }),
    'negated-positive.props': cpmMap({
        unconditional: {
            'Shared.Library': '1.0.0',
            'Aspire.Hosting.AppHost': '17.0.0-preview.1.26522.1',
        },
        conditional: [
            {
                condition: "!$(TargetFramework.StartsWith('net11.0'))",
                framework: 'not net11.0',
                versions: {
                    'Microsoft.Extensions.Logging': '10.0.13',
                    'Microsoft.Extensions.Hosting': '10.0.13',
                    'Microsoft.EntityFrameworkCore.Relational': '10.0.13',
                    'Npgsql.EntityFrameworkCore.PostgreSQL': '10.0.3',
                },
                order: 3,
            },
            {
                condition: "$(TargetFramework.StartsWith('net11.0'))",
                framework: 'net11.0',
                versions: {
                    'Microsoft.Extensions.Logging': '11.0.0-rc.2.26504.105',
                    'Microsoft.Extensions.Hosting': '11.0.0-rc.2.26504.105',
                    'Microsoft.EntityFrameworkCore.Relational': '11.0.0-rc.2.26504.105',
                    'Npgsql.EntityFrameworkCore.PostgreSQL': '11.0.0-rc.2',
                },
                order: 7,
            },
        ],
    }),
    'shared-id-positive-groups.props': cpmMap({
        conditional: [
            {
                condition: "$(TargetFramework.StartsWith('net8.0'))",
                framework: 'net8.0',
                versions: { 'Microsoft.Extensions.Http': '8.0.0', 'Microsoft.Extensions.Logging': '8.0.1' },
                order: 1,
            },
            {
                condition: "$(TargetFramework.StartsWith('net9.0'))",
                framework: 'net9.0',
                versions: { 'Microsoft.Extensions.Http': '9.0.0', 'Microsoft.Extensions.Logging': '9.0.1' },
                order: 3,
            },
        ],
    }),
};

/** Answers the host's CPM reads for the fixture instead of asking the (stubbed) core to parse. */
function stubCpmReader(
    sandbox: sinon.SinonSandbox,
    map: CpmPackageMap,
    propsPath: string
): void {
    sandbox.stub(CpmReader, 'FindCpmFilePathAsync').resolves(propsPath);
    sandbox.stub(CpmReader, 'ParseCpmFileAsync').resolves(map);
    sandbox.stub(CpmReader, 'GetFrameworkPackageMapAsync').resolves(map);
}

/**
 * Routes the core's calls for the host tests.
 *
 * `getProjects` is answered by whichever resolver the test installs with `stubProjectParsing`.
 * The CPM methods record the request the host made so the orchestration tests can assert on the
 * call; what the core does with it is pinned by the core's MSTest suite (including the golden
 * files in `tests/NugetPackageManager.TestUtilities/Fixtures/cpm/expected`).
 */
let projectResolver: ((projectPath: string) => Project | null) | null = null;

type CoreCall = { method: string; params: Record<string, unknown> };

let coreCalls: CoreCall[] = [];
let coreOverrides = new Map<
    string,
    (params: Record<string, unknown>, options?: CoreCallOptions) => unknown | Promise<unknown>
>();

function installCoreStub(sandbox: sinon.SinonSandbox): sinon.SinonStub {
    projectResolver = null;
    coreCalls = [];
    coreOverrides = new Map();

    return sandbox.stub(coreProcess, 'CallAsync').callsFake((async (
        method: string,
        params: Record<string, unknown>,
        _signal?: AbortSignal,
        options?: CoreCallOptions
    ) => {
        coreCalls.push({ method, params });
        const override = coreOverrides.get(method);
        if (override) {
            return override(params, options);
        }

        switch (method) {
            case 'getProjects': {
                const projects: Project[] = [];
                const projectPaths = (params as unknown as { projectPaths?: string[] }).projectPaths ?? [];
                for (const projectPath of projectPaths) {
                    const project = projectResolver?.(projectPath) ?? null;
                    if (project) projects.push(project);
                }

                // The real core streams one progress line per parsed project; the host's
                // forwarding is what these tests exercise, so the stub does the same.
                const total = projectPaths.length;
                for (let index = 0; index < total; index += 1) {
                    options?.onProgress?.({
                        stage: `Parsing projects (${index + 1}/${total})…`,
                        percent: Math.round(((index + 1) / Math.max(1, total)) * 100),
                        completed: index + 1,
                        total,
                    });
                }

                return projects;
            }

            case 'updateCpmVersions':
                return { applied: (params as unknown as { changes: unknown[] }).changes.length };

            case 'resolveCpmWriteTargets':
                // By default the write plan touches only the props file, which the snapshot set
                // already includes. Tests that need a property file override this via stubCoreCall.
                return { files: [] };

            case 'removePackageVersion':
                return { removed: true };

            case 'updatePackageVersion':
                return { updated: true };

            case 'getRestoredDirectDependencies':
                return { DirectByTfm: {}, HasDirectSection: false };

            case 'computeRequirementClosure':
                return { Conflicts: [], Planned: {} };

            case 'orderRequirements':
                return { orders: {} };

            case 'analyzeProjectDependencies':
                return { Issues: [], Skipped: true, Reason: 'project has not been restored' };

            case 'classifyDotnetFailure': {
                const output = (params as unknown as { output?: string }).output ?? '';
                return { Kind: 'Unknown', Summary: output, Hint: '', Detail: output };
            }

            default:
                throw new Error(`unexpected core method: ${method}`);
        }
    }) as never);
}

/** Replaces one core method for the current test, e.g. to simulate the write a restore then fails on. */
function stubCoreCall(
    method: string,
    handler: (params: Record<string, unknown>, options?: CoreCallOptions) => unknown | Promise<unknown>
): void {
    coreOverrides.set(method, handler);
}

/** The params of every recorded call to one core method, in order. */
function coreCallsTo(method: string): Array<Record<string, unknown>> {
    return coreCalls.filter((call) => call.method === method).map((call) => call.params);
}

let coreStub: sinon.SinonStub | undefined;

/** Installs the projects the core should report; the router is created in `setup`. */
function stubProjectParsing(
    resolve: (projectPath: string) => Project | null
): sinon.SinonStub {
    projectResolver = resolve;
    return coreStub as sinon.SinonStub;
}

/** Polls a host job until it leaves `running`, the way every view does. */
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

        // The snapshot, the scan coordinator and the progress registry are module-level state
        // shared by every `createHostAPI()` caller, so each test starts from a clean workspace.
        workspaceSnapshot.Reset();
        outdatedScans.Reset();
        ScanProgress.Reset();
        // The snapshot arms a file watcher; these tests must not leave real ones behind.
        sandbox.stub(vscode.workspace, 'createFileSystemWatcher').returns({
            onDidChange: () => ({ dispose: () => undefined }),
            onDidCreate: () => ({ dispose: () => undefined }),
            onDidDelete: () => ({ dispose: () => undefined }),
            dispose: () => undefined,
        } as unknown as vscode.FileSystemWatcher);

        // The in-process path is what these tests exercise; the .NET core has its own suite.
        coreConfigured = false;
        sandbox.stub(coreProcess, 'IsConfigured').get(() => coreConfigured);
        coreStub = installCoreStub(sandbox);
    });

    teardown(() => {
        workspaceSnapshot.Reset();
        outdatedScans.Reset();
        ScanProgress.Reset();
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

        test('parses the whole workspace in exactly one getProjects core call', async () => {
            const uris = [
                { fsPath: '/ws/A.csproj' } as vscode.Uri,
                { fsPath: '/ws/B.csproj' } as vscode.Uri,
                { fsPath: '/ws/C.csproj' } as vscode.Uri,
            ];
            sandbox.stub(vscode.workspace, 'findFiles').resolves(uris);
            stubProjectParsing((projectPath) =>
                ({ Name: projectPath, Path: projectPath, Packages: [], CpmEnabled: false } as Project)
            );

            const api = createHostAPI();
            const result = await api.getProjectsAsync({});

            assert.ok(result.ok);
            assert.strictEqual(result.value.Projects.length, 3);

            const parseCalls = coreCallsTo('getProjects');
            assert.strictEqual(parseCalls.length, 1, 'the whole workspace must be one core call');
            assert.deepStrictEqual(parseCalls[0]!.projectPaths, [
                '/ws/A.csproj',
                '/ws/B.csproj',
                '/ws/C.csproj',
            ]);
            assert.strictEqual(parseCalls[0]!.reportProgress, true);
        });

        test('reports a cancelled caller as a cancel instead of a parse failure', async () => {
            // The project tree starts the job and the request may be cancelled mid-flight; that is
            // not the core failing to parse the workspace.
            const controller = new AbortController();
            controller.abort();
            const errorLog = Logger.error as unknown as sinon.SinonStub;

            const result = await createHostAPI().getProjectsAsync({}, controller.signal);

            assert.ok(!result.ok);
            assert.strictEqual(result.error, 'The request was cancelled.');
            assert.strictEqual(errorLog.callCount, 0);
        });
    });

    // ----------------------------------------------------------------
    // workspaceScan job
    // ----------------------------------------------------------------
    suite('workspaceScan job', () => {
        function projectAt(projectPath: string): Project {
            return {
                Name: path.basename(projectPath, path.extname(projectPath)),
                Path: projectPath,
                Packages: [],
                CpmEnabled: false,
            } as Project;
        }

        function scanStatus(status: Result<GetJobResponse>) {
            assert.ok(status.ok, status.ok ? '' : status.error);
            if (status.value.Kind !== 'workspaceScan') {
                throw new Error(`Unexpected job kind: ${status.value.Kind}`);
            }
            return status.value;
        }

        test('completes a job with the parsed project list', async () => {
            const projectUris = [
                { fsPath: '/ws/A/A.csproj' } as vscode.Uri,
                { fsPath: '/ws/B/B.csproj' } as vscode.Uri,
            ];
            sandbox.stub(vscode.workspace, 'findFiles').resolves(projectUris);
            stubProjectParsing((projectPath) => projectAt(projectPath));

            const api = createHostAPI();
            const started = await api.startWorkspaceScanAsync({});
            assert.ok(started.ok, started.ok ? '' : started.error);

            const status = scanStatus(await waitForJobAsync(api, started.value.JobId));

            assert.strictEqual(status.State, 'completed');
            assert.strictEqual(status.Percent, 100);
            assert.deepStrictEqual(
                status.Response?.Projects.map((project) => project.Name).sort(),
                ['A', 'B']
            );
            assert.strictEqual(
                coreCallsTo('getProjects').length,
                1,
                'the scan parses the workspace in one core call'
            );
        });

        test('applies the solution restriction to the scanned projects', async () => {
            const workspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), 'host-workspace-scan-'));
            const solutionPath = path.join(workspaceDir, 'App.sln');
            fs.writeFileSync(
                solutionPath,
                [
                    'Microsoft Visual Studio Solution File, Format Version 12.00',
                    'Project("{9A19103F-16F7-4668-BE54-9A1E7A4F7556}") = "A", "src\\A\\A.csproj", "{11111111-1111-1111-1111-111111111111}"',
                    'EndProject',
                ].join('\n'),
                'utf8'
            );

            try {
                const inSolution = { fsPath: path.join(workspaceDir, 'src', 'A', 'A.csproj') } as vscode.Uri;
                const outside = { fsPath: path.join(workspaceDir, 'tools', 'B.csproj') } as vscode.Uri;
                sandbox.stub(vscode.workspace, 'findFiles').callsFake(
                    (async (include: vscode.GlobPattern) => (
                        include === '*.{sln,slnx}'
                            ? [{ fsPath: solutionPath } as vscode.Uri]
                            : [inSolution, outside]
                    )) as typeof vscode.workspace.findFiles
                );
                stubProjectParsing((projectPath) => projectAt(projectPath));

                const api = createHostAPI();
                const started = await api.startWorkspaceScanAsync({});
                assert.ok(started.ok, started.ok ? '' : started.error);

                const status = scanStatus(await waitForJobAsync(api, started.value.JobId));

                assert.strictEqual(status.State, 'completed');
                assert.deepStrictEqual(
                    status.Response?.Projects.map((project) => project.Path),
                    [path.join(workspaceDir, 'src', 'A', 'A.csproj')],
                    'only the projects the solution references are scanned'
                );
            } finally {
                fs.rmSync(workspaceDir, { recursive: true, force: true });
            }
        });

        test('reports the core parse progress on the job', async () => {
            const projectUris = [
                { fsPath: '/ws/A/A.csproj' } as vscode.Uri,
                { fsPath: '/ws/B/B.csproj' } as vscode.Uri,
                { fsPath: '/ws/C/C.csproj' } as vscode.Uri,
            ];
            sandbox.stub(vscode.workspace, 'findFiles').resolves(projectUris);

            let releaseParse!: () => void;
            const parseGate = new Promise<void>((resolve) => { releaseParse = resolve; });

            stubCoreCall('getProjects', async (params, options) => {
                const projectPaths = (params as { projectPaths?: string[] }).projectPaths ?? [];
                options?.onProgress?.({
                    stage: 'Parsing projects (2/3)…',
                    percent: 67,
                    completed: 2,
                    total: 3,
                });
                await parseGate;
                return projectPaths.map((projectPath) => projectAt(projectPath));
            });

            const api = createHostAPI();
            const started = await api.startWorkspaceScanAsync({});
            assert.ok(started.ok, started.ok ? '' : started.error);

            let status = await api.getJobAsync({ JobId: started.value.JobId });
            for (let i = 0; i < 400; i += 1) {
                if (status.ok && status.value.Stage.startsWith('Parsing projects')) break;
                await new Promise((resolve) => setTimeout(resolve, 5));
                status = await api.getJobAsync({ JobId: started.value.JobId });
            }

            assert.ok(status.ok);
            assert.strictEqual(status.value.Stage, 'Parsing projects (2/3)…');
            assert.strictEqual(status.value.Percent, 67);

            releaseParse();
            const finished = scanStatus(await waitForJobAsync(api, started.value.JobId));
            assert.strictEqual(finished.State, 'completed');
            assert.strictEqual(finished.Response?.Projects.length, 3);
        });

        test('fails the job when the core parses none of the discovered projects', async () => {
            sandbox.stub(vscode.workspace, 'findFiles').resolves([
                { fsPath: '/ws/A/A.csproj' } as vscode.Uri,
            ]);
            stubProjectParsing(() => null);

            const api = createHostAPI();
            const started = await api.startWorkspaceScanAsync({});
            assert.ok(started.ok, started.ok ? '' : started.error);

            const status = scanStatus(await waitForJobAsync(api, started.value.JobId));

            assert.strictEqual(status.State, 'failed');
            assert.match(status.Error ?? '', /could not parse any of the 1 project/);
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
            assert.strictEqual(result.value.Packages[0]!.SourceUrl, 'https://api.nuget.org/v3/index.json');
        });

        test('tags each search result with the source that returned it', async () => {
            const sources = [
                { Name: 'one', Url: 'https://one.example/v3/index.json' },
                { Name: 'two', Url: 'https://two.example/v3/index.json' },
            ];
            sandbox.stub(vscode.workspace, 'workspaceFolders').value([{ uri: { fsPath: '/ws' } }]);
            sandbox.stub(NuGetConfigResolver, 'GetSourcesAndDecodePasswordsAsync').resolves(sources);
            sandbox.stub(nugetApiFactory, 'GetSourceApiAsync').callsFake(async (url: string) => ({
                GetPackagesAsync: async () => ({
                    data: [{
                        Id: url.includes('one') ? 'One.Pkg' : 'Two.Pkg',
                        Name: url.includes('one') ? 'One.Pkg' : 'Two.Pkg',
                        Version: '1.0.0',
                    }],
                }),
            }) as unknown as Awaited<ReturnType<typeof nugetApiFactory.GetSourceApiAsync>>);

            const api = createHostAPI();
            const result = await api.getPackagesAsync({
                Url: '',
                Filter: 'pkg',
                Prerelease: false,
                Skip: 0,
                Take: 20,
            });

            assert.ok(result.ok);
            const byId = new Map(result.value.Packages.map((pkg) => [pkg.Id, pkg.SourceUrl]));
            assert.strictEqual(byId.get('One.Pkg'), sources[0]!.Url);
            assert.strictEqual(byId.get('Two.Pkg'), sources[1]!.Url);
        });
    });

    // ----------------------------------------------------------------
    // getPackage — cross-source popularity fallback
    // ----------------------------------------------------------------
    suite('getPackage across sources', () => {
        const OFFLINE_URL = 'https://offline.example/v3/index.json';
        const NUGET_URL = 'https://api.nuget.org/v3/index.json';

        /**
         * The copy served by the offline feed in the report: the package, but no
         * SearchQueryService, so no popularity data and only the one version it has.
         */
        function offlinePackage(): Package {
            return {
                Id: 'Coverlet.Collector',
                Name: 'Coverlet.Collector',
                Authors: ['Coverlet'],
                Description: 'Served by the offline feed',
                IconUrl: '',
                LicenseUrl: '',
                ProjectUrl: '',
                Registration: '',
                TotalDownloads: null,
                Verified: null,
                InstalledVersion: '6.0.0',
                Version: '6.0.0',
                Versions: [{ Version: '6.0.0', Downloads: null }, { Version: '6.0.1' }],
                Tags: [],
            };
        }

        /** The nuget.org copy: popularity data, and a version the offline feed lacks. */
        function nugetPackage(): Package {
            return {
                Id: 'Coverlet.Collector',
                Name: 'Coverlet.Collector',
                Authors: ['Coverlet'],
                Description: 'Served by nuget.org',
                IconUrl: '',
                LicenseUrl: '',
                ProjectUrl: '',
                Registration: '',
                TotalDownloads: 1122400000,
                Verified: true,
                InstalledVersion: '',
                Version: '7.0.0',
                Versions: [
                    { Version: '6.0.0', Downloads: 100 },
                    { Version: '6.0.1', Downloads: 200 },
                    { Version: '7.0.0', Downloads: 300 },
                ],
                Tags: [],
            };
        }

        function stubSources(
            packages: Record<string, () => Package | undefined>
        ): { offline: sinon.SinonStub; nuget: sinon.SinonStub } {
            sandbox.stub(vscode.workspace, 'workspaceFolders').value([{ uri: { fsPath: '/ws' } }]);
            sandbox.stub(NuGetConfigResolver, 'GetSourcesAndDecodePasswordsAsync').resolves([
                { Name: 'Microsoft Visual Studio Offline Packages', Url: OFFLINE_URL },
                { Name: 'nuget.org', Url: NUGET_URL },
            ]);

            const makeGetPackage = (url: string): sinon.SinonStub =>
                sandbox.stub().callsFake(async () => {
                    const data = packages[url]?.();
                    return data
                        ? { data, isError: false, errorMessage: undefined }
                        : { data: undefined, isError: true, errorMessage: "Package couldn't be found" };
                });
            const offline = makeGetPackage(OFFLINE_URL);
            const nuget = makeGetPackage(NUGET_URL);

            // The configured order decides which feed answers first.
            const factory = sandbox.stub(nugetApiFactory, 'GetSourceApiAsync');
            factory.onCall(0).resolves(
                { GetPackageAsync: offline } as unknown as Awaited<ReturnType<typeof nugetApiFactory.GetSourceApiAsync>>
            );
            factory.onCall(1).resolves(
                { GetPackageAsync: nuget } as unknown as Awaited<ReturnType<typeof nugetApiFactory.GetSourceApiAsync>>
            );

            return { offline, nuget };
        }

        test('merges popularity from a later feed but keeps the serving source and versions', async () => {
            stubSources({ [OFFLINE_URL]: offlinePackage, [NUGET_URL]: nugetPackage });

            const result = await createHostAPI().getPackageAsync({
                Url: '',
                Id: 'Coverlet.Collector',
                Prerelease: false,
            });

            assert.ok(result.ok, result.ok ? '' : result.error);
            assert.strictEqual(result.value.SourceUrl, OFFLINE_URL, 'the source badge stays the serving feed');

            const pkg = result.value.Package;
            assert.strictEqual(pkg.Description, 'Served by the offline feed');
            assert.deepStrictEqual(pkg.Versions.map((version) => version.Version), ['6.0.0', '6.0.1']);
            assert.strictEqual(pkg.TotalDownloads, 1122400000);
            assert.strictEqual(pkg.Verified, true);
            assert.strictEqual(pkg.Versions[0]!.Downloads, 100);
            assert.strictEqual(pkg.Versions[1]!.Downloads, 200);
        });

        test('stops at the first feed that publishes popularity data', async () => {
            const { nuget } = stubSources({ [OFFLINE_URL]: nugetPackage, [NUGET_URL]: offlinePackage });

            const result = await createHostAPI().getPackageAsync({
                Url: '',
                Id: 'Coverlet.Collector',
                Prerelease: false,
            });

            assert.ok(result.ok, result.ok ? '' : result.error);
            assert.strictEqual(result.value.SourceUrl, OFFLINE_URL);
            assert.strictEqual(result.value.Package.TotalDownloads, 1122400000);
            assert.strictEqual(nuget.called, false, 'no second feed is contacted once popularity is known');
        });

        test('keeps the package with null popularity when no feed has any', async () => {
            stubSources({ [OFFLINE_URL]: offlinePackage, [NUGET_URL]: offlinePackage });

            const result = await createHostAPI().getPackageAsync({
                Url: '',
                Id: 'Coverlet.Collector',
                Prerelease: false,
            });

            assert.ok(result.ok, result.ok ? '' : result.error);
            assert.strictEqual(result.value.Package.TotalDownloads, null);
            assert.strictEqual(result.value.Package.Verified, null);
        });

        test('fails when no configured feed knows the package', async () => {
            stubSources({});

            const result = await createHostAPI().getPackageAsync({
                Url: '',
                Id: 'Coverlet.Collector',
                Prerelease: false,
            });

            assert.ok(!result.ok);
            assert.match(result.error, /any source/);
        });

        test('fills popularity for a duplicate search hit instead of dropping it', async () => {
            sandbox.stub(vscode.workspace, 'workspaceFolders').value([{ uri: { fsPath: '/ws' } }]);
            sandbox.stub(NuGetConfigResolver, 'GetSourcesAndDecodePasswordsAsync').resolves([
                { Name: 'Microsoft Visual Studio Offline Packages', Url: OFFLINE_URL },
                { Name: 'nuget.org', Url: NUGET_URL },
            ]);

            const factory = sandbox.stub(nugetApiFactory, 'GetSourceApiAsync');
            factory.onCall(0).resolves(
                { GetPackagesAsync: async () => ({ data: [offlinePackage()] }) } as unknown as Awaited<
                    ReturnType<typeof nugetApiFactory.GetSourceApiAsync>
                >
            );
            factory.onCall(1).resolves(
                { GetPackagesAsync: async () => ({ data: [nugetPackage()] }) } as unknown as Awaited<
                    ReturnType<typeof nugetApiFactory.GetSourceApiAsync>
                >
            );

            const result = await createHostAPI().getPackagesAsync({
                Url: '',
                Filter: 'coverlet',
                Prerelease: false,
                Skip: 0,
                Take: 20,
            });

            assert.ok(result.ok, result.ok ? '' : result.error);
            assert.strictEqual(result.value.Packages.length, 1);

            const row = result.value.Packages[0]!;
            assert.strictEqual(row.Description, 'Served by the offline feed');
            assert.deepStrictEqual(row.Versions.map((version) => version.Version), ['6.0.0', '6.0.1']);
            assert.strictEqual(row.TotalDownloads, 1122400000);
            assert.strictEqual(row.Versions[0]!.Downloads, 100);
        });
    });

    // ----------------------------------------------------------------
    // getPackageFrameworks
    // ----------------------------------------------------------------
    suite('getPackageFrameworks', () => {
        test('passes the id, version and source through and returns the groups', async () => {
            const groups: PackageFrameworkGroup[] = [{
                Product: '.NET',
                Frameworks: [
                    { Name: 'net8.0', IsComputed: false },
                    { Name: 'net9.0', IsComputed: true },
                ],
            }];
            const getFrameworks = sandbox.stub().resolves({ data: { Groups: groups } });
            const factory = sandbox.stub(nugetApiFactory, 'GetSourceApiAsync').resolves(
                { GetPackageFrameworksAsync: getFrameworks } as unknown as Awaited<
                    ReturnType<typeof nugetApiFactory.GetSourceApiAsync>
                >
            );

            const result = await createHostAPI().getPackageFrameworksAsync({
                Url: 'https://api.nuget.org/v3/index.json',
                Id: 'Serilog',
                Version: '4.0.0',
            });

            assert.ok(result.ok, result.ok ? '' : result.error);
            assert.deepStrictEqual(result.value.Groups, groups);
            assert.ok(factory.calledOnceWith('https://api.nuget.org/v3/index.json'));
            assert.ok(getFrameworks.calledOnceWith('Serilog', '4.0.0'));
        });

        test('requires a source url', async () => {
            const result = await createHostAPI().getPackageFrameworksAsync({
                Url: '',
                Id: 'Serilog',
                Version: '4.0.0',
            });

            assert.ok(!result.ok);
            assert.match(result.error, /SourceUrl/);
        });

        test('reports a source failure instead of an empty list', async () => {
            sandbox.stub(nugetApiFactory, 'GetSourceApiAsync').resolves(
                {
                    GetPackageFrameworksAsync: sandbox.stub().rejects(new Error('package not found')),
                } as unknown as Awaited<ReturnType<typeof nugetApiFactory.GetSourceApiAsync>>
            );

            const result = await createHostAPI().getPackageFrameworksAsync({
                Url: 'file:///ws/local-feed',
                Id: 'Local.Test',
                Version: '1.0.0',
            });

            assert.ok(!result.ok);
            assert.match(result.error, /package not found/);
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
            return mockApi;
        }

        setup(() => {
            sandbox.stub(vscode.workspace, 'workspaceFolders').value([{ uri: { fsPath: '/ws' } }]);
            sandbox.stub(NuGetConfigResolver, 'GetSourcesAndDecodePasswordsAsync').resolves([
                { Name: 'nuget.org', Url: 'https://api.nuget.org/v3/index.json' },
            ]);
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

        test('shares one core parse and one scan across three concurrent callers', async () => {
            // The badge, the packages view and the Updates tab all ask at activation; they must
            // not each run their own discovery + parse.
            const uris = [makeProjectUri('/ws/A.csproj'), makeProjectUri('/ws/B.csproj')];
            let releaseDiscovery: (() => void) | undefined;
            const discoveryGate = new Promise<void>((resolve) => { releaseDiscovery = resolve; });
            sandbox.stub(vscode.workspace, 'findFiles').callsFake(async () => {
                await discoveryGate;
                return uris;
            });
            stubProjectParsing((projectPath) =>
                projectPath === '/ws/A.csproj'
                    ? makeProject('A', '/ws/A.csproj', '1.0.0')
                    : makeProject('B', '/ws/B.csproj', '2.0.0')
            );
            setupNugetApi('2.0.0');

            const api = createHostAPI();
            const scans = [
                api.getOutdatedPackagesAsync({ ForceReload: false, Prerelease: false, ScanId: 'scan-1' }),
                api.getOutdatedPackagesAsync({ ForceReload: false, Prerelease: false, ScanId: 'scan-2' }),
                api.getOutdatedPackagesAsync({ ForceReload: false, Prerelease: false, ScanId: 'scan-3' }),
            ];
            // Hold discovery open until every caller has had a turn to attach.
            setTimeout(() => releaseDiscovery!(), 0);
            const results = await Promise.all(scans);

            for (const result of results) {
                assert.ok(result.ok);
                assert.strictEqual(result.value.Packages.length, 1);
            }
            assert.strictEqual(coreCallsTo('getProjects').length, 1);
        });

        test('forwards the core parse progress into the scan report', async () => {
            const uris = [makeProjectUri('/ws/A.csproj'), makeProjectUri('/ws/B.csproj')];
            sandbox.stub(vscode.workspace, 'findFiles').resolves(uris);
            stubProjectParsing((projectPath) =>
                projectPath === '/ws/A.csproj'
                    ? makeProject('A', '/ws/A.csproj', '1.0.0')
                    : makeProject('B', '/ws/B.csproj', '2.0.0')
            );
            setupNugetApi('2.0.0');

            const reported: Array<{ stage: string; percent: number }> = [];
            sandbox.stub(ScanProgress, 'Report').callsFake((_scanId, stage, percent) => {
                reported.push({ stage, percent });
            });

            const api = createHostAPI();
            const result = await api.getOutdatedPackagesAsync({
                ForceReload: false,
                Prerelease: false,
                ScanId: 'scan-parse-progress',
            });

            assert.ok(result.ok);
            const parseStages = reported.filter((entry) => entry.stage.startsWith('Parsing projects ('));
            assert.deepStrictEqual(
                parseStages.map((entry) => entry.stage),
                ['Parsing projects (1/2)…', 'Parsing projects (2/2)…']
            );
            // The core's completed/total drive the 4-30% slice the parse owns in the scan.
            assert.strictEqual(parseStages[1]!.percent, 30);
        });

        test('reports a cancelled caller as a cancel instead of a scan failure', async () => {
            // `RpcHost` aborts the handler's signal when the webview cancels the request; the
            // shared scan keeps running, so nothing failed and nothing is logged at ERROR.
            const controller = new AbortController();
            controller.abort();
            const errorLog = Logger.error as unknown as sinon.SinonStub;

            const result = await createHostAPI().getOutdatedPackagesAsync(
                { Prerelease: false },
                controller.signal
            );

            assert.ok(!result.ok);
            assert.strictEqual(result.error, 'The request was cancelled.');
            assert.strictEqual(errorLog.callCount, 0);
        });

        test('keys a view scan over every project as the badge scan so one run answers both', async () => {
            const uris = [makeProjectUri('/ws/A.csproj'), makeProjectUri('/ws/B.csproj')];
            sandbox.stub(vscode.workspace, 'findFiles').resolves(uris);
            stubProjectParsing((projectPath) =>
                projectPath === '/ws/A.csproj'
                    ? makeProject('A', '/ws/A.csproj', '1.0.0')
                    : makeProject('B', '/ws/B.csproj', '2.0.0')
            );
            const sourceApi = setupNugetApi('2.0.0');

            const api = createHostAPI();
            // Prime the shared snapshot the way the project tree does: only then do the views know
            // every project file, which is what lets their project list collapse to the badge's.
            const projects = await api.getProjectsAsync({});
            assert.ok(projects.ok);
            assert.strictEqual(coreCallsTo('getProjects').length, 1);

            const [badge, view] = await Promise.all([
                // The badge: no ProjectPaths.
                api.getOutdatedPackagesAsync({ Prerelease: false }),
                // The views: every discovered project path.
                api.getOutdatedPackagesAsync({
                    Prerelease: false,
                    ProjectPaths: projects.value.Projects.map((project) => project.Path),
                }),
            ]);

            assert.ok(badge.ok);
            assert.ok(view.ok);
            // One scan and one parse for both: the view attached to the badge's run.
            assert.strictEqual(coreCallsTo('getProjects').length, 1);
            assert.strictEqual(sourceApi.GetPackagesAsync.callCount, 1);
            assert.strictEqual(badge.value.Packages.length, 1);
            assert.deepStrictEqual(view.value.Packages.map((pkg) => pkg.Id), ['Newtonsoft.Json']);
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

        test('a successful update hides the pre-update scan from a PreferCache read', async () => {
            const uri = makeProjectUri('/ws/A.csproj');
            sandbox.stub(vscode.workspace, 'findFiles').resolves([uri]);
            stubProjectParsing(() => makeProject('A', '/ws/A.csproj', '1.0.0'));
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
            assert.strictEqual(live.value.Packages.length, 1, 'the live scan is persisted for the next activation');

            // A non-CPM single update: the write and the restore are `dotnet add package` / `dotnet restore`.
            sandbox.stub(CpmReader, 'FindCpmFilePathAsync').resolves(null);
            sandbox.stub(CpmReader, 'GetFrameworkPackageMapAsync').resolves(null);
            sandbox.stub(TaskExecutorDefault, 'ExecuteCommandAsync').resolves();

            const update = await createHostAPI(context).updateProjectAsync({
                ProjectPath: '/ws/A.csproj',
                PackageId: 'Newtonsoft.Json',
                Version: '2.0.0',
                Type: 'UPDATE',
            });
            assert.ok(update.ok, update.ok ? '' : update.error);

            // The scan taken before the update must not be repainted as if it were current.
            const cached = await createHostAPI(context).getOutdatedPackagesAsync({ Prerelease: false, PreferCache: true });
            assert.ok(cached.ok);
            assert.strictEqual(cached.value.FromCache, true);
            assert.strictEqual(cached.value.Packages.length, 0);
        });
    });

    // ----------------------------------------------------------------
    // outdatedScan job
    // ----------------------------------------------------------------
    suite('outdatedScan job', () => {
        function makeProjectUri(fsPath: string): vscode.Uri {
            return { fsPath } as vscode.Uri;
        }

        function makeProject(name: string, projectPath: string, version: string): Project {
            return {
                Name: name,
                Path: projectPath,
                CpmEnabled: false,
                Packages: [{ Id: 'Newtonsoft.Json', Version: version, IsPinned: false }],
            } as unknown as Project;
        }

        function setupNugetApi(latestVersion: string): sinon.SinonStub {
            const mockApi = {
                GetPackagesAsync: sandbox.stub().resolves({
                    data: [{ Name: 'Newtonsoft.Json', Id: 'Newtonsoft.Json', Version: latestVersion }],
                }),
            };
            sandbox.stub(nugetApiFactory, 'GetSourceApiAsync').resolves(
                mockApi as unknown as Awaited<ReturnType<typeof nugetApiFactory.GetSourceApiAsync>>
            );
            return mockApi.GetPackagesAsync;
        }

        function outdatedStatus(status: Result<GetJobResponse>) {
            assert.ok(status.ok, status.ok ? '' : status.error);
            if (status.value.Kind !== 'outdatedScan') {
                throw new Error(`Unexpected job kind: ${status.value.Kind}`);
            }
            return status.value;
        }

        setup(() => {
            sandbox.stub(vscode.workspace, 'workspaceFolders').value([{ uri: { fsPath: '/ws' } }]);
            sandbox.stub(NuGetConfigResolver, 'GetSourcesAndDecodePasswordsAsync').resolves([
                { Name: 'nuget.org', Url: 'https://api.nuget.org/v3/index.json' },
            ]);
        });

        teardown(() => {
            OperationJobs.Reset();
        });

        test('completes a job with the scan response', async () => {
            sandbox.stub(vscode.workspace, 'findFiles').resolves([
                makeProjectUri('/ws/A.csproj'),
                makeProjectUri('/ws/B.csproj'),
            ]);
            stubProjectParsing((projectPath) => (
                projectPath === '/ws/A.csproj'
                    ? makeProject('A', '/ws/A.csproj', '1.0.0')
                    : makeProject('B', '/ws/B.csproj', '2.0.0')
            ));
            setupNugetApi('2.0.0');

            const api = createHostAPI();
            const started = await api.startOutdatedScanAsync({ ForceReload: false, Prerelease: false });
            assert.ok(started.ok, started.ok ? '' : started.error);

            const status = outdatedStatus(await waitForJobAsync(api, started.value.JobId));

            assert.strictEqual(status.State, 'completed');
            assert.strictEqual(status.Percent, 100);
            assert.strictEqual(status.Response?.Packages.length, 1);
            assert.strictEqual(status.Response?.Packages[0]!.Id, 'Newtonsoft.Json');
            assert.strictEqual(status.Response?.Packages[0]!.InstalledVersion, '1.0.0');
        });

        test('reports the scan stage and percent on the job', async () => {
            let releaseDiscovery: (() => void) | undefined;
            const discoveryGate = new Promise<void>((resolve) => { releaseDiscovery = resolve; });
            sandbox.stub(vscode.workspace, 'findFiles').callsFake(async () => {
                await discoveryGate;
                return [makeProjectUri('/ws/A.csproj')];
            });
            stubProjectParsing(() => makeProject('A', '/ws/A.csproj', '1.0.0'));
            setupNugetApi('2.0.0');

            const api = createHostAPI();
            const started = await api.startOutdatedScanAsync({ Prerelease: false });
            assert.ok(started.ok, started.ok ? '' : started.error);

            let status = await api.getJobAsync({ JobId: started.value.JobId });
            for (let i = 0; i < 400; i += 1) {
                // The scan reports "Reading project files…" and then "Parsing projects…"; the
                // discovery gate holds the latter, so that is the stage to observe.
                if (status.ok && status.value.Stage === 'Parsing projects…') break;
                await new Promise((resolve) => setTimeout(resolve, 5));
                status = await api.getJobAsync({ JobId: started.value.JobId });
            }

            assert.ok(status.ok);
            assert.strictEqual(status.value.Kind, 'outdatedScan');
            assert.strictEqual(status.value.Stage, 'Parsing projects…');
            assert.strictEqual(status.value.Percent, 4);

            releaseDiscovery!();
            const finished = outdatedStatus(await waitForJobAsync(api, started.value.JobId));
            assert.strictEqual(finished.State, 'completed');
            assert.strictEqual(finished.Response?.Packages.length, 1);
        });

        test('two concurrent jobs share one scan and both get the response', async () => {
            let releaseDiscovery: (() => void) | undefined;
            const discoveryGate = new Promise<void>((resolve) => { releaseDiscovery = resolve; });
            sandbox.stub(vscode.workspace, 'findFiles').callsFake(async () => {
                await discoveryGate;
                return [makeProjectUri('/ws/A.csproj'), makeProjectUri('/ws/B.csproj')];
            });
            stubProjectParsing((projectPath) => (
                projectPath === '/ws/A.csproj'
                    ? makeProject('A', '/ws/A.csproj', '1.0.0')
                    : makeProject('B', '/ws/B.csproj', '2.0.0')
            ));
            const getPackages = setupNugetApi('2.0.0');

            const api = createHostAPI();
            const first = await api.startOutdatedScanAsync({ Prerelease: false });
            const second = await api.startOutdatedScanAsync({ Prerelease: false });
            assert.ok(first.ok && second.ok);
            if (!first.ok || !second.ok) return;

            // Hold discovery open until both jobs have had a turn to attach to the run.
            setTimeout(() => releaseDiscovery!(), 0);

            const statuses = await Promise.all([
                waitForJobAsync(api, first.value.JobId),
                waitForJobAsync(api, second.value.JobId),
            ]);

            for (const status of statuses) {
                const job = outdatedStatus(status);
                assert.strictEqual(job.State, 'completed');
                assert.strictEqual(job.Response?.Packages.length, 1);
            }
            assert.strictEqual(coreCallsTo('getProjects').length, 1, 'one parse for both jobs');
            assert.strictEqual(getPackages.callCount, 1, 'one feed walk for both jobs');
        });

        test('cancels the job without failing the scan', async () => {
            let releaseDiscovery: (() => void) | undefined;
            const discoveryGate = new Promise<void>((resolve) => { releaseDiscovery = resolve; });
            sandbox.stub(vscode.workspace, 'findFiles').callsFake(async () => {
                await discoveryGate;
                return [makeProjectUri('/ws/A.csproj')];
            });
            stubProjectParsing(() => makeProject('A', '/ws/A.csproj', '1.0.0'));
            setupNugetApi('2.0.0');

            const api = createHostAPI();
            const started = await api.startOutdatedScanAsync({ Prerelease: false });
            assert.ok(started.ok, started.ok ? '' : started.error);
            if (!started.ok) return;

            // Wait until the scan is really running before cancelling it.
            let status = await api.getJobAsync({ JobId: started.value.JobId });
            for (let i = 0; i < 400; i += 1) {
                if (status.ok && status.value.Stage === 'Parsing projects…') break;
                await new Promise((resolve) => setTimeout(resolve, 5));
                status = await api.getJobAsync({ JobId: started.value.JobId });
            }

            const cancelled = await api.cancelJobAsync({ JobId: started.value.JobId });
            assert.ok(cancelled.ok);

            const finished = outdatedStatus(await waitForJobAsync(api, started.value.JobId));
            assert.strictEqual(finished.State, 'cancelled', 'a cancel is not a scan failure');

            // The shared scan kept running: releasing discovery lets it finish and warm the cache,
            // so the next caller does not start over.
            releaseDiscovery!();
            const again = await api.getOutdatedPackagesAsync({ Prerelease: false });
            assert.ok(again.ok);
            assert.strictEqual(again.value.Packages.length, 1);
            assert.strictEqual(coreCallsTo('getProjects').length, 1, 'the cancelled scan still warmed the cache');
        });

        test('fails the job when the scan really fails', async () => {
            sandbox.stub(vscode.workspace, 'findFiles').rejects(new Error('discovery exploded'));

            const api = createHostAPI();
            const started = await api.startOutdatedScanAsync({ Prerelease: false });
            assert.ok(started.ok, started.ok ? '' : started.error);

            const status = outdatedStatus(await waitForJobAsync(api, started.value.JobId));

            assert.strictEqual(status.State, 'failed');
            assert.match(status.Error ?? '', /Failed to check for outdated packages/);
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
            const propsPath = path.join(workspaceDir, 'Directory.Packages.props');
            fs.writeFileSync(
                propsPath,
                fs.readFileSync(path.join(fixturesRoot(), 'cpm', fixture), 'utf8')
            );
            projectPath = path.join(workspaceDir, 'App.csproj');
            fs.writeFileSync(
                projectPath,
                '<Project Sdk="Microsoft.NET.Sdk"><PropertyGroup><TargetFramework>net10.0</TargetFramework><ManagePackageVersionsCentrally>true</ManagePackageVersionsCentrally></PropertyGroup><ItemGroup><PackageReference Include="Pkg.Shared" /><PackageReference Include="Microsoft.Extensions.Logging" /></ItemGroup></Project>'
            );

            sandbox.stub(vscode.workspace, 'workspaceFolders').value([{ uri: { fsPath: workspaceDir } }]);
            const map = FIXTURE_MAPS[fixture];
            if (!map) {
                throw new Error(`No CPM map fixture for ${fixture}`);
            }
            stubCpmReader(sandbox, map, propsPath);
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

            assert.deepStrictEqual(coreCallsTo('updateCpmVersions'), [{
                propsFilePath: path.join(workspaceDir, 'Directory.Packages.props'),
                changes: [{ packageId: 'Pkg.Shared', version: '1.5.0', scope: 'unconditional' }],
                projectPaths: [projectPath],
                workspaceRoots: [workspaceDir],
            }]);
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

            assert.deepStrictEqual(coreCallsTo('updateCpmVersions'), [{
                propsFilePath: path.join(workspaceDir, 'Directory.Packages.props'),
                changes: [{
                    packageId: 'Microsoft.Extensions.Logging',
                    version: '10.0.14',
                    condition: "!$(TargetFramework.StartsWith('net11.0'))",
                    scope: 'group',
                }],
                projectPaths: [projectPath],
                workspaceRoots: [workspaceDir],
            }]);
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

            assert.deepStrictEqual(coreCallsTo('updateCpmVersions'), [], 'nothing may be written');
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
            assert.deepStrictEqual(coreCallsTo('updateCpmVersions'), [], 'nothing may be written');
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
            assert.strictEqual(coreCallsTo('updateCpmVersions').length, 1);
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

        test('a batch failure rolls back a property file returned by resolveCpmWriteTargets', async () => {
            setupWorkspace('unconditional-plus-conditional.props');
            const propertyPath = path.join(workspaceDir, 'Directory.Build.props');
            const propertyContent =
                '<Project>\n  <PropertyGroup>\n    <PkgSharedVersion>1.0.0</PkgSharedVersion>\n  </PropertyGroup>\n</Project>\n';
            fs.writeFileSync(propertyPath, propertyContent);

            // The writer would edit the property file, not the props file; the snapshot set must
            // therefore include it so a failed restore can roll it back.
            stubCoreCall('resolveCpmWriteTargets', () => ({ files: [propertyPath] }));
            stubCoreCall('updateCpmVersions', async () => {
                fs.writeFileSync(propertyPath, propertyContent.replace('1.0.0', '1.5.0'));
                return { applied: 1 };
            });
            sandbox.stub(TaskExecutorDefault, 'ExecuteCommandAsync').rejects(
                new DotnetError('dotnet exited with code 1', '')
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
            assert.strictEqual(result.value.RolledBack, true);
            assert.strictEqual(
                fs.readFileSync(propertyPath, 'utf8'),
                propertyContent,
                'the property file returned by resolveCpmWriteTargets must be restored'
            );
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

            sandbox.stub(CpmReader, 'FindCpmFilePathAsync').resolves(propsPath);
            sandbox.stub(CpmReader, 'GetFrameworkPackageMapAsync').resolves(cpmMap({
                unconditional: { 'Microsoft.EntityFrameworkCore.Relational': '11.0.0-rc.2.26504.105' },
            }));
            stubCoreCall('updatePackageVersion', () => {
                fs.writeFileSync(
                    propsPath,
                    propsContent.replace('11.0.0-rc.2.26504.105', '11.0.0-rc.3.26522.148')
                );
                return { updated: true };
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
            assert.deepStrictEqual(coreCallsTo('updatePackageVersion'), [{
                projectPath,
                packageId: 'Microsoft.EntityFrameworkCore.Relational',
                version: '11.0.0-rc.3.26522.148',
                scope: 'unconditional',
                workspaceRoots: [workspaceDir],
            }]);
        });

        test('treats an already-absent PackageReference as a successful uninstall', async () => {
            // The dependency analysis reads project.assets.json, which can still list a
            // reference that is no longer in the .csproj. `dotnet remove package` reports
            // "does not contain any PackageReference"; the uninstall goal is already met.
            const projectPath = path.join(workspaceDir, 'App.csproj');
            fs.writeFileSync(projectPath, '<Project Sdk="Microsoft.NET.Sdk"></Project>');
            stubProjectParsing(() => ({
                Name: 'App',
                Path: projectPath,
                CpmEnabled: false,
                Packages: [],
            } as unknown as Project));
            sandbox.stub(CpmReader, 'FindCpmFilePathAsync').resolves(null);
            sandbox.stub(TaskExecutorDefault, 'ExecuteCommandAsync').callsFake(
                async (_command: string, args: string[]) => {
                    if (args[0] === 'remove') {
                        throw new DotnetError(
                            'dotnet exited with code 1',
                            "error: Project 'App.csproj' does not contain any PackageReference 'Sentry' to Remove."
                        );
                    }
                }
            );

            const api = createHostAPI();
            const result = await api.updateProjectAsync({
                ProjectPath: projectPath,
                PackageId: 'Sentry',
                Version: '5.0.0',
                Type: 'UNINSTALL',
            });

            assert.ok(result.ok, result.ok ? '' : result.error);
        });

        test('updateCentralVersions restores a property file when its restore fails', async () => {
            const projectPath = path.join(workspaceDir, 'App.csproj');
            const propsPath = path.join(workspaceDir, 'Directory.Packages.props');
            const propertyPath = path.join(workspaceDir, 'Directory.Build.props');
            const propsContent = [
                '<Project>',
                '  <ItemGroup>',
                '    <PackageVersion Include="Pkg.Shared" Version="$(PkgSharedVersion)" />',
                '  </ItemGroup>',
                '</Project>',
            ].join('\n');
            const propertyContent =
                '<Project>\n  <PropertyGroup>\n    <PkgSharedVersion>1.0.0</PkgSharedVersion>\n  </PropertyGroup>\n</Project>\n';
            fs.writeFileSync(projectPath, '<Project Sdk="Microsoft.NET.Sdk"></Project>');
            fs.writeFileSync(propsPath, propsContent);
            fs.writeFileSync(propertyPath, propertyContent);

            sandbox.stub(CpmReader, 'GetFrameworkPackageMapAsync').resolves(
                cpmMap({ unconditional: { 'Pkg.Shared': '1.0.0' } })
            );
            // The write resolves to the property file, not the props file.
            stubCoreCall('resolveCpmWriteTargets', () => ({ files: [propertyPath] }));
            stubCoreCall('updateCpmVersions', async () => {
                fs.writeFileSync(propertyPath, propertyContent.replace('1.0.0', '1.5.0'));
                return { applied: 1 };
            });
            sandbox.stub(TaskExecutorDefault, 'ExecuteCommandAsync').rejects(
                new DotnetError('dotnet exited with code 1', '')
            );

            const api = createHostAPI();
            const result = await api.updateCentralVersionsAsync({
                ProjectPaths: [projectPath],
                Updates: [{ PackageId: 'Pkg.Shared', Version: '1.5.0' }],
            });

            assert.ok(result.ok, result.ok ? '' : result.error);
            assert.ok(result.ok && result.value.RestoreError, 'the restore failure is reported');
            assert.strictEqual(
                fs.readFileSync(propertyPath, 'utf8'),
                propertyContent,
                'the property file the central write edited must be restored'
            );
        });
    });

    // ----------------------------------------------------------------
    // Mutation jobs
    // ----------------------------------------------------------------
    suite('mutation jobs', () => {
        let workspaceDir: string;
        let projectPath: string;

        function setupWorkspace(fixture: string, mapOverride?: CpmPackageMap): void {
            workspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), 'host-batch-job-'));
            const propsPath = path.join(workspaceDir, 'Directory.Packages.props');
            fs.writeFileSync(
                propsPath,
                fs.readFileSync(path.join(fixturesRoot(), 'cpm', fixture), 'utf8')
            );
            projectPath = path.join(workspaceDir, 'App.csproj');
            fs.writeFileSync(
                projectPath,
                '<Project Sdk="Microsoft.NET.Sdk"><PropertyGroup><TargetFramework>net10.0</TargetFramework><ManagePackageVersionsCentrally>true</ManagePackageVersionsCentrally></PropertyGroup><ItemGroup><PackageReference Include="Pkg.Shared" /></ItemGroup></Project>'
            );
            sandbox.stub(vscode.workspace, 'workspaceFolders').value([{ uri: { fsPath: workspaceDir } }]);
            const map = mapOverride ?? FIXTURE_MAPS[fixture];
            if (!map) {
                throw new Error(`No CPM map fixture for ${fixture}`);
            }
            stubCpmReader(sandbox, map, propsPath);
        }

        function gate(): { wait: Promise<void>; open: () => void } {
            let open!: () => void;
            const wait = new Promise<void>((resolve) => { open = resolve; });
            return { wait, open };
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

            assert.deepStrictEqual(coreCallsTo('updateCpmVersions'), [{
                propsFilePath: path.join(workspaceDir, 'Directory.Packages.props'),
                changes: [{ packageId: 'Pkg.Shared', version: '1.5.0', scope: 'unconditional' }],
                projectPaths: [projectPath],
                workspaceRoots: [workspaceDir],
            }]);
        });

        test('rolls back inside the job when the restore fails', async () => {
            setupWorkspace('unconditional-plus-conditional.props');
            const propsPath = path.join(workspaceDir, 'Directory.Packages.props');
            const propsBefore = fs.readFileSync(propsPath, 'utf8');
            sandbox.stub(TaskExecutorDefault, 'ExecuteCommandAsync').rejects(
                new DotnetError('dotnet exited with code 1', '')
            );
            // The core writes before the restore fails, so the rollback has something to undo.
            stubCoreCall('updateCpmVersions', () => {
                fs.writeFileSync(
                    propsPath,
                    fs.readFileSync(propsPath, 'utf8').replace('Version="1.0.0"', 'Version="1.5.0"')
                );
                return { applied: 1 };
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
                SkipRestore: false,
            });

            assert.ok(started.ok, started.ok ? '' : started.error);
            const status = await waitForJobAsync(api, started.value.JobId);

            assert.strictEqual(batchJob(status).State, 'completed');
            assert.strictEqual(batchJob(status).Response?.RolledBack, true);
            assert.ok(batchJob(status).Response?.RestoreError);
            assert.strictEqual(coreCallsTo('updateCpmVersions').length, 1);
            assert.strictEqual(fs.readFileSync(propsPath, 'utf8'), propsBefore);
        });

        test('refuses to start a second job while one is running', async () => {
            setupWorkspace('unconditional-plus-conditional.props');
            skipRestoreConfig();

            const blocker = gate();
            stubCoreCall('updateCpmVersions', async () => {
                await blocker.wait;
                return { applied: 1 };
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
            stubCoreCall('updateCpmVersions', async (params) => {
                const propsFilePath = (params as unknown as { propsFilePath: string }).propsFilePath;
                writeStarted();
                await blocker.wait;
                fs.writeFileSync(
                    propsFilePath,
                    fs.readFileSync(propsFilePath, 'utf8').replace('Version="1.0.0"', 'Version="1.5.0"')
                );
                written = true;
                return { applied: 1 };
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
            assert.strictEqual(coreCallsTo('updateCpmVersions').length, 1);
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

            assert.deepStrictEqual(coreCallsTo('updatePackageVersion'), [{
                projectPath,
                packageId: 'Pkg.Shared',
                version: '1.5.0',
                condition: "$(TargetFramework.StartsWith('net10.0'))",
                scope: 'group',
                workspaceRoots: [workspaceDir],
            }]);
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

            assert.deepStrictEqual(coreCallsTo('updateCpmVersions'), [{
                propsFilePath: path.join(workspaceDir, 'Directory.Packages.props'),
                changes: [{ packageId: 'Pkg.Shared', version: '3.0.0', scope: 'unconditional' }],
                projectPaths: [projectPath],
                workspaceRoots: [workspaceDir],
            }]);
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
                        Versions: Object.keys(byLowerId.get(packageId.toLowerCase()) ?? {}).map((version) => ({
                            Version: version,
                        })),
                    },
                }),
                // Metadata is addressed by id + version, not by a registration leaf URL.
                GetPackageDetailsAsync: async (packageId: string, version: string) => {
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
            // Pkg.Shared 1.5.0 requires it at exactly 1.0.0. The core computes the
            // closure; here its answer is canned and the host only maps it.
            writeAssets({ 'Pkg.Shared': '1.0.0', 'Pkg.Leaf': '2.0.0' });
            stubPackageMetadata('1.5.0', [{ package: 'Pkg.Leaf', versionRange: '[1.0.0]' }]);
            stubCoreCall('computeRequirementClosure', () => ({
                Conflicts: [{
                    PackageId: 'Pkg.Leaf',
                    RequiredBy: 'Pkg.Shared',
                    RequiredByVersion: '1.5.0',
                    Range: '[1.0.0]',
                    RequiredVersion: '1.0.0',
                    Tfm: 'net10.0',
                }],
                Planned: { 'pkg.leaf': '1.0.0' },
            }));

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

            assert.deepStrictEqual(coreCallsTo('computeRequirementClosure'), [{
                selected: [{ id: 'Pkg.Shared', version: '1.5.0' }],
                tfms: ['net10.0'],
                effective: { 'pkg.shared': '1.5.0', 'pkg.leaf': '2.0.0' },
                constrained: { 'net10.0': ['pkg.shared'] },
                constrainAll: true,
                maxInspected: 250,
                sources: [{ url: 'https://api.nuget.org/v3/index.json' }],
            }]);
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
            assert.strictEqual(coreCallsTo('computeRequirementClosure').length, 1);
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
            setupWorkspace('unconditional-plus-conditional.props', cpmMap({
                unconditional: {
                    'Microsoft.EntityFrameworkCore.Relational': '11.0.0-rc.2.26504.105',
                },
            }));
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
            stubCoreCall('classifyDotnetFailure', () => ({
                Kind: 'RestoreConflict',
                Summary: 'NU1107 Microsoft.EntityFrameworkCore.Relational',
                Hint: '',
                Detail: output,
                Conflicts: [{
                    Code: 'NU1107',
                    PackageId: 'Microsoft.EntityFrameworkCore.Relational',
                    SuggestedVersion: '11.0.0-rc.3.26522.148',
                    Message: 'Version conflict detected for Microsoft.EntityFrameworkCore.Relational.',
                    Chains: [
                        'Sample.Api -> Npgsql.EntityFrameworkCore.PostgreSQL 11.0.0-rc.2 -> Microsoft.EntityFrameworkCore.Relational (= 11.0.0-rc.2.26504.105).',
                    ],
                }],
            }));

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
            sandbox.stub(CpmReader, 'GetFrameworkPackageMapAsync').resolves(null);
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
