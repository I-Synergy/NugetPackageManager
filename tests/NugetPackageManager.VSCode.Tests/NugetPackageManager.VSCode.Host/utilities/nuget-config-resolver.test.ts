import * as assert from 'assert';
import * as sinon from 'sinon';
import * as vscode from 'vscode';
import coreProcess from '@/host/nuget/core-process';
import NuGetConfigResolver from '@/host/utilities/nuget-config-resolver';
import PasswordScriptExecutor from '@/host/utilities/password-script-executor';
import { Logger } from '@/common/logger';

/**
 * The VS Code half of config resolution. Discovery, XML parsing and merging are covered by
 * `NuGetConfigDiscoveryTests` / `NuGetConfigParserTests` / `NuGetConfigResolverTests` in
 * `tests/NugetPackageManager.Core.NuGet.Tests`; this suite pins the host composition around the
 * `resolveNuGetConfig` call.
 */

type CoreResolution = {
    sources: Array<{ name: string; url: string; username?: string; password?: string; patterns?: string[] }>;
    clearFound: boolean;
    failures: Array<{ path: string; message: string }>;
};

suite('NuGetConfigResolver Tests', () => {
    let sandbox: sinon.SinonSandbox;
    let vscodeGetConfigurationStub: sinon.SinonStub;
    let isTrustedStub: sinon.SinonStub;
    let executeScriptStub: sinon.SinonStub;
    let coreCallStub: sinon.SinonStub;

    const workspaceDir = '/ws';

    setup(() => {
        sandbox = sinon.createSandbox();
        vscodeGetConfigurationStub = sandbox.stub(vscode.workspace, 'getConfiguration');
        isTrustedStub = sandbox.stub(vscode.workspace, 'isTrusted').value(true);
        executeScriptStub = sandbox.stub(PasswordScriptExecutor, 'ExecuteScriptAsync');
        sandbox.stub(Logger, 'debug');
        sandbox.stub(Logger, 'error');
        sandbox.stub(Logger, 'info');
        sandbox.stub(Logger, 'warn');
        coreCallStub = sandbox.stub(coreProcess, 'CallAsync');
        stubCore({});
    });

    teardown(() => {
        sandbox.restore();
    });

    function stubCore(result: Partial<CoreResolution>): void {
        coreCallStub.callsFake(async (method: string) => {
            assert.strictEqual(method, 'resolveNuGetConfig');
            return {
                sources: result.sources ?? [],
                clearFound: result.clearFound ?? false,
                failures: result.failures ?? [],
            };
        });
    }

    function configGet(values: Record<string, unknown>): void {
        vscodeGetConfigurationStub.returns({
            get: (key: string) => values[key],
        });
    }

    test('sends the workspace roots to the core', async () => {
        stubCore({});
        configGet({ sources: [] });

        await NuGetConfigResolver.GetSourcesAndDecodePasswordsAsync(workspaceDir);

        assert.strictEqual(coreCallStub.callCount, 1);
        const params = coreCallStub.firstCall.args[1] as {
            workspaceRoots: string[];
            platform: string;
            homeDirectory: string;
        };
        assert.deepStrictEqual(params.workspaceRoots, [workspaceDir]);
        assert.strictEqual(params.platform, process.platform);
        assert.ok(params.homeDirectory.length > 0);
    });

    test('keeps local folder sources alongside HTTP feeds', async () => {
        stubCore({
            sources: [
                { name: 'LocalSDK', url: 'C:/Program Files (x86)/Microsoft SDKs/NuGetPackages/' },
                { name: 'Remote', url: 'https://api.nuget.org/v3/index.json' },
            ],
        });
        configGet({ sources: [] });

        const sources = await NuGetConfigResolver.GetSourcesAndDecodePasswordsAsync(workspaceDir);

        assert.deepStrictEqual(sources.map((source) => source.Name), ['LocalSDK', 'Remote']);
    });

    test('drops sources that are neither HTTP nor a local feed', async () => {
        stubCore({ sources: [{ name: 'Weird', url: 'ftp://example.test/feed' }] });
        configGet({ sources: [] });

        const sources = await NuGetConfigResolver.GetSourcesAndDecodePasswordsAsync(workspaceDir);

        assert.strictEqual(sources.length, 0);
    });

    test('maps the core credentials and mapping patterns onto the source', async () => {
        stubCore({
            sources: [{
                name: 'Private',
                url: 'https://private.test/v3/index.json',
                username: 'dev',
                password: 'plain',
                patterns: ['Contoso.*'],
            }],
        });
        configGet({ sources: [] });

        const sources = await NuGetConfigResolver.GetSourcesAndDecodePasswordsAsync(workspaceDir);

        assert.deepStrictEqual(sources[0], {
            Name: 'Private',
            Url: 'https://private.test/v3/index.json',
            Username: 'dev',
            Password: 'plain',
            Patterns: ['Contoso.*'],
        });
    });

    test('uses VS Code configuration sources', async () => {
        stubCore({ sources: [], clearFound: false });
        configGet({ sources: [JSON.stringify({ name: 'VSSource', url: 'http://vssource' })] });

        const sources = await NuGetConfigResolver.GetSourcesAndDecodePasswordsAsync(workspaceDir);

        assert.ok(sources.find((source) => source.Name === 'VSSource'));
    });

    test('adds VS Code settings sources when the workspace has no <clear />', async () => {
        stubCore({ sources: [], clearFound: false });
        configGet({ sources: [JSON.stringify({ name: 'ExtSource', url: 'http://ext-source' })] });

        const sources = await NuGetConfigResolver.GetSourcesAndDecodePasswordsAsync(workspaceDir);

        assert.ok(sources.find((source) => source.Name === 'ExtSource'));
    });

    test('blocks VS Code settings sources when a workspace config used <clear />', async () => {
        stubCore({ sources: [], clearFound: true });
        configGet({ sources: [JSON.stringify({ name: 'ExtSource', url: 'http://ext-source' })] });

        const sources = await NuGetConfigResolver.GetSourcesAndDecodePasswordsAsync(workspaceDir);

        assert.strictEqual(sources.find((source) => source.Name === 'ExtSource'), undefined);
    });

    test('logs the config failures the core reported', async () => {
        stubCore({ failures: [{ path: '/ws/nuget.config', message: 'malformed' }] });
        configGet({ sources: [] });

        await NuGetConfigResolver.GetSourcesAndDecodePasswordsAsync(workspaceDir);

        assert.ok((Logger.error as sinon.SinonStub).calledWithMatch('/ws/nuget.config'));
    });

    test('decodes the password when a passwordScriptPath is configured', async () => {
        stubCore({
            sources: [{ name: 'SecureSource', url: 'http://secure', password: 'Encrypted' }],
        });
        configGet({
            sources: [JSON.stringify({ name: 'SecureSource', passwordScriptPath: '/path/to/script.sh' })],
            passwordScriptAllowlist: ['/path/to'],
        });
        executeScriptStub.withArgs('/path/to/script.sh', 'Encrypted').resolves('Decrypted');

        const sources = await NuGetConfigResolver.GetSourcesAndDecodePasswordsAsync(workspaceDir);

        assert.strictEqual(sources[0]!.Password, 'Decrypted');
    });

    test('keeps the original password when the script fails', async () => {
        stubCore({
            sources: [{ name: 'SecureSource', url: 'http://secure', password: 'Encrypted' }],
        });
        configGet({
            sources: [JSON.stringify({ name: 'SecureSource', passwordScriptPath: '/path/to/script.sh' })],
            passwordScriptAllowlist: ['/path/to'],
        });
        executeScriptStub.rejects(new Error('Script failed'));

        const sources = await NuGetConfigResolver.GetSourcesAndDecodePasswordsAsync(workspaceDir);

        assert.strictEqual(sources[0]!.Password, 'Encrypted');
        assert.ok((Logger.error as sinon.SinonStub).called);
    });

    test('keeps credentials that need no script', async () => {
        stubCore({
            sources: [{ name: 'PlainSource', url: 'http://plain', username: 'user', password: 'password' }],
        });
        configGet({ sources: [] });

        const sources = await NuGetConfigResolver.GetSourcesAndDecodePasswordsAsync(workspaceDir);

        assert.strictEqual(sources[0]!.Password, 'password');
    });

    test('refuses a password script in an untrusted workspace', async () => {
        isTrustedStub.value(false);
        stubCore({
            sources: [{ name: 'SecureSource', url: 'http://secure', password: 'Encrypted' }],
        });
        configGet({
            sources: [JSON.stringify({ name: 'SecureSource', passwordScriptPath: '/path/to/script.sh' })],
            passwordScriptAllowlist: ['/path/to'],
        });

        const sources = await NuGetConfigResolver.GetSourcesAndDecodePasswordsAsync(workspaceDir);

        assert.strictEqual(sources[0]!.Password, 'Encrypted');
        assert.strictEqual(executeScriptStub.called, false);
    });

    test('refuses a password script outside the machine allowlist', async () => {
        stubCore({
            sources: [{ name: 'SecureSource', url: 'http://secure', password: 'Encrypted' }],
        });
        configGet({
            sources: [JSON.stringify({ name: 'SecureSource', passwordScriptPath: '/path/to/script.sh' })],
            passwordScriptAllowlist: ['/different/directory'],
        });

        const sources = await NuGetConfigResolver.GetSourcesAndDecodePasswordsAsync(workspaceDir);

        assert.strictEqual(sources[0]!.Password, 'Encrypted');
        assert.strictEqual(executeScriptStub.called, false);
    });

    test('GetSourcesWithCredentialsAsync skips the VS Code layer', async () => {
        stubCore({ sources: [{ name: 'Remote', url: 'https://api.nuget.org/v3/index.json' }] });
        configGet({ sources: [JSON.stringify({ name: 'ExtSource', url: 'http://ext-source' })] });

        const sources = await NuGetConfigResolver.GetSourcesWithCredentialsAsync(workspaceDir);

        assert.deepStrictEqual(sources.map((source) => source.Name), ['Remote']);
    });
});
