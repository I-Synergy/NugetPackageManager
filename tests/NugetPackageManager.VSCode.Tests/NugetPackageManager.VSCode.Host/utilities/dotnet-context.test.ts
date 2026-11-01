import * as assert from 'assert';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
    FindGlobalJsonUpwards,
    ParseGlobalJson,
    ResolveDotnetContext,
    ResolveWorkingDirectory,
    StripJsonCommentsAndTrailingCommas,
} from '@/host/utilities/dotnet-context';

suite('dotnet-context', () => {
    let root: string;

    setup(() => {
        root = fs.mkdtempSync(path.join(os.tmpdir(), 'npm-dotnet-context-'));
    });

    teardown(() => {
        fs.rmSync(root, { recursive: true, force: true });
    });

    test('ParseGlobalJson reads the sdk section', () => {
        const settings = ParseGlobalJson(JSON.stringify({
            sdk: { version: '10.0.403', rollForward: 'latestPatch', allowPrerelease: false },
        }));
        assert.deepStrictEqual(settings, {
            Version: '10.0.403',
            RollForward: 'latestPatch',
            AllowPrerelease: false,
        });
    });

    test('ParseGlobalJson tolerates comments, BOM and trailing commas', () => {
        const content = '\uFEFF{\n  // pinned for CI\n  "sdk": {\n    "version": "10.0.403", /* keep */\n  },\n}\n';
        assert.strictEqual(StripJsonCommentsAndTrailingCommas(content).includes('//'), false);
        assert.deepStrictEqual(ParseGlobalJson(content), { Version: '10.0.403' });
    });

    test('ParseGlobalJson returns null for malformed input', () => {
        assert.strictEqual(ParseGlobalJson('{ not json'), null);
        assert.strictEqual(ParseGlobalJson('{"msbuild-sdks":{}}'), null);
    });

    test('FindGlobalJsonUpwards finds the nearest file', () => {
        const nested = path.join(root, 'src', 'App');
        fs.mkdirSync(nested, { recursive: true });
        const globalJson = path.join(root, 'global.json');
        fs.writeFileSync(globalJson, '{}');

        assert.strictEqual(FindGlobalJsonUpwards(nested), globalJson);
    });

    test('FindGlobalJsonUpwards stops at stopAt', () => {
        const workspace = path.join(root, 'repo');
        const nested = path.join(workspace, 'src');
        fs.mkdirSync(nested, { recursive: true });
        fs.writeFileSync(path.join(root, 'global.json'), '{}');

        assert.strictEqual(FindGlobalJsonUpwards(nested, workspace), null);
    });

    test('ResolveDotnetContext runs dotnet from the global.json directory', () => {
        const projectDir = path.join(root, 'tests', 'App.Tests');
        fs.mkdirSync(projectDir, { recursive: true });
        const projectPath = path.join(projectDir, 'App.Tests.csproj');
        fs.writeFileSync(projectPath, '<Project />');
        const globalJson = path.join(root, 'global.json');
        fs.writeFileSync(globalJson, JSON.stringify({ sdk: { version: '10.0.403' } }));

        const context = ResolveDotnetContext(projectPath);

        assert.strictEqual(context.WorkingDirectory, root);
        assert.strictEqual(context.GlobalJsonPath, globalJson);
        assert.strictEqual(context.PinnedSdkVersion, '10.0.403');
    });

    test('ResolveDotnetContext falls back to the project directory', () => {
        const projectDir = path.join(root, 'nopin');
        fs.mkdirSync(projectDir, { recursive: true });
        const projectPath = path.join(projectDir, 'App.csproj');
        fs.writeFileSync(projectPath, '<Project />');

        const context = ResolveDotnetContext(projectPath);

        assert.strictEqual(context.WorkingDirectory, projectDir);
        assert.strictEqual(context.GlobalJsonPath, undefined);
        assert.strictEqual(context.PinnedSdkVersion, undefined);
    });

    test('ResolveWorkingDirectory prefers the directory that owns global.json', () => {
        const workspace = path.join(root, 'ws');
        fs.mkdirSync(workspace, { recursive: true });
        fs.writeFileSync(path.join(workspace, 'global.json'), '{}');

        assert.strictEqual(ResolveWorkingDirectory(workspace), workspace);
        assert.strictEqual(ResolveWorkingDirectory(path.join(root, 'other')), path.join(root, 'other'));
    });
});
