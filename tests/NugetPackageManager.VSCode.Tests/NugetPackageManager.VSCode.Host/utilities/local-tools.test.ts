import * as assert from 'assert';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as sinon from 'sinon';
import * as vscode from 'vscode';
import { Logger } from '@/common/logger';
import type {
    LocalTool,
    LocalToolManifest,
    ToolchainHealth,
    UpdateLocalToolResponse,
} from '@/common/rpc/types';
import coreProcess from '@/host/nuget/core-process';
import { CoreError } from '@/host/nuget/core-error';
import NuGetConfigResolver from '@/host/utilities/nuget-config-resolver';
import { ResolveDotnetContext } from '@/host/utilities/dotnet-context';
import * as toolchainHealth from '@/host/utilities/toolchain-health';
import {
    BuildLocalToolProbeSlice,
    IsToolPackageMissing,
    ReadLocalToolsAsync,
    ResolveGlobalPackagesFolder,
    UpdateLocalToolAsync,
} from '@/host/utilities/local-tools';
import { createHostAPI } from '@/host/host-api';

type CoreCall = { method: string; params: Record<string, unknown> };

function tool(overrides: Partial<LocalTool> = {}): LocalTool {
    return {
        Id: 'dotnet-ef',
        Commands: ['dotnet-ef'],
        Version: '9.0.0',
        Pinned: false,
        LatestVersion: '10.0.0',
        UpdateAvailable: true,
        NotRestored: false,
        ...overrides,
    };
}

function health(): ToolchainHealth {
    return {
        DotnetFound: true,
        ProjectEvaluationFailed: false,
        CheckedAt: new Date().toISOString(),
        InstalledSdks: [],
        Issues: [],
    };
}

