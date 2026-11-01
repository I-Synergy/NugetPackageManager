import * as assert from 'assert';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { repositoryPath } from '../../test-paths';
import CpmResolver from '@/host/utilities/cpm-resolver';
import { evaluateCondition, getConditionLabel } from '@/host/utilities/cpm-condition';
import { Logger } from '@/common/logger';

/**
 * Table-driven validation over several real Directory.Packages.props variants.
 * Fixtures live in `tests/__fixtures__/cpm`.
 */
suite('CPM fixture variants', () => {
    let tmpDir: string;
    const originalDebug = Logger.debug;
    const originalError = Logger.error;

    function fixturesDir(): string {
        return repositoryPath('tests', '__fixtures__', 'cpm');
    }

    function readFixture(name: string): string {
        return fs.readFileSync(path.join(fixturesDir(), name), 'utf8');
    }

    function copyFixture(name: string): { propsPath: string; projectPath: string } {
        const propsName = name.endsWith('.props') ? name : `${name}.props`;
        const propsPath = path.join(tmpDir, 'Directory.Packages.props');
        fs.writeFileSync(propsPath, readFixture(propsName));

        const projectDir = path.join(tmpDir, 'src', path.basename(name, '.props'));
        fs.mkdirSync(projectDir, { recursive: true });
        const projectPath = path.join(projectDir, 'App.csproj');
        fs.writeFileSync(
            projectPath,
            '<Project Sdk="Microsoft.NET.Sdk"><PropertyGroup><TargetFramework>net10.0</TargetFramework><ManagePackageVersionsCentrally>true</ManagePackageVersionsCentrally></PropertyGroup></Project>'
        );
        return { propsPath, projectPath };
    }

    setup(() => {
        tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cpm-fixture-test-'));
        Logger.debug = () => {};
        Logger.error = () => {};
    });

    teardown(() => {
        Logger.debug = originalDebug;
        Logger.error = originalError;
        fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    test('single unconditional group resolves one shared row per package', async () => {
        const { propsPath, projectPath } = copyFixture('single-group');
        const map = await CpmResolver.GetFrameworkPackageMapAsync(projectPath);

        assert.ok(map);
        assert.strictEqual(map!.unconditional.size, 2);
        assert.strictEqual(map!.conditional.length, 0);
        assert.strictEqual(map!.hasConditionalGroups, false);

        const resolved = CpmResolver.ResolveVersions(
            map!,
            ['Newtonsoft.Json', 'Serilog'],
            ['net10.0', 'net11.0']
        );
        for (const id of ['Newtonsoft.Json', 'Serilog']) {
            const entries = resolved.get(id)!;
            assert.strictEqual(entries.length, 1);
            assert.strictEqual(entries[0]!.Tfm, '');
            assert.strictEqual(entries[0]!.Condition, '');
        }

        await CpmResolver.UpdateCpmVersionsAsync(propsPath, [
            { packageId: 'Serilog', version: '3.0.0' },
        ]);
        const updated = await CpmResolver.ParseCpmFileAsync(propsPath);
        assert.strictEqual(updated.unconditional.get('Serilog'), '3.0.0');
        assert.strictEqual(updated.unconditional.get('Newtonsoft.Json'), '13.0.3');
    });

    test('distinct positive groups resolve only their own packages', async () => {
        const { projectPath } = copyFixture('distinct-positive-groups');
        const map = await CpmResolver.GetFrameworkPackageMapAsync(projectPath);
        assert.ok(map);
        assert.deepStrictEqual(
            map!.conditional.map((entry) => entry.framework).sort((a, b) => a.localeCompare(b)),
            ['net8.0', 'net9.0']
        );

        const net8 = CpmResolver.ResolveVersions(map!, ['Pkg.Net8', 'Pkg.Net9', 'Shared.Library'], ['net8.0']);
        assert.strictEqual(net8.get('Pkg.Net8')![0]!.Version, '8.0.1');
        assert.strictEqual(net8.get('Pkg.Net9'), undefined);
        assert.strictEqual(net8.get('Shared.Library')![0]!.Tfm, '');

        const net9 = CpmResolver.ResolveVersions(map!, ['Pkg.Net9'], ['net9.0']);
        assert.strictEqual(net9.get('Pkg.Net9')![0]!.Version, '9.0.1');
    });

    test('same package ID in two positive groups keeps both version lines', async () => {
        const { propsPath, projectPath } = copyFixture('shared-id-positive-groups');
        const map = await CpmResolver.GetFrameworkPackageMapAsync(projectPath);

        const resolved = CpmResolver.ResolveVersions(
            map!,
            ['Microsoft.Extensions.Http', 'Microsoft.Extensions.Logging'],
            ['net8.0', 'net9.0']
        );

        const http = resolved.get('Microsoft.Extensions.Http')!;
        assert.strictEqual(http.length, 2);
        assert.strictEqual(http.find((r) => r.Tfm === 'net8.0')!.Version, '8.0.0');
        assert.strictEqual(http.find((r) => r.Tfm === 'net9.0')!.Version, '9.0.0');

        const logging = resolved.get('Microsoft.Extensions.Logging')!;
        assert.strictEqual(logging.find((r) => r.Tfm === 'net8.0')!.Version, '8.0.1');
        assert.strictEqual(logging.find((r) => r.Tfm === 'net9.0')!.Version, '9.0.1');

        const net9Condition = map!.conditional.find((e) => e.framework === 'net9.0')!.condition;
        await CpmResolver.UpdateCpmVersionsAsync(propsPath, [
            { packageId: 'Microsoft.Extensions.Http', version: '9.0.2', condition: net9Condition, scope: 'group' },
        ]);

        const updated = await CpmResolver.ParseCpmFileAsync(propsPath);
        assert.strictEqual(
            updated.conditional.find((e) => e.framework === 'net8.0')!.versions.get('Microsoft.Extensions.Http'),
            '8.0.0'
        );
        assert.strictEqual(
            updated.conditional.find((e) => e.framework === 'net9.0')!.versions.get('Microsoft.Extensions.Http'),
            '9.0.2'
        );
    });

    test('negated/positive framework layout resolves net10 and net11 lines', async () => {
        const { propsPath, projectPath } = copyFixture('negated-positive');
        const map = await CpmResolver.GetFrameworkPackageMapAsync(projectPath);
        assert.ok(map);
        assert.strictEqual(map!.unconditional.size, 2);
        assert.deepStrictEqual(
            map!.conditional.map((entry) => entry.framework).sort((a, b) => a.localeCompare(b)),
            ['net11.0', 'not net11.0']
        );

        const ids = [
            'Microsoft.Extensions.Logging',
            'Microsoft.Extensions.Hosting',
            'Microsoft.EntityFrameworkCore.Relational',
            'Npgsql.EntityFrameworkCore.PostgreSQL',
            'Shared.Library',
            'Aspire.Hosting.AppHost',
        ];
        const resolved = CpmResolver.ResolveVersions(map!, ids, ['net10.0', 'net11.0']);

        for (const id of ids.slice(0, 4)) {
            const entries = resolved.get(id)!;
            assert.strictEqual(entries.length, 2, `${id} should have two TFM rows`);
            assert.strictEqual(entries.find((r) => r.Tfm === 'net10.0')!.Version.startsWith('10.'), true);
            assert.strictEqual(entries.find((r) => r.Tfm === 'net11.0')!.Version.startsWith('11.'), true);
        }

        for (const id of ['Shared.Library', 'Aspire.Hosting.AppHost']) {
            const entries = resolved.get(id)!;
            assert.strictEqual(entries.length, 1);
            assert.strictEqual(entries[0]!.Tfm, '');
        }

        const net11 = map!.conditional.find((e) => e.framework === 'net11.0')!;
        await CpmResolver.UpdateCpmVersionsAsync(propsPath, [
            { packageId: 'Microsoft.Extensions.Logging', version: '11.0.0-rc.3', condition: net11.condition, scope: 'group' },
        ]);
        const updated = await CpmResolver.ParseCpmFileAsync(propsPath);
        assert.strictEqual(
            updated.conditional.find((e) => e.framework === 'not net11.0')!.versions.get('Microsoft.Extensions.Logging'),
            '10.0.13'
        );
        assert.strictEqual(
            updated.conditional.find((e) => e.framework === 'net11.0')!.versions.get('Microsoft.Extensions.Logging'),
            '11.0.0-rc.3'
        );
    });

    test('conditional version overrides the unconditional default for its TFM only', async () => {
        const { projectPath } = copyFixture('unconditional-plus-conditional');
        const map = await CpmResolver.GetFrameworkPackageMapAsync(projectPath);

        const resolved = CpmResolver.ResolveVersions(
            map!,
            ['Pkg.Shared', 'Pkg.UnconditionalOnly'],
            ['net10.0', 'net9.0']
        );

        const shared = resolved.get('Pkg.Shared')!;
        assert.strictEqual(shared.find((r) => r.Tfm === 'net10.0')!.Version, '2.0.0');
        const unconditional = shared.find((r) => r.Tfm === '');
        assert.ok(unconditional, 'net9.0 should fall back to the unconditional version');
        assert.strictEqual(unconditional!.Version, '1.0.0');
        assert.strictEqual(unconditional!.Condition, '');

        const onlyUnconditional = resolved.get('Pkg.UnconditionalOnly')!;
        assert.strictEqual(onlyUnconditional.length, 1);
        assert.strictEqual(onlyUnconditional[0]!.Tfm, '');
    });

    test('unconditional scope updates only the unconditional default', async () => {
        const { propsPath, projectPath } = copyFixture('unconditional-plus-conditional');
        assert.ok(await CpmResolver.GetFrameworkPackageMapAsync(projectPath));

        await CpmResolver.UpdateCpmVersionsAsync(propsPath, [
            { packageId: 'Pkg.Shared', version: '1.5.0', scope: 'unconditional' },
        ]);

        const updated = await CpmResolver.ParseCpmFileAsync(propsPath);
        assert.strictEqual(updated.unconditional.get('Pkg.Shared'), '1.5.0');
        assert.strictEqual(
            updated.conditional.find((entry) => entry.framework === 'net10.0')!.versions.get('Pkg.Shared'),
            '2.0.0'
        );
    });

    test('group scope leaves the unconditional default untouched', async () => {
        const { propsPath, projectPath } = copyFixture('unconditional-plus-conditional');
        const map = await CpmResolver.GetFrameworkPackageMapAsync(projectPath);
        const condition = map!.conditional[0]!.condition;

        await CpmResolver.UpdateCpmVersionsAsync(propsPath, [
            { packageId: 'Pkg.Shared', version: '2.5.0', condition, scope: 'group' },
        ]);

        const updated = await CpmResolver.ParseCpmFileAsync(propsPath);
        assert.strictEqual(updated.unconditional.get('Pkg.Shared'), '1.0.0');
        assert.strictEqual(
            updated.conditional.find((entry) => entry.framework === 'net10.0')!.versions.get('Pkg.Shared'),
            '2.5.0'
        );
    });

    test('platform-specific conditions are evaluated with Contains', async () => {
        const { projectPath } = copyFixture('platform-tfms');
        const map = await CpmResolver.GetFrameworkPackageMapAsync(projectPath);

        const windows = CpmResolver.ResolveVersions(
            map!,
            ['Pkg.Core', 'Pkg.Windows', 'Pkg.Android'],
            ['net10.0-windows10.0.26100.0']
        );
        assert.strictEqual(windows.get('Pkg.Core')![0]!.Version, '10.0.0');
        assert.strictEqual(windows.get('Pkg.Windows')![0]!.Version, '1.0.0');
        assert.strictEqual(windows.get('Pkg.Android'), undefined);

        const android = CpmResolver.ResolveVersions(
            map!,
            ['Pkg.Core', 'Pkg.Windows', 'Pkg.Android'],
            ['net10.0-android']
        );
        assert.strictEqual(android.get('Pkg.Core')![0]!.Version, '10.0.0');
        assert.strictEqual(android.get('Pkg.Android')![0]!.Version, '1.0.0');
        assert.strictEqual(android.get('Pkg.Windows'), undefined);
    });

    test('version-first and single-quoted attributes are updated without changing quote style', async () => {
        const { propsPath, projectPath } = copyFixture('attribute-order');
        const map = await CpmResolver.GetFrameworkPackageMapAsync(projectPath);
        assert.strictEqual(map!.unconditional.get('Pkg.VersionFirst'), '1.2.3');
        assert.strictEqual(map!.unconditional.get('Pkg.SingleQuoted'), '2.0.0');

        await CpmResolver.UpdateCpmVersionsAsync(propsPath, [
            { packageId: 'Pkg.VersionFirst', version: '9.9.9' },
            { packageId: 'Pkg.SingleQuoted', version: '8.8.8' },
        ]);

        const content = fs.readFileSync(propsPath, 'utf8');
        assert.ok(content.includes("Include='Pkg.VersionFirst'") || content.includes("Include='pkg.VersionFirst'".replace('pkg', 'Pkg')));
        assert.ok(content.includes("Version='8.8.8'"));

        const updated = await CpmResolver.ParseCpmFileAsync(propsPath);
        assert.strictEqual(updated.unconditional.get('Pkg.VersionFirst'), '9.9.9');
        assert.strictEqual(updated.unconditional.get('Pkg.SingleQuoted'), '8.8.8');
        assert.strictEqual(updated.unconditional.get('Pkg.DoubleQuoted'), '3.0.0');
    });

    test('And/Or conditions are labelled and evaluated; unsupported conditions stay unresolved', async () => {
        const { projectPath } = copyFixture('complex-conditions');
        const map = await CpmResolver.GetFrameworkPackageMapAsync(projectPath);
        assert.strictEqual(map!.conditional.length, 3);

        const labels = map!.conditional.map((entry) => entry.framework);
        assert.ok(labels.includes('not net8.0 and net'));
        assert.ok(labels.includes('net10.0 or net11.0'));
        assert.ok(labels.some((label) => label.includes('VersionGreaterThanOrEquals')));

        assert.strictEqual(
            evaluateCondition("'$(TargetFramework)' != 'net8.0' And $(TargetFramework.StartsWith('net'))", { TargetFramework: 'net10.0' }),
            true
        );
        assert.strictEqual(
            evaluateCondition("'$(TargetFramework)' != 'net8.0' And $(TargetFramework.StartsWith('net'))", { TargetFramework: 'net8.0' }),
            false
        );

        const net10 = CpmResolver.ResolveVersions(map!, ['Pkg.NotNet8', 'Pkg.Modern', 'Pkg.Unsupported'], ['net10.0']);
        assert.strictEqual(net10.get('Pkg.NotNet8')![0]!.Version, '1.0.0');
        assert.strictEqual(net10.get('Pkg.Modern')![0]!.Version, '2.0.0');
        assert.strictEqual(net10.get('Pkg.Unsupported')![0]!.Matched, false);

        const net8 = CpmResolver.ResolveVersions(map!, ['Pkg.NotNet8', 'Pkg.Modern'], ['net8.0']);
        assert.strictEqual(net8.get('Pkg.NotNet8'), undefined, 'condition excludes net8.0');
        assert.strictEqual(net8.get('Pkg.Modern'), undefined, 'net10/net11-only package is not shown for net8.0');
    });

    test('the last matching group in document order wins', async () => {
        const { projectPath } = copyFixture('last-wins');
        const map = await CpmResolver.GetFrameworkPackageMapAsync(projectPath);

        const resolved = CpmResolver.ResolveVersions(map!, ['Pkg.Ordered'], ['net10.0']);
        assert.strictEqual(resolved.get('Pkg.Ordered')![0]!.Version, '2.0.0');
        assert.strictEqual(
            resolved.get('Pkg.Ordered')![0]!.ConditionLabel,
            'net10.0'
        );
    });

    test('label helper distinguishes negation for every fixture condition', () => {
        assert.strictEqual(getConditionLabel("$(TargetFramework.StartsWith('net11.0'))"), 'net11.0');
        assert.strictEqual(getConditionLabel("!$(TargetFramework.StartsWith('net11.0'))"), 'not net11.0');
        assert.strictEqual(getConditionLabel("'$(TargetFramework)' != 'net8.0'"), 'not net8.0');
    });

    test('element-level conditions resolve and update in place', async () => {
        const { propsPath, projectPath } = copyFixture('element-conditions');
        const map = await CpmResolver.GetFrameworkPackageMapAsync(projectPath);

        assert.ok(map);
        assert.strictEqual(map!.conditional.length, 2);
        assert.strictEqual(map!.unconditional.get('Pkg.Element'), '3.0.0');
        assert.strictEqual(map!.unconditional.get('Pkg.Plain'), '4.0.0');

        const resolved = CpmResolver.ResolveVersions(
            map!,
            ['Pkg.Element', 'Pkg.Plain'],
            ['net10.0', 'net11.0', 'net9.0']
        );
        const element = resolved.get('Pkg.Element')!;
        assert.strictEqual(element.find((r) => r.Tfm === 'net10.0')!.Version, '1.0.0');
        assert.strictEqual(element.find((r) => r.Tfm === 'net11.0')!.Version, '2.0.0');
        assert.strictEqual(element.find((r) => r.Tfm === '')!.Version, '3.0.0');
        assert.strictEqual(resolved.get('Pkg.Plain')![0]!.Tfm, '');

        const net10Entry = map!.conditional.find((entry) => entry.framework.includes('net10.0'))!;
        await CpmResolver.UpdateCpmVersionsAsync(propsPath, [
            { packageId: 'Pkg.Element', version: '1.1.0', condition: net10Entry.condition, scope: 'group' },
        ]);

        const updated = await CpmResolver.ParseCpmFileAsync(propsPath);
        assert.strictEqual(
            updated.conditional.find((entry) => entry.framework.includes('net10.0'))!.versions.get('Pkg.Element'),
            '1.1.0'
        );
        assert.strictEqual(
            updated.conditional.find((entry) => entry.framework.includes('net11.0'))!.versions.get('Pkg.Element'),
            '2.0.0'
        );
        assert.strictEqual(updated.unconditional.get('Pkg.Element'), '3.0.0');
    });

    test('repeated conditions use the last document occurrence', async () => {
        const { projectPath } = copyFixture('repeated-condition');
        const map = await CpmResolver.GetFrameworkPackageMapAsync(projectPath);

        const resolved = CpmResolver.ResolveVersions(map!, ['Pkg.Repeat'], ['net10.0']);
        assert.strictEqual(resolved.get('Pkg.Repeat')![0]!.Version, '3.0.0');
    });
});
