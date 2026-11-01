import * as assert from 'assert';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
    ConfigureSdkRoots,
    DetectOrphanedManifestBands,
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

    test('DetectOrphanedManifestBands finds bands with no installed SDK', () => {
        const dotnetRoot = path.join(root, 'dotnet');
        for (const band of ['10.0.100', '10.0.400', '9.0.100', '11.0.100-preview.6']) {
            fs.mkdirSync(path.join(dotnetRoot, 'sdk-manifests', band, 'microsoft.net.workload.emscripten.current'), {
                recursive: true,
            });
        }

        const orphans = DetectOrphanedManifestBands(dotnetRoot, ['9.0.320', '10.0.403', '11.0.100-rc.3.26522.148']);

        assert.deepStrictEqual(orphans.map((orphan) => orphan.Band), ['10.0.100', '9.0.100']);
        assert.deepStrictEqual(orphans[0]!.Manifests, ['microsoft.net.workload.emscripten.current']);
        assert.strictEqual(orphans[0]!.Path.endsWith(path.join('sdk-manifests', '10.0.100')), true);
    });

    test('DetectOrphanedManifestBands returns nothing when every band has an SDK', () => {
        const dotnetRoot = path.join(root, 'dotnet');
        fs.mkdirSync(path.join(dotnetRoot, 'sdk-manifests', '10.0.400'), { recursive: true });

        assert.deepStrictEqual(DetectOrphanedManifestBands(dotnetRoot, ['10.0.403']), []);
        assert.deepStrictEqual(DetectOrphanedManifestBands(path.join(root, 'missing'), ['10.0.403']), []);
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