suite('local-tools', () => {
    let sandbox: sinon.SinonSandbox;
    let workspaceRoot: string;
    let packagesFolder: string;
    let coreCalls: CoreCall[];
    let coreResponder: (method: string) => unknown;

    /** A `.config/dotnet-tools.json` inside the temporary workspace. */
    function writeManifest(root: string, content = '{"version":1,"isRoot":true,"tools":{}}'): string {
        const manifestPath = path.join(root, '.config', 'dotnet-tools.json');
        fs.mkdirSync(path.dirname(manifestPath), { recursive: true });
        fs.writeFileSync(manifestPath, content, 'utf8');
        return manifestPath;
    }

    function manifest(overrides: Partial<LocalToolManifest> = {}): LocalToolManifest {
        return {
            Path: path.join(workspaceRoot, '.config', 'dotnet-tools.json'),
            IsRoot: true,
            Tools: [tool(), tool({ Id: 'GitVersion.Tool', Commands: ['dotnet-gitversion'], Version: '6.0.1', Pinned: true })],
            Problems: [],
            ...overrides,
        };
    }

    setup(() => {
        sandbox = sinon.createSandbox();
        sandbox.stub(Logger, 'info');
        sandbox.stub(Logger, 'debug');
        sandbox.stub(Logger, 'warn');
        sandbox.stub(Logger, 'error');

        workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'npm-local-tools-'));
        packagesFolder = fs.mkdtempSync(path.join(os.tmpdir(), 'npm-local-tools-packages-'));
        process.env.NUGET_PACKAGES = packagesFolder;

        coreCalls = [];
        coreResponder = () => ({ Manifests: [] });
        sandbox.stub(coreProcess, 'CallAsync').callsFake((async (
            method: string,
            params: Record<string, unknown>
        ) => {
            coreCalls.push({ method, params });
            return coreResponder(method);
        }) as unknown as typeof coreProcess.CallAsync);

        sandbox.stub(NuGetConfigResolver, 'GetSourcesAndDecodePasswordsAsync').resolves([
            { Name: 'nuget.org', Url: 'https://api.nuget.org/v3/index.json' },
        ]);
    });

    teardown(() => {
        sandbox.restore();
        delete process.env.NUGET_PACKAGES;
        fs.rmSync(workspaceRoot, { recursive: true, force: true });
        fs.rmSync(packagesFolder, { recursive: true, force: true });
    });

    // ----------------------------------------------------------------
    // readLocalTools
    // ----------------------------------------------------------------

    test('ReadLocalToolsAsync maps the core manifests and fills NotRestored', async () => {
        fs.mkdirSync(path.join(packagesFolder, 'gitversion.tool', '6.0.1'), { recursive: true });
        coreResponder = () => ({ Manifests: [manifest()] });

        const response = await ReadLocalToolsAsync({ WorkspaceRoots: [workspaceRoot] });

        assert.strictEqual(response.Manifests.length, 1);
        const tools = response.Manifests[0]!.Tools;
        assert.strictEqual(tools.find((entry) => entry.Id === 'dotnet-ef')!.NotRestored, true);
        assert.strictEqual(tools.find((entry) => entry.Id === 'GitVersion.Tool')!.NotRestored, false);
        // Everything else the core decided is passed through untouched.
        assert.strictEqual(tools[0]!.LatestVersion, '10.0.0');
        assert.strictEqual(tools[0]!.UpdateAvailable, true);

        assert.strictEqual(coreCalls.length, 1);
        assert.strictEqual(coreCalls[0]!.method, 'readLocalTools');
        assert.deepStrictEqual(coreCalls[0]!.params.workspaceRoots, [workspaceRoot]);
        assert.strictEqual(coreCalls[0]!.params.resolveLatest, true);
        assert.deepStrictEqual(coreCalls[0]!.params.sources, [
            { url: 'https://api.nuget.org/v3/index.json' },
        ]);
    });

    test('ReadLocalToolsAsync resolves empty workspace roots to the open folders', async () => {
        sandbox.stub(vscode.workspace, 'workspaceFolders').value([{ uri: { fsPath: workspaceRoot } }]);

        await ReadLocalToolsAsync({ WorkspaceRoots: [] });

        assert.strictEqual(coreCalls.length, 1);
        assert.deepStrictEqual(coreCalls[0]!.params.workspaceRoots, [workspaceRoot]);
    });

    test('ReadLocalToolsAsync answers no manifests when no folder is open', async () => {
        sandbox.stub(vscode.workspace, 'workspaceFolders').value(undefined);

        const response = await ReadLocalToolsAsync({ WorkspaceRoots: [] });

        assert.deepStrictEqual(response.Manifests, []);
        assert.strictEqual(coreCalls.length, 0, 'no core call without a workspace root');
    });

    test('ReadLocalToolsAsync never contacts a source when ResolveLatest is false', async () => {
        const sourceStub = NuGetConfigResolver.GetSourcesAndDecodePasswordsAsync as sinon.SinonStub;

        await ReadLocalToolsAsync({ WorkspaceRoots: [workspaceRoot], ResolveLatest: false });

        assert.strictEqual(sourceStub.called, false);
        assert.strictEqual(coreCalls[0]!.params.resolveLatest, false);
        assert.strictEqual('sources' in coreCalls[0]!.params, false);
    });

    test('ReadLocalToolsAsync describes a core failure instead of leaking it', async () => {
        (coreProcess.CallAsync as unknown as sinon.SinonStub).rejects(new CoreError('manifestNotFound', 'gone'));

        await assert.rejects(
            () => ReadLocalToolsAsync({ WorkspaceRoots: [workspaceRoot] }),
            /no longer exists/
        );
    });

    test('ReadLocalToolsAsync keeps working when the sources cannot be resolved', async () => {
        (NuGetConfigResolver.GetSourcesAndDecodePasswordsAsync as sinon.SinonStub).rejects(
            new Error('nuget.config unreadable')
        );

        await ReadLocalToolsAsync({ WorkspaceRoots: [workspaceRoot] });

        assert.strictEqual(coreCalls.length, 1);
        assert.strictEqual('sources' in coreCalls[0]!.params, false);
    });

    // ----------------------------------------------------------------
    // exclusion of cached/scratch manifests
    // ----------------------------------------------------------------

    /** The configuration read the exclusion filter performs, stubbed per test. */
    function stubConfiguration(values: Record<string, unknown> = {}): void {
        sandbox.stub(vscode.workspace, 'getConfiguration').returns({
            get: (key: string, defaultValue?: unknown) => values[key] ?? defaultValue,
            inspect: () => undefined,
            update: sinon.stub().resolves(),
        } as unknown as vscode.WorkspaceConfiguration);
    }

    test('ReadLocalToolsAsync drops manifests from hidden folders and keeps normal ones', async () => {
        sandbox.stub(vscode.workspace, 'workspaceFolders').value([{ uri: { fsPath: workspaceRoot } }]);
        stubConfiguration();
        const cached = path.join(
            workspaceRoot, '.ai', 'tmp', 'catalog-cache', 'x', '.config', 'dotnet-tools.json'
        );
        const source = path.join(workspaceRoot, 'src', '.config', 'dotnet-tools.json');
        coreResponder = () => ({ Manifests: [manifest({ Path: cached }), manifest({ Path: source })] });

        const response = await ReadLocalToolsAsync({ WorkspaceRoots: [workspaceRoot] });

        assert.deepStrictEqual(response.Manifests.map((entry) => entry.Path), [source]);
        assert.strictEqual(
            (Logger.debug as sinon.SinonStub).calledWithMatch(/dropped 1 manifest/),
            true,
            'the dropped count is logged'
        );
    });

    test('ReadLocalToolsAsync honours a configured excludeGlobs entry', async () => {
        sandbox.stub(vscode.workspace, 'workspaceFolders').value([{ uri: { fsPath: workspaceRoot } }]);
        stubConfiguration({ excludeGlobs: ['**/vendor/**'] });
        const vendored = path.join(
            workspaceRoot, 'vendor', 'tooling', '.config', 'dotnet-tools.json'
        );
        const source = path.join(workspaceRoot, 'src', '.config', 'dotnet-tools.json');
        coreResponder = () => ({ Manifests: [manifest({ Path: vendored }), manifest({ Path: source })] });

        const response = await ReadLocalToolsAsync({ WorkspaceRoots: [workspaceRoot] });

        assert.deepStrictEqual(response.Manifests.map((entry) => entry.Path), [source]);
    });

    test('the default hidden-folder glob keeps root-level and src manifests', async () => {
        // The manifest path always carries the hidden `.config` segment, so matching it against
        // `**/.*/**` would drop every manifest; the filter matches the owning folder instead.
        sandbox.stub(vscode.workspace, 'workspaceFolders').value([{ uri: { fsPath: workspaceRoot } }]);
        stubConfiguration({
            excludeGlobs: ['**/bin/**', '**/obj/**', '**/TestResults/**', '**/packages/**', '**/.*/**'],
        });
        const rootManifest = manifest();
        const srcManifest = manifest({
            Path: path.join(workspaceRoot, 'src', '.config', 'dotnet-tools.json'),
            IsRoot: false,
        });
        coreResponder = () => ({ Manifests: [rootManifest, srcManifest] });

        const response = await ReadLocalToolsAsync({ WorkspaceRoots: [workspaceRoot] });

        assert.deepStrictEqual(
            response.Manifests.map((entry) => entry.Path),
            [rootManifest.Path, srcManifest.Path]
        );
    });

    // ----------------------------------------------------------------
    // restore probe
    // ----------------------------------------------------------------

    test('IsToolPackageMissing lower-cases the id and keeps the version', () => {
        fs.mkdirSync(path.join(packagesFolder, 'gitversion.tool', '6.0.1'), { recursive: true });

        assert.strictEqual(IsToolPackageMissing('GitVersion.Tool', '6.0.1', packagesFolder), false);
        assert.strictEqual(IsToolPackageMissing('GitVersion.Tool', '6.0.0', packagesFolder), true);
        assert.strictEqual(IsToolPackageMissing('dotnet-ef', '9.0.0', packagesFolder), true);
    });

    test('IsToolPackageMissing reports unknown, not missing, when the folder cannot be read', () => {
        const unreadable = path.join(packagesFolder, 'does-not-exist');

        assert.strictEqual(IsToolPackageMissing('dotnet-ef', '9.0.0', unreadable), false);
    });

    test('ResolveGlobalPackagesFolder honours NUGET_PACKAGES', () => {
        assert.strictEqual(ResolveGlobalPackagesFolder(), packagesFolder);
    });

    // ----------------------------------------------------------------
    // updateLocalTool
    // ----------------------------------------------------------------

    test('UpdateLocalToolAsync refuses a manifest outside the workspace', async () => {
        const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'npm-local-tools-outside-'));
        try {
            const manifestPath = writeManifest(outside);

            await assert.rejects(
                () => UpdateLocalToolAsync({
                    ManifestPath: manifestPath,
                    ToolId: 'dotnet-ef',
                    ExpectedVersion: '9.0.0',
                    Version: '10.0.0',
                    WorkspaceRoots: [workspaceRoot],
                }),
                /outside the workspace/
            );
            assert.strictEqual(coreCalls.length, 0, 'no write may reach the core');
        } finally {
            fs.rmSync(outside, { recursive: true, force: true });
        }
    });

    test('UpdateLocalToolAsync refuses a file that is not a tool manifest', async () => {
        const other = path.join(workspaceRoot, '.config', 'nuget.config');
        fs.mkdirSync(path.dirname(other), { recursive: true });
        fs.writeFileSync(other, '{}', 'utf8');

        await assert.rejects(
            () => UpdateLocalToolAsync({
                ManifestPath: other,
                ToolId: 'dotnet-ef',
                ExpectedVersion: '9.0.0',
                Version: '10.0.0',
                WorkspaceRoots: [workspaceRoot],
            }),
            /dotnet-tools\.json/
        );
        assert.strictEqual(coreCalls.length, 0);
    });

    test('UpdateLocalToolAsync refuses a relative manifest path', async () => {
        await assert.rejects(
            () => UpdateLocalToolAsync({
                ManifestPath: path.join('.config', 'dotnet-tools.json'),
                ToolId: 'dotnet-ef',
                ExpectedVersion: '9.0.0',
                Version: '10.0.0',
                WorkspaceRoots: [workspaceRoot],
            }),
            /must be absolute/
        );
    });

    test('UpdateLocalToolAsync restores in the manifest folder and reports success', async () => {
        const manifestPath = writeManifest(workspaceRoot);
        coreResponder = (): UpdateLocalToolResponse => ({
            ManifestPath: manifestPath,
            ToolId: 'dotnet-ef',
            PreviousVersion: '9.0.0',
            Version: '10.0.0',
            Restore: null,
        });
        const runStub = sandbox
            .stub(toolchainHealth, 'RunCapturedAsync')
            .resolves({ Code: 0, Stdout: 'Restored', Stderr: '' });

        const result = await UpdateLocalToolAsync({
            ManifestPath: manifestPath,
            ToolId: 'dotnet-ef',
            ExpectedVersion: '9.0.0',
            Version: '10.0.0',
            WorkspaceRoots: [workspaceRoot],
        });

        assert.deepStrictEqual(result, {
            ManifestPath: manifestPath,
            ToolId: 'dotnet-ef',
            PreviousVersion: '9.0.0',
            Version: '10.0.0',
            Restore: { Ok: true, TimedOut: false },
        });
        // The core got the write request, and the host ran the restore in the manifest's folder.
        assert.deepStrictEqual(coreCalls[0]!.params, {
            manifestPath,
            toolId: 'dotnet-ef',
            expectedVersion: '9.0.0',
            version: '10.0.0',
            workspaceRoots: [workspaceRoot],
        });
        assert.strictEqual(runStub.calledOnce, true);
        assert.deepStrictEqual(runStub.firstCall.args[1], ['tool', 'restore']);
        assert.strictEqual(runStub.firstCall.args[2], path.dirname(manifestPath));
        assert.strictEqual(runStub.firstCall.args[3], 120_000);
        assert.strictEqual(runStub.firstCall.args[0], ResolveDotnetContext(manifestPath).Command);
    });

    test('UpdateLocalToolAsync keeps the manifest change when the restore fails', async () => {
        // The core already wrote the new version; a failed restore must not undo it.
        const updated = '{"version":1,"isRoot":true,"tools":{"dotnet-ef":{"version":"10.0.0"}}}';
        const manifestPath = writeManifest(workspaceRoot, updated);
        coreResponder = (): UpdateLocalToolResponse => ({
            ManifestPath: manifestPath,
            ToolId: 'dotnet-ef',
            PreviousVersion: '9.0.0',
            Version: '10.0.0',
            Restore: null,
        });
        sandbox.stub(toolchainHealth, 'RunCapturedAsync').resolves({
            Code: 1,
            Stdout: '',
            Stderr: 'NU1101: Unable to find package dotnet-ef.',
        });

        const result = await UpdateLocalToolAsync({
            ManifestPath: manifestPath,
            ToolId: 'dotnet-ef',
            ExpectedVersion: '9.0.0',
            Version: '10.0.0',
            WorkspaceRoots: [workspaceRoot],
        });

        assert.strictEqual(result.Version, '10.0.0');
        assert.ok(result.Restore);
        assert.strictEqual(result.Restore!.Ok, false);
        assert.strictEqual(result.Restore!.TimedOut, false);
        assert.match(result.Restore!.Message ?? '', /NU1101/);
        assert.strictEqual(fs.readFileSync(manifestPath, 'utf8'), updated, 'no rollback');
    });

    test('UpdateLocalToolAsync reports a timed-out restore as TimedOut', async () => {
        const manifestPath = writeManifest(workspaceRoot);
        coreResponder = (): UpdateLocalToolResponse => ({
            ManifestPath: manifestPath,
            ToolId: 'dotnet-ef',
            PreviousVersion: '9.0.0',
            Version: '10.0.0',
            Restore: null,
        });
        sandbox.stub(toolchainHealth, 'RunCapturedAsync').resolves({
            Code: null,
            Stdout: '',
            Stderr: '',
            SpawnError: 'ETIMEDOUT',
        });

        const result = await UpdateLocalToolAsync({
            ManifestPath: manifestPath,
            ToolId: 'dotnet-ef',
            ExpectedVersion: '9.0.0',
            Version: '10.0.0',
            WorkspaceRoots: [workspaceRoot],
        });

        assert.ok(result.Restore);
        assert.strictEqual(result.Restore!.Ok, false);
        assert.strictEqual(result.Restore!.TimedOut, true);
        assert.match(result.Restore!.Message ?? '', /did not finish within 120 s/);
    });

    test('UpdateLocalToolAsync describes a core failure instead of leaking it', async () => {
        const manifestPath = writeManifest(workspaceRoot);
        (coreProcess.CallAsync as unknown as sinon.SinonStub).rejects(new CoreError('versionMismatch', 'stale'));
        const runStub = sandbox.stub(toolchainHealth, 'RunCapturedAsync');

        await assert.rejects(
            () => UpdateLocalToolAsync({
                ManifestPath: manifestPath,
                ToolId: 'dotnet-ef',
                ExpectedVersion: '9.0.0',
                Version: '10.0.0',
                WorkspaceRoots: [workspaceRoot],
            }),
            /changed since this row was rendered/
        );
        assert.strictEqual(runStub.called, false, 'a refused write never restores');
    });

    // ----------------------------------------------------------------
    // health merge
    // ----------------------------------------------------------------

    test('BuildLocalToolProbeSlice carries the restore state per tool', () => {
        const slice = BuildLocalToolProbeSlice([
            manifest({ Tools: [tool({ NotRestored: true }), tool({ Id: 'GitVersion.Tool' })] }),
        ]);

        assert.deepStrictEqual(slice, [{
            manifestPath: path.join(workspaceRoot, '.config', 'dotnet-tools.json'),
            problems: [],
            tools: [
                { id: 'dotnet-ef', version: '9.0.0', restored: false },
                { id: 'GitVersion.Tool', version: '9.0.0', restored: true },
            ],
        }]);
        assert.deepStrictEqual(BuildLocalToolProbeSlice([]), []);
    });

    test('getToolchainHealthAsync passes the manifests to the probe and stays offline', async () => {
        sandbox.stub(vscode.workspace, 'workspaceFolders').value([{ uri: { fsPath: workspaceRoot } }]);
        fs.mkdirSync(path.join(packagesFolder, 'gitversion.tool', '6.0.1'), { recursive: true });
        coreResponder = () => ({ Manifests: [manifest()] });
        const sourceStub = NuGetConfigResolver.GetSourcesAndDecodePasswordsAsync as sinon.SinonStub;
        const probeStub = sandbox
            .stub(toolchainHealth, 'ProbeToolchainAsync')
            .resolves(health());

        const projectPath = path.join(workspaceRoot, 'App.csproj');
        fs.writeFileSync(projectPath, '<Project />', 'utf8');
        const api = createHostAPI();
        const result = await api.getToolchainHealthAsync({ ProjectPaths: [projectPath] });

        assert.ok(result.ok, result.ok ? '' : result.error);
        assert.strictEqual(coreCalls[0]!.method, 'readLocalTools');
        assert.strictEqual(coreCalls[0]!.params.resolveLatest, false);
        assert.strictEqual(sourceStub.called, false, 'the health path must not hit a feed');
        assert.strictEqual(probeStub.calledOnce, true);
        assert.deepStrictEqual(probeStub.firstCall.args[0].LocalTools, [
            {
                manifestPath: path.join(workspaceRoot, '.config', 'dotnet-tools.json'),
                problems: [],
                tools: [
                    { id: 'dotnet-ef', version: '9.0.0', restored: false },
                    { id: 'GitVersion.Tool', version: '6.0.1', restored: true },
                ],
            },
        ]);
    });

    test('getToolchainHealthAsync still probes when there is no manifest', async () => {
        sandbox.stub(vscode.workspace, 'workspaceFolders').value([{ uri: { fsPath: workspaceRoot } }]);
        coreResponder = () => ({ Manifests: [] });
        const probeStub = sandbox
            .stub(toolchainHealth, 'ProbeToolchainAsync')
            .resolves(health());

        const projectPath = path.join(workspaceRoot, 'App.csproj');
        fs.writeFileSync(projectPath, '<Project />', 'utf8');
        const api = createHostAPI();
        const result = await api.getToolchainHealthAsync({ ProjectPaths: [projectPath] });

        assert.ok(result.ok, result.ok ? '' : result.error);
        assert.strictEqual(probeStub.calledOnce, true);
        assert.strictEqual('LocalTools' in probeStub.firstCall.args[0], false);
    });

    test('getToolchainHealthAsync survives a failed tool read', async () => {
        sandbox.stub(vscode.workspace, 'workspaceFolders').value([{ uri: { fsPath: workspaceRoot } }]);
        (coreProcess.CallAsync as unknown as sinon.SinonStub).rejects(new CoreError('unavailable', 'no core'));
        const probeStub = sandbox
            .stub(toolchainHealth, 'ProbeToolchainAsync')
            .resolves(health());

        const projectPath = path.join(workspaceRoot, 'App.csproj');
        fs.writeFileSync(projectPath, '<Project />', 'utf8');
        const api = createHostAPI();
        const result = await api.getToolchainHealthAsync({ ProjectPaths: [projectPath] });

        assert.ok(result.ok, result.ok ? '' : result.error);
        assert.strictEqual(probeStub.calledOnce, true);
        assert.strictEqual('LocalTools' in probeStub.firstCall.args[0], false);
    });

    // ----------------------------------------------------------------
    // HostAPI methods
    // ----------------------------------------------------------------

    test('getLocalToolsAsync returns the manifests as a Result', async () => {
        coreResponder = () => ({ Manifests: [manifest()] });
        const api = createHostAPI();

        const result = await api.getLocalToolsAsync({ WorkspaceRoots: [workspaceRoot] });

        assert.ok(result.ok, result.ok ? '' : result.error);
        assert.strictEqual(result.value.Manifests.length, 1);
        assert.strictEqual(result.value.Manifests[0]!.Path, manifest().Path);
    });

    test('getLocalToolsAsync turns a core failure into fail(...)', async () => {
        (coreProcess.CallAsync as unknown as sinon.SinonStub).rejects(new CoreError('unavailable', 'no core'));
        const api = createHostAPI();

        const result = await api.getLocalToolsAsync({ WorkspaceRoots: [workspaceRoot] });

        assert.strictEqual(result.ok, false);
        assert.match(result.ok ? '' : result.error, /no core/);
    });

    test('updateLocalToolAsync returns the update and the restore outcome', async () => {
        const manifestPath = writeManifest(workspaceRoot);
        coreResponder = (): UpdateLocalToolResponse => ({
            ManifestPath: manifestPath,
            ToolId: 'dotnet-ef',
            PreviousVersion: '9.0.0',
            Version: '10.0.0',
            Restore: null,
        });
        sandbox.stub(toolchainHealth, 'RunCapturedAsync').resolves({ Code: 0, Stdout: '', Stderr: '' });
        const api = createHostAPI();

        const result = await api.updateLocalToolAsync({
            ManifestPath: manifestPath,
            ToolId: 'dotnet-ef',
            ExpectedVersion: '9.0.0',
            Version: '10.0.0',
            WorkspaceRoots: [workspaceRoot],
        });

        assert.ok(result.ok, result.ok ? '' : result.error);
        assert.strictEqual(result.value.Version, '10.0.0');
        assert.deepStrictEqual(result.value.Restore, { Ok: true, TimedOut: false });
    });

    test('updateLocalToolAsync turns a rejected write into fail(...)', async () => {
        const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'npm-local-tools-outside-'));
        try {
            const manifestPath = writeManifest(outside);
            const api = createHostAPI();

            const result = await api.updateLocalToolAsync({
                ManifestPath: manifestPath,
                ToolId: 'dotnet-ef',
                ExpectedVersion: '9.0.0',
                Version: '10.0.0',
                WorkspaceRoots: [workspaceRoot],
            });

            assert.strictEqual(result.ok, false);
            assert.match(result.ok ? '' : result.error, /outside the workspace/);
        } finally {
            fs.rmSync(outside, { recursive: true, force: true });
        }
    });
});
