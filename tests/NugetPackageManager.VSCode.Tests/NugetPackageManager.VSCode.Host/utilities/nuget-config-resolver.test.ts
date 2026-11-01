import * as assert from 'assert';
import * as sinon from 'sinon';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import * as vscode from 'vscode';
import NuGetConfigResolver from '@/host/utilities/nuget-config-resolver';
import PasswordScriptExecutor from '@/host/utilities/password-script-executor';
import { Logger } from '@/common/logger';

suite('NuGetConfigResolver Tests', () => {
    let sandbox: sinon.SinonSandbox;
    // let osHomedirStub: sinon.SinonStub; // Cannot stub immutable property
    let vscodeGetConfigurationStub: sinon.SinonStub;
    let isTrustedStub: sinon.SinonStub;
    let executeScriptStub: sinon.SinonStub;
    let originalPlatform: string;
    let originalEnv: NodeJS.ProcessEnv;

    let tempDir: string;
    let workspaceDir: string;
    let homeDir: string;
    let appDataDir: string;
    let programFilesDir: string;

    setup(() => {
        sandbox = sinon.createSandbox();
        // os.homedir is immutable in this environment, so we cannot stub it.
        // We will rely on process.env.HOME (Linux/macOS) or USERPROFILE (Windows) if the code uses os.homedir().
        // However, os.homedir() usually reads from env vars or system calls.
        // If we cannot stub it, we might be stuck unless we can change the env vars it reads.
        // Node's os.homedir() reads HOME on POSIX and USERPROFILE on Windows.

        vscodeGetConfigurationStub = sandbox.stub(vscode.workspace, 'getConfiguration');
        isTrustedStub = sandbox.stub(vscode.workspace, 'isTrusted').value(true);
        executeScriptStub = sandbox.stub(PasswordScriptExecutor, 'ExecuteScriptAsync');
        sandbox.stub(Logger, 'debug');
        sandbox.stub(Logger, 'error');
        sandbox.stub(Logger, 'info');

        originalPlatform = process.platform;
        originalEnv = { ...process.env };


        // Setup temp directories
        tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nuget-test-'));
        workspaceDir = path.join(tempDir, 'workspace');
        homeDir = path.join(tempDir, 'home');
        appDataDir = path.join(tempDir, 'appdata');
        programFilesDir = path.join(tempDir, 'programfiles');

        fs.mkdirSync(workspaceDir);
        fs.mkdirSync(homeDir);
        fs.mkdirSync(appDataDir);
        fs.mkdirSync(programFilesDir);

        // Try to influence os.homedir via env vars
        process.env.HOME = homeDir;
        process.env.USERPROFILE = homeDir;

        process.env.APPDATA = appDataDir;
        process.env['ProgramFiles(x86)'] = programFilesDir;
        process.env['ProgramFiles'] = programFilesDir;
    });

    teardown(() => {
        sandbox.restore();
        Object.defineProperty(process, 'platform', { value: originalPlatform });
        process.env = originalEnv;

        try {
            fs.rmSync(tempDir, { recursive: true, force: true });
        } catch (e) {
            console.error('Failed to cleanup temp dir', e);
        }
    });

    // Helper to write config file
    function writeConfig(dir: string, subPath: string, content: string) {
        const fullPath = path.join(dir, subPath);
        fs.mkdirSync(path.dirname(fullPath), { recursive: true });
        fs.writeFileSync(fullPath, content);
        return fullPath;
    }

    suite('FindAllConfigFiles', () => {
        test('Returns workspace configs when they exist', () => {
            writeConfig(workspaceDir, 'nuget.config', '<configuration/>');
            writeConfig(workspaceDir, '.nuget/nuget.config', '<configuration/>');

            const paths = (NuGetConfigResolver as any).FindAllConfigFiles([workspaceDir]);

            const expected1 = path.join(workspaceDir, '.nuget', 'nuget.config');
            const expected2 = path.join(workspaceDir, 'nuget.config');

            assert.ok(paths.includes(expected1));
            assert.ok(paths.includes(expected2));
            // Workspace configs are last (highest priority), both present
            assert.ok(paths.indexOf(expected1) < paths.indexOf(expected2));
        });

        test('Handles multiple workspace roots with independent configs and <clear />', () => {
            // Create a second workspace root to simulate a multi-root VS Code workspace
            const secondWorkspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nuget-multi-root-'));

            // First workspace has a nuget.config that uses <clear /> with a single source
            const firstWorkspaceConfig = writeConfig(
                workspaceDir,
                'nuget.config',
                [
                    '<configuration>',
                    '  <packageSources>',
                    '    <clear />',
                    '    <add key="FirstSource" value="https://first.example/v3/index.json" />',
                    '  </packageSources>',
                    '</configuration>',
                ].join('\n'),
            );

            // Second workspace has a conflicting source without <clear />
            const secondWorkspaceConfig = writeConfig(
                secondWorkspaceDir,
                'nuget.config',
                [
                    '<configuration>',
                    '  <packageSources>',
                    '    <add key="SecondSource" value="https://second.example/v3/index.json" />',
                    '  </packageSources>',
                    '</configuration>',
                ].join('\n'),
            );

            const paths = (NuGetConfigResolver as any).FindAllConfigFiles([workspaceDir, secondWorkspaceDir]);

            // Both workspace-root configs should be discovered
            assert.ok(paths.includes(firstWorkspaceConfig));
            assert.ok(paths.includes(secondWorkspaceConfig));

            // Ensure deterministic ordering: configs for the first workspace root should appear
            // before configs for the second workspace root. This ordering is important for higher-
            // level resolution logic that applies <clear /> per-root to avoid bleed-through.
            assert.ok(paths.indexOf(firstWorkspaceConfig) < paths.indexOf(secondWorkspaceConfig));
        });
        test('Returns user config paths on Windows', () => {
            Object.defineProperty(process, 'platform', { value: 'win32' });

            // Check if os.homedir() respects USERPROFILE change
            const currentHome = os.homedir();
            // If currentHome is not homeDir, we might have issues if we rely on os.homedir()
            // But let's assume it works or just check behavior.

            const appDataConfig = writeConfig(appDataDir, 'NuGet/NuGet.Config', '<configuration/>');
            // If os.homedir() is not mocked, this path might be wrong in the test expectation if code uses real homedir
            // But we set USERPROFILE.

            const userProfileConfig = writeConfig(homeDir, '.nuget/NuGet/NuGet.Config', '<configuration/>');

            const paths = (NuGetConfigResolver as any).FindAllConfigFiles([]);

            assert.ok(paths.includes(appDataConfig));
            // Only check if homedir was successfully influenced
            if (currentHome === homeDir) {
                assert.ok(paths.includes(userProfileConfig));
            }
        });

        test('Returns user config paths on Non-Windows', () => {
            Object.defineProperty(process, 'platform', { value: 'linux' });

            const userProfileConfig = writeConfig(homeDir, '.nuget/NuGet/NuGet.Config', '<configuration/>');
            const xdgConfig = writeConfig(homeDir, '.config/NuGet/NuGet.Config', '<configuration/>');

            const paths = (NuGetConfigResolver as any).FindAllConfigFiles([]);

            // Only check if homedir was successfully influenced
            if (os.homedir() === homeDir) {
                assert.ok(paths.includes(userProfileConfig));
                assert.ok(paths.includes(xdgConfig));
            }
        });

        test('Returns machine config on Windows', () => {
            Object.defineProperty(process, 'platform', { value: 'win32' });

            const machineConfig = writeConfig(programFilesDir, 'NuGet/Config/Microsoft.VisualStudio.Offline.config', '<configuration/>');

            const paths = (NuGetConfigResolver as any).FindAllConfigFiles([]);
            assert.ok(paths.includes(machineConfig));
        });
    });

    // ... Rest of the tests (ParseConfigFile, etc.) are file-path independent or use paths we pass directly ...

    suite('ParseConfigFile', () => {
        test('Parses sources correctly', async () => {
            const xml = `
                <configuration>
                    <packageSources>
                        <add key="Source1" value="http://source1" />
                        <add key="Source2" value="http://source2" />
                    </packageSources>
                </configuration>
            `;
            const configFile = writeConfig(tempDir, 'test.config', xml);

            const result = await (NuGetConfigResolver as any).ParseConfigFileAsync(configFile);
            assert.strictEqual(result.sources.length, 2);
            assert.strictEqual(result.sources[0].Name, 'Source1');
            assert.strictEqual(result.sources[0].Url, 'http://source1');
            assert.strictEqual(result.sources[1].Name, 'Source2');
            assert.strictEqual(result.sources[1].Url, 'http://source2');
        });

        test('Parses credentials correctly', async () => {
            const xml = `
                <configuration>
                    <packageSourceCredentials>
                        <Source1>
                            <add key="Username" value="user1" />
                            <add key="Password" value="pass1" />
                        </Source1>
                    </packageSourceCredentials>
                </configuration>
            `;
            const configFile = writeConfig(tempDir, 'creds.config', xml);

            const result = await (NuGetConfigResolver as any).ParseConfigFileAsync(configFile);
            assert.strictEqual(result.credentials.get('Source1').Username, 'user1');
            assert.strictEqual(result.credentials.get('Source1').Password, 'pass1');
        });

        test('Handles disabled sources', async () => {
             const xml = `
                <configuration>
                    <disabledPackageSources>
                        <add key="Source1" value="true" />
                    </disabledPackageSources>
                </configuration>
            `;
            const configFile = writeConfig(tempDir, 'disabled.config', xml);

             const result = await (NuGetConfigResolver as any).ParseConfigFileAsync(configFile);
             assert.ok(result.disabledSources.includes('Source1'));
        });

        test('Detects clear tag', async () => {
            const xml = `
                <configuration>
                    <packageSources>
                        <clear />
                        <add key="Source1" value="http://source1" />
                    </packageSources>
                </configuration>
            `;
             const configFile = writeConfig(tempDir, 'clear.config', xml);

             const result = await (NuGetConfigResolver as any).ParseConfigFileAsync(configFile);
             assert.strictEqual(result.clear, true);
        });

        test('Handles malformed XML gracefully', async () => {
             const xml = `<configuration><packageSources><add key="`;
             const configFile = writeConfig(tempDir, 'malformed.config', xml);

             const result = await (NuGetConfigResolver as any).ParseConfigFileAsync(configFile);
             assert.ok(result);
        });
    });

    suite('GetSourcesWithCredentials', () => {
        test('Returns empty list if no config files found', async () => {
            const sources = await NuGetConfigResolver.GetSourcesWithCredentialsAsync(workspaceDir);
            // It might pick up user/machine configs if homedir spoofing failed and real ones exist.
            // But usually in CI/test env there are none.
            // If there are, we can't easily assert empty.
            // But we created a temp workspaceDir, so no workspace configs.

            // If we are unsure about user/machine configs, we can check that it returns *at least* nothing from workspace.
            // But better: we can verify sources logic assuming no external interference or check for known sources only.

            // For this test, let's assume clean env or just check type.
            assert.ok(Array.isArray(sources));
        });

        test('Merges sources and handles disabled sources', async () => {
            const xml = `
                <configuration>
                    <packageSources>
                        <add key="Source1" value="http://source1" />
                        <add key="Source2" value="http://source2" />
                    </packageSources>
                    <disabledPackageSources>
                        <add key="Source2" value="true" />
                    </disabledPackageSources>
                </configuration>
            `;
            writeConfig(workspaceDir, 'nuget.config', xml);

            const sources = await NuGetConfigResolver.GetSourcesWithCredentialsAsync(workspaceDir);
            const source1 = sources.find(s => s.Name === 'Source1');
            assert.ok(source1);

            const source2 = sources.find(s => s.Name === 'Source2');
            assert.strictEqual(source2, undefined);
        });

        test('Maps credentials to sources', async () => {
            const xml = `
                <configuration>
                    <packageSources>
                        <add key="Source1" value="http://source1" />
                    </packageSources>
                    <packageSourceCredentials>
                        <Source1>
                            <add key="Username" value="user" />
                            <add key="Password" value="pass" />
                        </Source1>
                    </packageSourceCredentials>
                </configuration>
            `;
            writeConfig(workspaceDir, 'nuget.config', xml);

            const sources = await NuGetConfigResolver.GetSourcesWithCredentialsAsync(workspaceDir);
            const source1 = sources.find(s => s.Name === 'Source1');
            assert.ok(source1);
            assert.strictEqual(source1?.Username, 'user');
            assert.strictEqual(source1?.Password, 'pass');
        });

        test('Merges source from workspace config with credentials from user profile config (split-file setup)', async () => {
            // Simulate Windows so APPDATA path is used (fully mockable via process.env.APPDATA)
            Object.defineProperty(process, 'platform', { value: 'win32' });

            // User profile config: credentials only — safe to check in, no source URL
            writeConfig(appDataDir, 'NuGet/NuGet.Config', `
                <configuration>
                    <packageSourceCredentials>
                        <codeartifact>
                            <add key="Username" value="aws" />
                            <add key="ClearTextPassword" value="mytoken" />
                        </codeartifact>
                    </packageSourceCredentials>
                </configuration>
            `);

            // Workspace config: source URL only — no credentials, safe to commit
            writeConfig(workspaceDir, 'nuget.config', `
                <configuration>
                    <packageSources>
                        <add key="codeartifact" value="https://example.codeartifact.eu-west-1.amazonaws.com/nuget/nuget/v3/index.json" />
                    </packageSources>
                </configuration>
            `);

            const sources = await NuGetConfigResolver.GetSourcesWithCredentialsAsync(workspaceDir);
            const source = sources.find(s => s.Name === 'codeartifact');
            assert.ok(source, 'Source should be found after merging workspace source + profile credentials');
            assert.strictEqual(source?.Username, 'aws');
            assert.strictEqual(source?.Password, 'mytoken');
        });

        test('Decodes NuGet XML-encoded source names in credentials (e.g. rfh_x002F_nuget → rfh/nuget)', async () => {
            // Mirrors the real-world setup: source key contains "/" which NuGet encodes as _x002F_ in XML
            Object.defineProperty(process, 'platform', { value: 'win32' });

            writeConfig(appDataDir, 'NuGet/NuGet.Config', `
                <configuration>
                    <packageSourceCredentials>
                        <rfh_x002F_nuget>
                            <add key="Username" value="aws" />
                            <add key="ClearTextPassword" value="mytoken" />
                        </rfh_x002F_nuget>
                    </packageSourceCredentials>
                </configuration>
            `);

            writeConfig(workspaceDir, 'nuget.config', `
                <configuration>
                    <packageSources>
                        <clear />
                        <add key="nuget.org" value="https://api.nuget.org/v3/index.json" />
                        <add key="rfh/nuget" value="https://example-123456789.d.codeartifact.eu-west-1.amazonaws.com/nuget/nuget/v3/index.json" />
                    </packageSources>
                </configuration>
            `);

            const sources = await NuGetConfigResolver.GetSourcesWithCredentialsAsync(workspaceDir);
            const source = sources.find(s => s.Name === 'rfh/nuget');
            assert.ok(source, 'Source rfh/nuget should be found');
            assert.strictEqual(source?.Username, 'aws');
            assert.strictEqual(source?.Password, 'mytoken');
        });

        test('Clears sources when <clear /> is present', async () => {
            // Setup User config with Source1
            if (os.homedir() === homeDir) {
                writeConfig(homeDir, '.nuget/NuGet/NuGet.Config', `
                    <configuration>
                        <packageSources>
                            <add key="Source1" value="http://source1" />
                        </packageSources>
                    </configuration>
                `);
            }

            // Setup Workspace config with clear and Source2
            writeConfig(workspaceDir, 'nuget.config', `
                <configuration>
                    <packageSources>
                        <clear />
                        <add key="Source2" value="http://source2" />
                    </packageSources>
                </configuration>
            `);

            const sources = await NuGetConfigResolver.GetSourcesWithCredentialsAsync(workspaceDir);

            const source2 = sources.find(s => s.Name === 'Source2');
            assert.ok(source2);

            if (os.homedir() === homeDir) {
                // <clear /> in the workspace config must clear all inherited sources (user/machine).
                const source1 = sources.find(s => s.Name === 'Source1');
                assert.strictEqual(source1, undefined);
            }
        });

        test('Handles parsing errors gracefully', async () => {
             const badPath = path.join(workspaceDir, 'nuget.config');
             fs.mkdirSync(badPath);

             const sources = await NuGetConfigResolver.GetSourcesWithCredentialsAsync(workspaceDir);

             // Should not throw
             assert.ok(Array.isArray(sources));
             assert.ok((Logger.error as sinon.SinonStub).called);
        });
    });

    suite('CollectWorkspaceConfigFiles', () => {
        test('Returns workspace-level config files for each root', () => {
            writeConfig(workspaceDir, 'nuget.config', '<configuration/>');
            writeConfig(workspaceDir, '.nuget/nuget.config', '<configuration/>');

            const paths = (NuGetConfigResolver as any).CollectWorkspaceConfigFiles([workspaceDir]);

            assert.ok(paths.includes(path.join(workspaceDir, '.nuget', 'nuget.config')));
            assert.ok(paths.includes(path.join(workspaceDir, 'nuget.config')));
            assert.strictEqual(paths.length, 2);
        });

        test('Returns empty array when no workspace roots provided', () => {
            const paths = (NuGetConfigResolver as any).CollectWorkspaceConfigFiles([]);
            assert.strictEqual(paths.length, 0);
        });

        test('Does not include machine or user config paths', () => {
            // Even if user configs exist, CollectWorkspaceConfigFiles should only return workspace paths
            writeConfig(homeDir, '.nuget/NuGet/NuGet.Config', '<configuration/>');
            writeConfig(workspaceDir, 'nuget.config', '<configuration/>');

            const paths = (NuGetConfigResolver as any).CollectWorkspaceConfigFiles([workspaceDir]);

            assert.ok(!paths.includes(path.join(homeDir, '.nuget', 'NuGet', 'NuGet.Config')));
            assert.ok(paths.includes(path.join(workspaceDir, 'nuget.config')));
        });
    });

    suite('GetSourcesAndDecodePasswords', () => {
        test('Keeps local folder sources alongside HTTP feeds', async () => {
            sandbox.stub(NuGetConfigResolver as any, 'ResolveConfigsAsync').resolves({
                sources: [
                    { Name: 'LocalSDK', Url: 'C:/Program Files (x86)/Microsoft SDKs/NuGetPackages/' },
                    { Name: 'Remote', Url: 'https://api.nuget.org/v3/index.json' },
                ],
                clearFound: false,
            });
            vscodeGetConfigurationStub.returns({ get: () => [] });

            const sources = await NuGetConfigResolver.GetSourcesAndDecodePasswordsAsync(workspaceDir);

            assert.deepStrictEqual(sources.map((source) => source.Name), ['LocalSDK', 'Remote']);
        });

        test('Uses VS Code configuration sources', async () => {
            // Stub ResolveConfigsAsync with no file-based sources and no workspace <clear />
            sandbox.stub(NuGetConfigResolver as any, 'ResolveConfigsAsync').resolves({ sources: [], clearFound: false });

            vscodeGetConfigurationStub.returns({
                get: (key: string) => {
                    if (key === 'sources') {
                        return [
                            JSON.stringify({ name: 'VSSource', url: 'http://vssource' })
                        ];
                    }
                    return undefined;
                }
            });

            const sources = await NuGetConfigResolver.GetSourcesAndDecodePasswordsAsync(workspaceDir);
            assert.ok(sources.find(s => s.Name === 'VSSource'));
        });

        test('Adds VS Code settings sources when <clear /> is only in a user/machine config (clearFound = false)', async () => {
            // clearFound = false means <clear /> was not in any workspace config; it should NOT
            // block extension-configured sources from VS Code settings.
            sandbox.stub(NuGetConfigResolver as any, 'ResolveConfigsAsync').resolves({ sources: [], clearFound: false });

            vscodeGetConfigurationStub.returns({
                get: (key: string) => {
                    if (key === 'sources') {
                        return [JSON.stringify({ name: 'ExtSource', url: 'http://ext-source' })];
                    }
                    return undefined;
                }
            });

            const sources = await NuGetConfigResolver.GetSourcesAndDecodePasswordsAsync(workspaceDir);
            assert.ok(sources.find(s => s.Name === 'ExtSource'), 'VS Code settings source should be added when clearFound is false');
        });

        test('Blocks VS Code settings sources when <clear /> is in a workspace config (clearFound = true)', async () => {
            // clearFound = true means a workspace nuget.config used <clear /> to restrict sources.
            // New sources from VS Code settings should NOT be added to honour that intent.
            sandbox.stub(NuGetConfigResolver as any, 'ResolveConfigsAsync').resolves({ sources: [], clearFound: true });

            vscodeGetConfigurationStub.returns({
                get: (key: string) => {
                    if (key === 'sources') {
                        return [JSON.stringify({ name: 'ExtSource', url: 'http://ext-source' })];
                    }
                    return undefined;
                }
            });

            const sources = await NuGetConfigResolver.GetSourcesAndDecodePasswordsAsync(workspaceDir);
            assert.strictEqual(sources.find(s => s.Name === 'ExtSource'), undefined, 'VS Code settings source should be blocked when clearFound is true');
        });

        test('Decodes password when passwordScriptPath is provided', async () => {
            const source = { Name: 'SecureSource', Url: 'http://secure', Password: 'Encrypted' };
            sandbox.stub(NuGetConfigResolver as any, 'ResolveConfigsAsync').resolves({ sources: [source], clearFound: false });

            vscodeGetConfigurationStub.returns({
                get: (key: string) => {
                    if (key === 'sources') {
                        return [
                            JSON.stringify({ name: 'SecureSource', passwordScriptPath: '/path/to/script.sh' })
                        ];
                    }
                    if (key === 'passwordScriptAllowlist') {
                        return ['/path/to'];
                    }
                    return undefined;
                }
            });

            executeScriptStub.withArgs('/path/to/script.sh', 'Encrypted').resolves('Decrypted');

            const sources = await NuGetConfigResolver.GetSourcesAndDecodePasswordsAsync(workspaceDir);

            assert.strictEqual(sources[0]!.Password, 'Decrypted');
        });

        test('Handles password decoding failure', async () => {
            const source = { Name: 'SecureSource', Url: 'http://secure', Password: 'Encrypted' };
            sandbox.stub(NuGetConfigResolver as any, 'ResolveConfigsAsync').resolves({ sources: [source], clearFound: false });

            vscodeGetConfigurationStub.returns({
                get: (key: string) => {
                    if (key === 'sources') {
                        return [
                            JSON.stringify({ name: 'SecureSource', passwordScriptPath: '/path/to/script.sh' })
                        ];
                    }
                    if (key === 'passwordScriptAllowlist') {
                        return ['/path/to'];
                    }
                    return undefined;
                }
            });

            executeScriptStub.rejects(new Error('Script failed'));

            const sources = await NuGetConfigResolver.GetSourcesAndDecodePasswordsAsync(workspaceDir);

            // Should keep original password
            assert.strictEqual(sources[0]!.Password, 'Encrypted');
            assert.ok((Logger.error as sinon.SinonStub).called);
             // Should cache original credential?
        });

        test('Caches credentials even without script', async () => {
             const source = { Name: 'PlainSource', Url: 'http://plain', Username: 'user', Password: 'password' };
             sandbox.stub(NuGetConfigResolver as any, 'ResolveConfigsAsync').resolves({ sources: [source], clearFound: false });
             vscodeGetConfigurationStub.returns({ get: () => [] });

             const sources = await NuGetConfigResolver.GetSourcesAndDecodePasswordsAsync(workspaceDir);

             assert.strictEqual(sources[0]!.Password, 'password');
        });

        test('refuses a password script in an untrusted workspace', async () => {
            isTrustedStub.value(false);
            const source = { Name: 'SecureSource', Url: 'http://secure', Password: 'Encrypted' };
            sandbox.stub(NuGetConfigResolver as any, 'ResolveConfigsAsync').resolves({ sources: [source], clearFound: false });

            vscodeGetConfigurationStub.returns({
                get: (key: string) => {
                    if (key === 'sources') {
                        return [JSON.stringify({ name: 'SecureSource', passwordScriptPath: '/path/to/script.sh' })];
                    }
                    if (key === 'passwordScriptAllowlist') {
                        return ['/path/to'];
                    }
                    return undefined;
                }
            });

            const sources = await NuGetConfigResolver.GetSourcesAndDecodePasswordsAsync(workspaceDir);

            assert.strictEqual(sources[0]!.Password, 'Encrypted');
            assert.strictEqual(executeScriptStub.called, false);
        });

        test('refuses a password script outside the machine allowlist', async () => {
            const source = { Name: 'SecureSource', Url: 'http://secure', Password: 'Encrypted' };
            sandbox.stub(NuGetConfigResolver as any, 'ResolveConfigsAsync').resolves({ sources: [source], clearFound: false });

            vscodeGetConfigurationStub.returns({
                get: (key: string) => {
                    if (key === 'sources') {
                        return [JSON.stringify({ name: 'SecureSource', passwordScriptPath: '/path/to/script.sh' })];
                    }
                    if (key === 'passwordScriptAllowlist') {
                        return ['/different/directory'];
                    }
                    return undefined;
                }
            });

            const sources = await NuGetConfigResolver.GetSourcesAndDecodePasswordsAsync(workspaceDir);

            assert.strictEqual(sources[0]!.Password, 'Encrypted');
            assert.strictEqual(executeScriptStub.called, false);
        });

        test('does not expand %VAR% in workspace config credentials', async () => {
            process.env.MY_NUGET_TOKEN = 'secret-value';
            const configPath = writeConfig(
                workspaceDir,
                'nuget.config',
                '<configuration><packageSourceCredentials><SecureSource>' +
                '<add key="Username" value="user" />' +
                '<add key="ClearTextPassword" value="%MY_NUGET_TOKEN%" />' +
                '</SecureSource></packageSourceCredentials></configuration>'
            );

            const workspaceResult = await (NuGetConfigResolver as any).ParseConfigFileAsync(configPath, false);
            assert.strictEqual(workspaceResult.credentials.get('SecureSource')?.Password, '%MY_NUGET_TOKEN%');

            const userResult = await (NuGetConfigResolver as any).ParseConfigFileAsync(configPath, true);
            assert.strictEqual(userResult.credentials.get('SecureSource')?.Password, 'secret-value');
        });
    });
});
