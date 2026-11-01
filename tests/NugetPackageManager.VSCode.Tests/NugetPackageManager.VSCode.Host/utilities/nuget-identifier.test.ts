import * as assert from 'assert';
import { isValidNuGetVersion, isValidPackageId } from '@/host/utilities/nuget-identifier';
import { compareVersions, isVersionInRange } from '@/host/utilities/version';

suite('nuget-identifier Tests', () => {
    test('accepts valid package IDs', () => {
        for (const id of ['Newtonsoft.Json', 'Microsoft.Extensions.Logging', 'A', 'a_b-c.d', 'Pkg123']) {
            assert.strictEqual(isValidPackageId(id), true, id);
        }
    });

    test('rejects invalid package IDs', () => {
        for (const id of ['', '.leading', '-leading', 'has space', 'has/slash', 'has<gt', 'x'.repeat(101)]) {
            assert.strictEqual(isValidPackageId(id), false, id);
        }
    });

    test('accepts valid NuGet versions', () => {
        for (const version of [
            '1.0.0',
            '1',
            '1.2.3.4',
            '1.0.0-beta',
            '1.0.0-beta.1',
            '1.0.0-rc.2.26504.105',
            '1.0.0+build.5',
            '1.0.0-beta+build',
        ]) {
            assert.strictEqual(isValidNuGetVersion(version), true, version);
        }
    });

    test('rejects XML and option injection in versions', () => {
        for (const version of [
            '',
            '1.0.0"',
            '1.0.0<',
            '1.0.0>',
            '1.0.0 /><PackageVersion Include="Evil" Version="9.9.9',
            '-1.0.0',
            '1.0.0 beta',
            'v1.0.0',
        ]) {
            assert.strictEqual(isValidNuGetVersion(version), false, version);
        }
    });
});

suite('version Tests', () => {
    test('orders stable and prerelease versions', () => {
        assert.ok(compareVersions('2.0.0', '1.9.9') > 0);
        assert.ok(compareVersions('1.0.0', '1.0.0-beta') > 0);
        assert.ok(compareVersions('1.0.0-beta.2', '1.0.0-beta.1') > 0);
        assert.ok(compareVersions('1.0.0-alpha', '1.0.0-beta') < 0);
        assert.strictEqual(compareVersions('1.0.0+build', '1.0.0'), 0);
        assert.strictEqual(compareVersions('1.0.0.1', '1.0.0.1'), 0);
    });

    test('matches NuGet version ranges', () => {
        assert.strictEqual(isVersionInRange('1.5.0', '[1.0.0, 2.0.0)'), true);
        assert.strictEqual(isVersionInRange('2.0.0', '[1.0.0, 2.0.0)'), false);
        assert.strictEqual(isVersionInRange('2.0.0', '(1.0.0, 2.0.0]'), true);
        assert.strictEqual(isVersionInRange('1.0.0', '(1.0.0, 2.0.0]'), false);
        assert.strictEqual(isVersionInRange('1.5.0', '[1.0.0, )'), true);
        assert.strictEqual(isVersionInRange('1.5.0', '(, 2.0.0)'), true);
        assert.strictEqual(isVersionInRange('1.0.0', '[1.0.0]'), true);
        assert.strictEqual(isVersionInRange('1.0.1', '[1.0.0]'), false);
        assert.strictEqual(isVersionInRange('1.0.0', ''), false);
    });
});
