import * as assert from 'assert';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import JSZip from 'jszip';
import LocalNuGetFeed from '@/host/nuget/local-feed';

suite('LocalNuGetFeed', () => {
    let tempDir: string;

    setup(() => {
        tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'local-feed-test-'));
    });

    teardown(() => {
        fs.rmSync(tempDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    });

    async function writePackageAsync(id: string, version: string): Promise<string> {
        const zip = new JSZip();
        zip.file(`${id}.nuspec`, `<?xml version="1.0" encoding="utf-8"?>
<package>
  <metadata>
    <id>${id}</id>
    <version>${version}</version>
    <authors>Local Author</authors>
    <description>Local test package</description>
    <tags>local test</tags>
    <dependencies>
      <group targetFramework="net8.0">
        <dependency id="Dependency.One" version="[1.0.0, 2.0.0)" />
      </group>
    </dependencies>
  </metadata>
</package>`);
        const target = path.join(tempDir, `${id}.${version}.nupkg`);
        fs.writeFileSync(target, await zip.generateAsync({ type: 'nodebuffer' }));
        return target;
    }

    test('lists packages and exposes their versions', async () => {
        await writePackageAsync('Local.Test', '1.0.0');
        await writePackageAsync('Local.Test', '2.0.0-beta.1');

        const feed = new LocalNuGetFeed(tempDir);
        const stable = await feed.GetPackagesAsync('local', false, 0, 10);
        assert.strictEqual(stable.length, 1);
        assert.strictEqual(stable[0]!.Version, '1.0.0');

        const all = await feed.GetPackagesAsync('local', true, 0, 10);
        assert.strictEqual(all.length, 1);
        assert.deepStrictEqual(all[0]!.Versions.map((v) => v.Version), ['1.0.0', '2.0.0-beta.1']);
    });

    test('exposes a null download count for every version', async () => {
        await writePackageAsync('Local.Downloads', '1.0.0');
        await writePackageAsync('Local.Downloads', '2.0.0');

        const feed = new LocalNuGetFeed(tempDir);
        const packages = await feed.GetPackagesAsync('local', true, 0, 10);

        assert.strictEqual(packages.length, 1);
        // A folder feed publishes no download data: null rather than 0 or undefined.
        assert.deepStrictEqual(
            packages[0]!.Versions.map((version) => version.Downloads),
            [null, null]
        );
    });

    test('reads nuspec dependencies from a package version', async () => {
        await writePackageAsync('Local.Dependency', '1.2.3');
        const feed = new LocalNuGetFeed(tempDir);
        await feed.GetPackagesAsync('Local.Dependency', true, 0, 10);
        const details = await feed.GetPackageDetailsAsync('Local.Dependency', '1.2.3');

        assert.deepStrictEqual(details.dependencies.frameworks['net8.0'], [{
            package: 'Dependency.One',
            versionRange: '[1.0.0, 2.0.0)',
        }]);
    });
});
