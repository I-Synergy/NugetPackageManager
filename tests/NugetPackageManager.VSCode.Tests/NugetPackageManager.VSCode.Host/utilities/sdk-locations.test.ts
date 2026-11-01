import * as assert from 'assert';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
    ConfigureSdkRoots,
    GetPrivateDotnetPath,
    GetPrivateSdkVersions,
    ListSdkVersions,
    SdkVersionSatisfies,
    SelectDotnetCommand,
} from '@/host/utilities/sdk-locations';

suite('sdk-locations', () => {
    let root: string;

    setup(() => {
        root = fs.mkdtempSync(path.join(os.tmpdir(), 'npm-sdk-locations-'));
    });

    teardown(() => {
        ConfigureSdkRoots(null);
        fs.rmSync(root, { recursive: true, force: true });
    });

    test('ListSdkVersions reads the sdk folder, newest first', () => {
        fs.mkdirSync(path.join(root, 'sdk', '10.0.403'), { recursive: true });
        fs.mkdirSync(path.join(root, 'sdk', '9.0.320'), { recursive: true });

        assert.deepStrictEqual(ListSdkVersions(root), ['10.0.403', '9.0.320']);
        assert.deepStrictEqual(ListSdkVersions(path.join(root, 'missing')), []);
    });

    test('SdkVersionSatisfies accepts an exact match or a shorter roll-forward line', () => {
        assert.strictEqual(SdkVersionSatisfies('10.0.403', '10.0.403'), true);
        assert.strictEqual(SdkVersionSatisfies('10.0.404', '10.0.403'), false);
        assert.strictEqual(SdkVersionSatisfies('10.0.403', '10.0.403.1'), true);
    });

    test('SelectDotnetCommand prefers the private host only for installed SDKs', () => {
        const installRoot = path.join(root, 'dotnet');
        fs.mkdirSync(path.join(installRoot, 'sdk', '10.0.403'), { recursive: true });
        const host = path.join(installRoot, process.platform === 'win32' ? 'dotnet.exe' : 'dotnet');
        fs.writeFileSync(host, '');

        ConfigureSdkRoots({ InstallRoot: installRoot });

        assert.strictEqual(GetPrivateDotnetPath(), host);
        assert.deepStrictEqual(GetPrivateSdkVersions(), ['10.0.403']);
        assert.strictEqual(SelectDotnetCommand(undefined), 'dotnet');
        assert.strictEqual(SelectDotnetCommand('10.0.403'), host);
        assert.strictEqual(SelectDotnetCommand('9.0.100'), 'dotnet');
    });
});
