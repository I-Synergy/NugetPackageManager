import * as assert from 'assert';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as sinon from 'sinon';
import * as vscode from 'vscode';
import { Logger } from '@/common/logger';
import type { LocalTool, LocalToolManifest, ToolchainHealth } from '@/common/rpc/types';
import coreProcess from '@/host/nuget/core-process';
import { createHostAPI } from '@/host/host-api';
import {
    BuildToolchainDiagnosticsAsync,
    LocalToolProbeParams,
    RedactDiagnostics,
    SetDiagnosticsRuntimeForTests,
    type ToolchainLocalToolProbe,
} from '@/host/utilities/toolchain-health';

function tool(overrides: Partial<LocalTool> = {}): LocalTool {
    return {
        Id: 'dotnet-ef',
        Commands: ['dotnet-ef'],
        Version: '9.0.0',
        Pinned: false,
        UpdateAvailable: false,
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

suite('toolchain-health', () => {
    test('RedactDiagnostics removes credentials from URLs and key/value pairs', () => {
        const report = [
            'source: https://user:secret@pkgs.dev.azure.com/feed',
            'password=hunter2',
            'ApiKey: abc123',
        ].join('\n');

        const redacted = RedactDiagnostics(report);

        assert.strictEqual(redacted.includes('secret'), false);
        assert.strictEqual(redacted.includes('hunter2'), false);
        assert.strictEqual(redacted.includes('abc123'), false);
        assert.match(redacted, /https:\/\/\*\*\*@pkgs\.dev\.azure\.com\/feed/);
    });

    test('LocalToolProbeParams sends the slice only when a manifest was read', () => {
        const probe: ToolchainLocalToolProbe = {
            manifestPath: '/ws/.config/dotnet-tools.json',
            problems: [],
            tools: [{ id: 'dotnet-ef', version: '9.0.0', restored: false }],
        };

        assert.deepStrictEqual(LocalToolProbeParams([probe]), { localTools: [probe] });
        // No manifest (or an unreadable one): the request is byte-identical to the old shape.
        assert.deepStrictEqual(LocalToolProbeParams([]), {});
        assert.deepStrictEqual(LocalToolProbeParams(undefined), {});
    });

    suite('diagnostics report', () => {
        let sandbox: sinon.SinonSandbox;
        let workspaceRoot: string;

        function manifest(overrides: Partial<LocalToolManifest> = {}): LocalToolManifest {
            return {
                Path: path.join(workspaceRoot, '.config', 'dotnet-tools.json'),
                IsRoot: true,
                Tools: [
                    tool(),
                    tool({
                        Id: 'GitVersion.Tool',
                        Commands: ['dotnet-gitversion', 'gitversion'],
                        Version: '6.0.1',
                        Pinned: true,
                        NotRestored: true,
                    }),
                ],
                Problems: [],
                ...overrides,
            };
        }

        /** No real `dotnet`: the report's spawns and the toolchain probe are both stubbed. */
        function stubRuntime(): void {
            SetDiagnosticsRuntimeForTests({
                ProbeToolchainAsync: async () => health(),
                RunCapturedAsync: async () => ({ Code: 0, Stdout: '9.0.100', Stderr: '' }),
            });
        }

        setup(() => {
            sandbox = sinon.createSandbox();
            sandbox.stub(Logger, 'info');
            sandbox.stub(Logger, 'debug');
            sandbox.stub(Logger, 'warn');
            sandbox.stub(Logger, 'error');
            workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'npm-toolchain-health-'));
            stubRuntime();
            // No core either: the default answer is "no manifests", one test makes it fail.
            sandbox
                .stub(coreProcess, 'CallAsync')
                .callsFake((async () => ({ Manifests: [] })) as unknown as typeof coreProcess.CallAsync);
        });

        teardown(() => {
            SetDiagnosticsRuntimeForTests(null);
            sandbox.restore();
            fs.rmSync(workspaceRoot, { recursive: true, force: true });
        });

        test('lists each manifest with its tools, commands, pin and restore state', async () => {
            const localTools = [manifest()];

            const report = await BuildToolchainDiagnosticsAsync({ WorkspaceRoot: workspaceRoot }, localTools);

            const localToolsAt = report.indexOf('--- local tools ---');
            assert.ok(localToolsAt > -1, 'the report has a local tools section');
            assert.ok(
                report.indexOf('--- projects ---') < localToolsAt,
                'the section follows --- projects ---'
            );
            assert.ok(
                localToolsAt < report.indexOf('--- dotnet --list-sdks ---'),
                'the section precedes --- dotnet --list-sdks ---'
            );

            const lines = report.split('\n');
            const manifestAt = lines.indexOf(`  ${localTools[0]!.Path}`);
            assert.ok(manifestAt > -1, `manifest path is listed:\n${report}`);
            assert.strictEqual(lines[manifestAt + 1], '    isRoot: true');
            assert.strictEqual(lines[manifestAt + 2], '    problems: none');
            assert.strictEqual(lines[manifestAt + 3], '    dotnet-ef 9.0.0 [dotnet-ef] restored');
            assert.strictEqual(
                lines[manifestAt + 4],
                '    GitVersion.Tool 6.0.1 [dotnet-gitversion, gitversion] pinned NOT restored (best effort)'
            );
        });

        test('renders problems and the empty-manifest line', async () => {
            const problems = await BuildToolchainDiagnosticsAsync(
                { WorkspaceRoot: workspaceRoot },
                [manifest({ Problems: ['duplicate tool id "dotnet-ef"'] })]
            );
            assert.match(problems, / {4}problems: duplicate tool id "dotnet-ef"/);

            const empty = await BuildToolchainDiagnosticsAsync({ WorkspaceRoot: workspaceRoot }, []);
            assert.match(empty, /--- local tools ---\n {2}no \.config\/dotnet-tools\.json found/);
        });

        test('redacts a manifest path that carries credentials-looking text', async () => {
            const report = await BuildToolchainDiagnosticsAsync(
                { WorkspaceRoot: workspaceRoot },
                [manifest({ Path: path.join(workspaceRoot, 'token=abc123', 'dotnet-tools.json') })]
            );

            assert.strictEqual(report.includes('abc123'), false, report);
            assert.match(report, /token=\*\*\*/);
        });

        test('still produces a report when the local tool read failed', async () => {
            sandbox.stub(vscode.workspace, 'workspaceFolders').value([{ uri: { fsPath: workspaceRoot } }]);
            (coreProcess.CallAsync as unknown as sinon.SinonStub).rejects(new Error('core is not running'));
            const projectPath = path.join(workspaceRoot, 'App.csproj');
            fs.writeFileSync(projectPath, '<Project />', 'utf8');

            const result = await createHostAPI().runToolchainDiagnosticsAsync({ ProjectPaths: [projectPath] });

            assert.ok(result.ok, result.ok ? '' : result.error);
            assert.match(result.value.Report, /--- local tools ---/);
            assert.match(result.value.Report, /no \.config\/dotnet-tools\.json found/);
            assert.match(result.value.Report, /--- dotnet --info ---/);
        });
    });
});
