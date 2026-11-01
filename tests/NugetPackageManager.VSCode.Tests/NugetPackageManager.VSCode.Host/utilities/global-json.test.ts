import * as assert from 'assert';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { IsValidSdkVersion, UpdateGlobalJsonSdkVersion, UpdateGlobalJsonSdkVersionAsync } from '@/host/utilities/global-json';

suite('global-json', () => {
    let root: string;

    setup(() => {
        root = fs.mkdtempSync(path.join(os.tmpdir(), 'npm-global-json-'));
    });

    teardown(() => {
        fs.rmSync(root, { recursive: true, force: true });
    });

    test('IsValidSdkVersion accepts concrete versions only', () => {
        assert.strictEqual(IsValidSdkVersion('10.0.403'), true);
        assert.strictEqual(IsValidSdkVersion('11.0.100-rc.3.26522.148'), true);
        assert.strictEqual(IsValidSdkVersion('latest'), false);
        assert.strictEqual(IsValidSdkVersion('10.0'), false);
    });

    test('creates global.json at the workspace root when none exists', () => {
        const result = UpdateGlobalJsonSdkVersion({ StartDirectory: root, Version: '10.0.403' });

        assert.strictEqual(result.GlobalJsonPath, path.join(root, 'global.json'));
        assert.strictEqual(result.Created, true);
        assert.strictEqual(result.Changed, true);

        const parsed = JSON.parse(fs.readFileSync(result.GlobalJsonPath, 'utf8')) as {
            sdk: { version: string; rollForward: string };
        };
        assert.strictEqual(parsed.sdk.version, '10.0.403');
        assert.strictEqual(parsed.sdk.rollForward, 'disable');
    });

    test('replaces the pinned version and keeps unrelated keys', () => {
        const globalJson = path.join(root, 'global.json');
        fs.writeFileSync(globalJson, JSON.stringify({
            sdk: { version: '10.0.403', rollForward: 'latestPatch', allowPrerelease: false },
            'msbuild-sdks': { 'Some.Sdk': '1.2.3' },
        }, null, 2));

        const result = UpdateGlobalJsonSdkVersion({ StartDirectory: root, Version: '10.0.404' });

        assert.strictEqual(result.Changed, true);
        assert.strictEqual(result.PreviousVersion, '10.0.403');
        const parsed = JSON.parse(fs.readFileSync(globalJson, 'utf8')) as {
            sdk: { version: string; rollForward: string; allowPrerelease: boolean };
            'msbuild-sdks': Record<string, string>;
        };
        assert.strictEqual(parsed.sdk.version, '10.0.404');
        assert.strictEqual(parsed.sdk.rollForward, 'disable');
        assert.strictEqual(parsed.sdk.allowPrerelease, false);
        assert.deepStrictEqual(parsed['msbuild-sdks'], { 'Some.Sdk': '1.2.3' });
    });

    test('adds a version to an existing sdk section without one', () => {
        const globalJson = path.join(root, 'global.json');
        fs.writeFileSync(globalJson, '{\n  "sdk": {\n    "rollForward": "latestMinor"\n  }\n}\n');

        const result = UpdateGlobalJsonSdkVersion({ StartDirectory: root, Version: '10.0.403' });

        const parsed = JSON.parse(fs.readFileSync(globalJson, 'utf8')) as {
            sdk: { version: string; rollForward: string };
        };
        assert.strictEqual(parsed.sdk.version, '10.0.403');
        assert.strictEqual(parsed.sdk.rollForward, 'disable');
        assert.strictEqual(result.Changed, true);
    });

    test('is a no-op when the version is already pinned exactly', () => {
        const globalJson = path.join(root, 'global.json');
        fs.writeFileSync(
            globalJson,
            '{\n  "sdk": {\n    "version": "10.0.403",\n    "rollForward": "disable"\n  }\n}\n'
        );

        const result = UpdateGlobalJsonSdkVersion({ StartDirectory: root, Version: '10.0.403' });

        assert.strictEqual(result.Changed, false);
        assert.strictEqual(result.Created, false);
        assert.deepStrictEqual(result.Notes, []);
        assert.strictEqual(result.GlobalJsonPath, globalJson);
    });

    test('adds rollForward: disable to a version-only pin', () => {
        const globalJson = path.join(root, 'global.json');
        fs.writeFileSync(globalJson, '{\n  "sdk": {\n    "version": "10.0.403"\n  }\n}\n');

        const result = UpdateGlobalJsonSdkVersion({ StartDirectory: root, Version: '10.0.403' });

        const parsed = JSON.parse(fs.readFileSync(globalJson, 'utf8')) as {
            sdk: Record<string, string>;
        };
        assert.strictEqual(parsed.sdk['rollForward'], 'disable');
        assert.strictEqual(result.Changed, true);
        assert.deepStrictEqual(result.Notes, ['sdk.rollForward set to disable']);
    });

    test('updates the nearest global.json, not the workspace root', () => {
        const nested = path.join(root, 'src', 'App');
        fs.mkdirSync(nested, { recursive: true });
        const globalJson = path.join(root, 'global.json');
        fs.writeFileSync(globalJson, JSON.stringify({ sdk: { version: '10.0.403' } }));

        const result = UpdateGlobalJsonSdkVersion({ StartDirectory: nested, Version: '9.0.320' });

        assert.strictEqual(result.GlobalJsonPath, globalJson);
        assert.strictEqual(
            (JSON.parse(fs.readFileSync(globalJson, 'utf8')) as { sdk: { version: string } }).sdk.version,
            '9.0.320'
        );
    });

    test('keeps workloadVersion and tools.dotnet coherent with the new pin', () => {
        const globalJson = path.join(root, 'global.json');
        fs.writeFileSync(globalJson, `{
  "sdk": {
    "version": "10.0.403",
    "rollForward": "latestPatch",
    "allowPrerelease": false,
    "workloadVersion": "10.0.401.1"
  },
  "tools": {
    "dotnet": "10.0.403"
  },
  "test": {
      "runner": "Microsoft.Testing.Platform"
  }
}
`);

        const result = UpdateGlobalJsonSdkVersion({
            StartDirectory: root,
            Version: '11.0.100-rc.3.26522.148',
        });

        const parsed = JSON.parse(fs.readFileSync(globalJson, 'utf8')) as {
            sdk: Record<string, unknown>;
            tools: Record<string, string>;
            test: Record<string, string>;
        };
        assert.strictEqual(parsed.sdk['version'], '11.0.100-rc.3.26522.148');
        assert.strictEqual(parsed.sdk['allowPrerelease'], true);
        assert.strictEqual('workloadVersion' in parsed.sdk, false);
        assert.strictEqual(parsed.tools['dotnet'], '11.0.100-rc.3.26522.148');
        assert.strictEqual(parsed.test['runner'], 'Microsoft.Testing.Platform');
        assert.strictEqual(result.Notes.length, 4);
        assert.strictEqual(parsed.sdk['rollForward'], 'disable');
    });

    test('keeps workloadVersion when the new pin is in the same feature band', () => {
        const globalJson = path.join(root, 'global.json');
        fs.writeFileSync(globalJson, JSON.stringify({
            sdk: { version: '10.0.403', workloadVersion: '10.0.401.1' },
            tools: { dotnet: '10.0.403' },
        }, null, 2));

        const result = UpdateGlobalJsonSdkVersion({ StartDirectory: root, Version: '10.0.403' });

        const parsed = JSON.parse(fs.readFileSync(globalJson, 'utf8')) as {
            sdk: Record<string, unknown>;
        };
        assert.strictEqual(parsed.sdk['workloadVersion'], '10.0.401.1');
        assert.strictEqual(parsed.sdk['rollForward'], 'disable');
        assert.deepStrictEqual(result.Notes, ['sdk.rollForward set to disable']);
    });

    test('falls back to the writer when the globaljson template is unavailable', async () => {
        const result = await UpdateGlobalJsonSdkVersionAsync({
            StartDirectory: root,
            Version: '10.0.403',
            Command: 'dotnet-does-not-exist-xyz',
        });

        assert.strictEqual(result.Source, 'edit');
        const parsed = JSON.parse(fs.readFileSync(result.GlobalJsonPath, 'utf8')) as {
            sdk: { version: string; rollForward: string };
        };
        assert.strictEqual(parsed.sdk.version, '10.0.403');
        assert.strictEqual(parsed.sdk.rollForward, 'disable');
    });

    test('never hands an existing file to the template', async () => {
        const globalJson = path.join(root, 'global.json');
        fs.writeFileSync(globalJson, JSON.stringify({
            sdk: { version: '10.0.403' },
            test: { runner: 'Microsoft.Testing.Platform' },
        }, null, 2));

        const result = await UpdateGlobalJsonSdkVersionAsync({
            StartDirectory: root,
            Version: '10.0.404',
            Command: 'dotnet-does-not-exist-xyz',
        });

        assert.strictEqual(result.Source, 'edit');
        const parsed = JSON.parse(fs.readFileSync(globalJson, 'utf8')) as {
            sdk: { version: string };
            test: Record<string, string>;
        };
        assert.strictEqual(parsed.sdk.version, '10.0.404');
        assert.strictEqual(parsed.test['runner'], 'Microsoft.Testing.Platform');
    });

    test('rejects an invalid version without touching the file', () => {
        const globalJson = path.join(root, 'global.json');
        fs.writeFileSync(globalJson, '{"sdk":{"version":"10.0.403"}}');

        assert.throws(() => UpdateGlobalJsonSdkVersion({ StartDirectory: root, Version: 'latest' }), /not a valid/);
        assert.strictEqual(fs.readFileSync(globalJson, 'utf8'), '{"sdk":{"version":"10.0.403"}}');
    });
});
