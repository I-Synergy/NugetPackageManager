import * as assert from 'assert';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import CpmResolver from '@/host/utilities/cpm-resolver';
import { Logger } from '@/common/logger';

suite('CpmResolver Tests', () => {
    let tmpDir: string;
    let projectDir: string;
    let projectPath: string;

    // Store original Logger methods to restore them after tests
    const originalDebug = Logger.debug;
    const originalInfo = Logger.info;
    const originalError = Logger.error;

    setup(() => {
        // Create a temporary directory structure:
        // tmpDir/
        //   src/
        //     MyProject/
        //       MyProject.csproj
        tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cpm-resolver-test-'));
        projectDir = path.join(tmpDir, 'src', 'MyProject');
        fs.mkdirSync(projectDir, { recursive: true });
        projectPath = path.join(projectDir, 'MyProject.csproj');

        // Default project content
        fs.writeFileSync(projectPath, '<Project><PropertyGroup><ManagePackageVersionsCentrally>true</ManagePackageVersionsCentrally></PropertyGroup></Project>');

        // Silence logger by default to keep test output clean
        Logger.debug = () => {};
        Logger.info = () => {};
        Logger.error = () => {};
    });

    teardown(() => {
        // Restore logger
        Logger.debug = originalDebug;
        Logger.info = originalInfo;
        Logger.error = originalError;

        try {
           fs.rmSync(tmpDir, { recursive: true, force: true });
        } catch(e) {
            console.error(`Failed to cleanup temp dir: ${e}`);
        }
    });

    test('GetPackageVersions returns null when no Directory.Packages.props exists', async () => {
        const versions = await CpmResolver.GetPackageVersionsAsync(projectPath);
        assert.strictEqual(versions, null);
    });

    test('GetPackageVersions returns null when CPM is disabled in Directory.Packages.props', async () => {
        const cpmPath = path.join(tmpDir, 'Directory.Packages.props');
        const cpmContent = `
            <Project>
                <PropertyGroup>
                    <ManagePackageVersionsCentrally>false</ManagePackageVersionsCentrally>
                </PropertyGroup>
            </Project>`;
        fs.writeFileSync(cpmPath, cpmContent);

        const versions = await CpmResolver.GetPackageVersionsAsync(projectPath);
        assert.strictEqual(versions, null);
    });

    test('GetPackageVersions returns null when CPM is enabled in props but disabled in Project', async () => {
        const cpmPath = path.join(tmpDir, 'Directory.Packages.props');
        const cpmContent = `
            <Project>
                <PropertyGroup>
                    <ManagePackageVersionsCentrally>true</ManagePackageVersionsCentrally>
                </PropertyGroup>
            </Project>`;
        fs.writeFileSync(cpmPath, cpmContent);

        // Overwrite project to disable CPM
        const projectContent = `
            <Project>
                <PropertyGroup>
                    <ManagePackageVersionsCentrally>false</ManagePackageVersionsCentrally>
                </PropertyGroup>
            </Project>`;
        fs.writeFileSync(projectPath, projectContent);

        const versions = await CpmResolver.GetPackageVersionsAsync(projectPath);
        assert.strictEqual(versions, null);
    });

    test('GetPackageVersions returns null when CPM property is missing (defaults to false/disabled in this logic)', async () => {
        // The implementation checks if cpmEnabled !== "true" -> return false.
        // So if missing, it's not "true", so false.
        const cpmPath = path.join(tmpDir, 'Directory.Packages.props');
        const cpmContent = `
            <Project>
                <PropertyGroup>
                    <!-- Missing ManagePackageVersionsCentrally -->
                </PropertyGroup>
            </Project>`;
        fs.writeFileSync(cpmPath, cpmContent);

        const versions = await CpmResolver.GetPackageVersionsAsync(projectPath);
        assert.strictEqual(versions, null);
    });

    test('GetPackageVersions parses versions when CPM is enabled', async () => {
        const cpmPath = path.join(tmpDir, 'Directory.Packages.props');
        const cpmContent = `
            <Project>
                <PropertyGroup>
                    <ManagePackageVersionsCentrally>true</ManagePackageVersionsCentrally>
                </PropertyGroup>
                <ItemGroup>
                    <PackageVersion Include="Package.A" Version="1.0.0" />
                    <PackageVersion Include="Package.B" Version="2.0.0" />
                </ItemGroup>
            </Project>`;
        fs.writeFileSync(cpmPath, cpmContent);

        const versions = await CpmResolver.GetPackageVersionsAsync(projectPath);
        assert.notStrictEqual(versions, null);
        assert.strictEqual(versions!.size, 2);
        assert.strictEqual(versions!.get('Package.A'), '1.0.0');
        assert.strictEqual(versions!.get('Package.B'), '2.0.0');
    });

    test('GetPackageVersions finds Directory.Packages.props in parent directory', async () => {
        // Create CPM file in root tmpDir, project is in tmpDir/src/MyProject/
        const cpmPath = path.join(tmpDir, 'Directory.Packages.props');
        const cpmContent = `
            <Project>
                <PropertyGroup>
                    <ManagePackageVersionsCentrally>true</ManagePackageVersionsCentrally>
                </PropertyGroup>
                <ItemGroup>
                    <PackageVersion Include="Root.Package" Version="3.0.0" />
                </ItemGroup>
            </Project>`;
        fs.writeFileSync(cpmPath, cpmContent);

        const versions = await CpmResolver.GetPackageVersionsAsync(projectPath);
        assert.notStrictEqual(versions, null);
        assert.strictEqual(versions!.get('Root.Package'), '3.0.0');
    });

    test('GetPackageVersions reads fresh value on subsequent calls', async () => {
        const cpmPath = path.join(tmpDir, 'Directory.Packages.props');
        const cpmContent1 = `
            <Project>
                <PropertyGroup>
                    <ManagePackageVersionsCentrally>true</ManagePackageVersionsCentrally>
                </PropertyGroup>
                <ItemGroup>
                    <PackageVersion Include="Test.Package" Version="1.0.0" />
                </ItemGroup>
            </Project>`;
        fs.writeFileSync(cpmPath, cpmContent1);

        let versions = await CpmResolver.GetPackageVersionsAsync(projectPath);
        assert.strictEqual(versions!.get('Test.Package'), '1.0.0');

        // Update file
        const cpmContent2 = `
            <Project>
                <PropertyGroup>
                    <ManagePackageVersionsCentrally>true</ManagePackageVersionsCentrally>
                </PropertyGroup>
                <ItemGroup>
                    <PackageVersion Include="Test.Package" Version="2.0.0" />
                </ItemGroup>
            </Project>`;
        fs.writeFileSync(cpmPath, cpmContent2);

        // Second call should read the updated value from disk
        versions = await CpmResolver.GetPackageVersionsAsync(projectPath);
        assert.strictEqual(versions!.get('Test.Package'), '2.0.0');
    });

    test('GetPackageVersions returns null for malformed CPM file', async () => {
        const cpmPath = path.join(tmpDir, 'Directory.Packages.props');
        // Malformed XML (missing closing tag).
        // xmldom fails to parse the structure correctly, so enable check returns false.
        const cpmContent = `
            <Project>
                <PropertyGroup>
                    <ManagePackageVersionsCentrally>true</ManagePackageVersionsCentrally>
                </PropertyGroup>
                <ItemGroup>
                    <PackageVersion Include="Test.Package" Version="1.0.0" />
            `;
        fs.writeFileSync(cpmPath, cpmContent);

        let errorLogged = false;
        Logger.error = () => { errorLogged = true; };

        const versions = await CpmResolver.GetPackageVersionsAsync(projectPath);

        // We expect null because IsCentralPackageManagementEnabled returns false due to parsing failure
        assert.strictEqual(versions, null);

        // We expect no error logged because xmldom does not throw exception, it just returns a document that fails xpath queries
        assert.strictEqual(errorLogged, false);
    });

    test('ParsePackageVersions handles items with missing attributes', async () => {
        const cpmPath = path.join(tmpDir, 'Directory.Packages.props');
        const cpmContent = `
            <Project>
                <PropertyGroup>
                    <ManagePackageVersionsCentrally>true</ManagePackageVersionsCentrally>
                </PropertyGroup>
                <ItemGroup>
                    <PackageVersion Include="Valid.Package" Version="1.0.0" />
                    <PackageVersion Include="Missing.Version" />
                    <PackageVersion Version="2.0.0" />
                </ItemGroup>
            </Project>`;
        fs.writeFileSync(cpmPath, cpmContent);

        const versions = await CpmResolver.GetPackageVersionsAsync(projectPath);
        assert.notStrictEqual(versions, null);
        assert.strictEqual(versions!.size, 1);
        assert.strictEqual(versions!.get('Valid.Package'), '1.0.0');
        assert.strictEqual(versions!.has('Missing.Version'), false);
    });

    test('IsCentralPackageManagementEnabled returns false if project file cannot be read', async () => {
        const cpmPath = path.join(tmpDir, 'Directory.Packages.props');
        const cpmContent = `
            <Project>
                <PropertyGroup>
                    <ManagePackageVersionsCentrally>true</ManagePackageVersionsCentrally>
                </PropertyGroup>
            </Project>`;
        fs.writeFileSync(cpmPath, cpmContent);

        // Delete project file to trigger read error
        fs.unlinkSync(projectPath);

        let errorLogged = false;
        Logger.error = () => { errorLogged = true; };

        const versions = await CpmResolver.GetPackageVersionsAsync(projectPath);
        assert.strictEqual(versions, null);
        assert.strictEqual(errorLogged, true);
    });

    // UpdatePackageVersion tests

    test('UpdatePackageVersion updates version with Include-first attribute ordering', async () => {
        const cpmPath = path.join(tmpDir, 'Directory.Packages.props');
        const cpmContent = `<Project>
  <ItemGroup>
    <PackageVersion Include="My.Package" Version="1.0.0" />
  </ItemGroup>
</Project>`;
        fs.writeFileSync(cpmPath, cpmContent);

        await CpmResolver.UpdatePackageVersionAsync(projectPath, 'My.Package', '2.0.0');

        const updated = fs.readFileSync(cpmPath, 'utf8');
        assert.ok(updated.includes('Version="2.0.0"'), 'Version should be updated to 2.0.0');
        assert.ok(!updated.includes('Version="1.0.0"'), 'Old version should not remain');
        assert.ok(updated.includes('Include="My.Package"'), 'Include attribute should remain unchanged');
    });

    test('UpdatePackageVersion updates version with Version-first attribute ordering', async () => {
        const cpmPath = path.join(tmpDir, 'Directory.Packages.props');
        const cpmContent = `<Project>
  <ItemGroup>
    <PackageVersion Version="1.0.0" Include="My.Package" />
  </ItemGroup>
</Project>`;
        fs.writeFileSync(cpmPath, cpmContent);

        await CpmResolver.UpdatePackageVersionAsync(projectPath, 'My.Package', '3.1.0');

        const updated = fs.readFileSync(cpmPath, 'utf8');
        assert.ok(updated.includes('Version="3.1.0"'), 'Version should be updated to 3.1.0');
        assert.ok(!updated.includes('Version="1.0.0"'), 'Old version should not remain');
        assert.ok(updated.includes('Include="My.Package"'), 'Include attribute should remain unchanged');
    });

    test('UpdatePackageVersion throws when package is not found in the file', async () => {
        const cpmPath = path.join(tmpDir, 'Directory.Packages.props');
        const cpmContent = `<Project>
  <ItemGroup>
    <PackageVersion Include="Other.Package" Version="1.0.0" />
  </ItemGroup>
</Project>`;
        fs.writeFileSync(cpmPath, cpmContent);

        await assert.rejects(
            () => CpmResolver.UpdatePackageVersionAsync(projectPath, 'Missing.Package', '2.0.0'),
            (err: Error) => {
                assert.ok(err.message.includes('Missing.Package'), 'Error message should mention the package id');
                return true;
            }
        );
    });

    test('UpdatePackageVersion throws when Directory.Packages.props is not found', async () => {
        // No Directory.Packages.props file is created — FindDirectoryPackagesPropsFile returns null
        await assert.rejects(
            () => CpmResolver.UpdatePackageVersionAsync(projectPath, 'My.Package', '2.0.0'),
            (err: Error) => {
                assert.ok(err.message.includes('Directory.Packages.props'), 'Error message should mention the missing file');
                return true;
            }
        );
    });

    test('UpdatePackageVersion only updates the targeted package and leaves others unchanged', async () => {
        const cpmPath = path.join(tmpDir, 'Directory.Packages.props');
        const cpmContent = `<Project>
  <ItemGroup>
    <PackageVersion Include="Package.A" Version="1.0.0" />
    <PackageVersion Include="Package.B" Version="2.0.0" />
  </ItemGroup>
</Project>`;
        fs.writeFileSync(cpmPath, cpmContent);

        await CpmResolver.UpdatePackageVersionAsync(projectPath, 'Package.A', '1.5.0');

        const updated = fs.readFileSync(cpmPath, 'utf8');
        assert.ok(updated.includes('Include="Package.A"'), 'Package.A Include attribute should remain');
        assert.ok(updated.includes('Version="1.5.0"'), 'Package.A version should be updated');
        assert.ok(updated.includes('Include="Package.B"'), 'Package.B Include attribute should remain');
        assert.ok(updated.includes('Version="2.0.0"'), 'Package.B version should be unchanged');
    });

    // ─── GetFrameworkPackageMapAsync ────────────────────────────────────────────

    test('GetFrameworkPackageMapAsync returns null when no Directory.Packages.props exists', async () => {
        const result = await CpmResolver.GetFrameworkPackageMapAsync(projectPath);
        assert.strictEqual(result, null);
    });

    test('GetFrameworkPackageMapAsync returns null when CPM is disabled', async () => {
        const cpmPath = path.join(tmpDir, 'Directory.Packages.props');
        fs.writeFileSync(cpmPath, `<Project>
  <PropertyGroup><ManagePackageVersionsCentrally>false</ManagePackageVersionsCentrally></PropertyGroup>
  <ItemGroup>
    <PackageVersion Include="Pkg.A" Version="1.0.0" />
  </ItemGroup>
</Project>`);
        const result = await CpmResolver.GetFrameworkPackageMapAsync(projectPath);
        assert.strictEqual(result, null);
    });

    test('GetFrameworkPackageMapAsync returns only unconditional entries when no Condition attributes', async () => {
        const cpmPath = path.join(tmpDir, 'Directory.Packages.props');
        fs.writeFileSync(cpmPath, `<Project>
  <PropertyGroup><ManagePackageVersionsCentrally>true</ManagePackageVersionsCentrally></PropertyGroup>
  <ItemGroup>
    <PackageVersion Include="Pkg.A" Version="1.0.0" />
    <PackageVersion Include="Pkg.B" Version="2.0.0" />
  </ItemGroup>
</Project>`);
        const result = await CpmResolver.GetFrameworkPackageMapAsync(projectPath);
        assert.ok(result !== null);
        assert.strictEqual(result.unconditional.size, 2);
        assert.strictEqual(result.conditional.length, 0);
        assert.strictEqual(result.unconditional.get('Pkg.A'), '1.0.0');
        assert.strictEqual(result.unconditional.get('Pkg.B'), '2.0.0');
    });

    test('GetFrameworkPackageMapAsync separates conditional and unconditional entries', async () => {
        const cpmPath = path.join(tmpDir, 'Directory.Packages.props');
        fs.writeFileSync(cpmPath, `<Project>
  <PropertyGroup><ManagePackageVersionsCentrally>true</ManagePackageVersionsCentrally></PropertyGroup>
  <ItemGroup>
    <PackageVersion Include="Pkg.Common" Version="1.0.0" />
  </ItemGroup>
  <ItemGroup Condition="$(TargetFramework.StartsWith('net8.0'))">
    <PackageVersion Include="Pkg.Net8" Version="8.0.0" />
  </ItemGroup>
  <ItemGroup Condition="$(TargetFramework.StartsWith('net9.0'))">
    <PackageVersion Include="Pkg.Net9" Version="9.0.0" />
  </ItemGroup>
</Project>`);
        const result = await CpmResolver.GetFrameworkPackageMapAsync(projectPath);
        assert.ok(result !== null);
        assert.strictEqual(result.unconditional.size, 1);
        assert.strictEqual(result.unconditional.get('Pkg.Common'), '1.0.0');
        assert.strictEqual(result.conditional.length, 2);

        const net8 = result.conditional.find((e) => e.framework === 'net8.0');
        assert.ok(net8, 'net8.0 entry should exist');
        assert.strictEqual(net8!.versions.get('Pkg.Net8'), '8.0.0');

        const net9 = result.conditional.find((e) => e.framework === 'net9.0');
        assert.ok(net9, 'net9.0 entry should exist');
        assert.strictEqual(net9!.versions.get('Pkg.Net9'), '9.0.0');
    });

    test('GetFrameworkPackageMapAsync parses framework label from condition', async () => {
        const cpmPath = path.join(tmpDir, 'Directory.Packages.props');
        fs.writeFileSync(cpmPath, `<Project>
  <PropertyGroup><ManagePackageVersionsCentrally>true</ManagePackageVersionsCentrally></PropertyGroup>
  <ItemGroup Condition="$(TargetFramework.StartsWith('netstandard2.0'))">
    <PackageVersion Include="Pkg.Std" Version="3.0.0" />
  </ItemGroup>
</Project>`);
        const result = await CpmResolver.GetFrameworkPackageMapAsync(projectPath);
        assert.ok(result !== null);
        assert.strictEqual(result.conditional.length, 1);
        assert.strictEqual(result.conditional[0]!.framework, 'netstandard2.0');
    });

    // ─── UpdatePackageVersionAsync with condition ────────────────────────────────

    test('UpdatePackageVersion with condition updates only within matching ItemGroup', async () => {
        const condition = "$(TargetFramework.StartsWith('net8.0'))";
        const cpmPath = path.join(tmpDir, 'Directory.Packages.props');
        fs.writeFileSync(cpmPath, `<Project>
  <PropertyGroup><ManagePackageVersionsCentrally>true</ManagePackageVersionsCentrally></PropertyGroup>
  <ItemGroup>
    <PackageVersion Include="Pkg.Common" Version="1.0.0" />
  </ItemGroup>
  <ItemGroup Condition="${condition}">
    <PackageVersion Include="Pkg.Net8" Version="8.0.0" />
  </ItemGroup>
</Project>`);
        await CpmResolver.UpdatePackageVersionAsync(projectPath, 'Pkg.Net8', '8.1.0', condition);

        const updated = fs.readFileSync(cpmPath, 'utf8');
        assert.ok(updated.includes('Version="8.1.0"'), 'Pkg.Net8 version should be updated');
        assert.ok(updated.includes('Version="1.0.0"'), 'Pkg.Common version should be unchanged');
    });

    test('UpdatePackageVersion with condition does not touch same package in unconditional group', async () => {
        const condition = "$(TargetFramework.StartsWith('net8.0'))";
        const cpmPath = path.join(tmpDir, 'Directory.Packages.props');
        fs.writeFileSync(cpmPath, `<Project>
  <PropertyGroup><ManagePackageVersionsCentrally>true</ManagePackageVersionsCentrally></PropertyGroup>
  <ItemGroup>
    <PackageVersion Include="Pkg.A" Version="1.0.0" />
  </ItemGroup>
  <ItemGroup Condition="${condition}">
    <PackageVersion Include="Pkg.A" Version="8.0.0" />
  </ItemGroup>
</Project>`);
        await CpmResolver.UpdatePackageVersionAsync(projectPath, 'Pkg.A', '8.1.0', condition);

        const updated = fs.readFileSync(cpmPath, 'utf8');
        // The unconditional version should remain 1.0.0
        assert.ok(updated.includes('Version="1.0.0"'), 'unconditional Pkg.A version should be unchanged');
        assert.ok(updated.includes('Version="8.1.0"'), 'conditional Pkg.A version should be updated');
    });

    test('UpdatePackageVersion with condition throws when package not in that ItemGroup', async () => {
        const condition = "$(TargetFramework.StartsWith('net8.0'))";
        const cpmPath = path.join(tmpDir, 'Directory.Packages.props');
        fs.writeFileSync(cpmPath, `<Project>
  <PropertyGroup><ManagePackageVersionsCentrally>true</ManagePackageVersionsCentrally></PropertyGroup>
  <ItemGroup Condition="${condition}">
    <PackageVersion Include="Pkg.Net8" Version="8.0.0" />
  </ItemGroup>
</Project>`);
        await assert.rejects(
            async () => await CpmResolver.UpdatePackageVersionAsync(projectPath, 'Pkg.NotThere', '1.0.0', condition),
            (err: Error) => {
                assert.ok(err.message.includes('Pkg.NotThere'), 'Error should mention the package');
                return true;
            }
        );
    });

    test('UpdatePackageVersion with condition throws when ItemGroup not found', async () => {
        const cpmPath = path.join(tmpDir, 'Directory.Packages.props');
        fs.writeFileSync(cpmPath, `<Project>
  <PropertyGroup><ManagePackageVersionsCentrally>true</ManagePackageVersionsCentrally></PropertyGroup>
  <ItemGroup>
    <PackageVersion Include="Pkg.A" Version="1.0.0" />
  </ItemGroup>
</Project>`);
        const condition = "$(TargetFramework.StartsWith('net8.0'))";
        await assert.rejects(
            async () => await CpmResolver.UpdatePackageVersionAsync(projectPath, 'Pkg.A', '2.0.0', condition),
            (err: Error) => {
                assert.ok(err.message.includes('ItemGroup'), 'Error should mention ItemGroup');
                return true;
            }
        );
    });

    // ─── I-Synergy Framework grouped layout ─────────────────────────────────────

    const CONDITION_LEGACY = "!$(TargetFramework.StartsWith('net11.0'))";
    const CONDITION_MODERN = "$(TargetFramework.StartsWith('net11.0'))";

    const FRAMEWORK_PROPS = `<Project>
  <PropertyGroup>
    <ManagePackageVersionsCentrally>true</ManagePackageVersionsCentrally>
  </PropertyGroup>
  <!-- Third-party and cross-framework packages (unconditional) -->
  <ItemGroup>
    <PackageVersion Include="Shared.Library" Version="1.0.0" />
  </ItemGroup>
  <!-- Framework-aligned packages for net10.0 -->
  <ItemGroup Condition="${CONDITION_LEGACY}">
    <PackageVersion Include="Microsoft.Extensions.Logging" Version="10.0.13" />
    <PackageVersion Include="Microsoft.Extensions.Hosting" Version="10.0.13" />
    <PackageVersion Include="Microsoft.Maui.Controls" Version="10.0.120" />
  </ItemGroup>
  <!-- Framework-aligned packages for net11.0 -->
  <ItemGroup Condition="${CONDITION_MODERN}">
    <PackageVersion Include="Microsoft.Extensions.Logging" Version="11.0.0-rc.2.26504.105" />
    <PackageVersion Include="Microsoft.Extensions.Hosting" Version="11.0.0-rc.2.26504.105" />
    <PackageVersion Include="Microsoft.Maui.Controls" Version="11.0.0-rc.2.26505.5" />
  </ItemGroup>
</Project>`;

    function writeFrameworkProps(): string {
        const cpmPath = path.join(tmpDir, 'Directory.Packages.props');
        fs.writeFileSync(cpmPath, FRAMEWORK_PROPS);
        return cpmPath;
    }

    test('parses negated and positive groups with distinct labels', async () => {
        writeFrameworkProps();

        const map = await CpmResolver.GetFrameworkPackageMapAsync(projectPath);
        assert.ok(map !== null);
        assert.strictEqual(map!.unconditional.size, 1);
        assert.strictEqual(map!.conditional.length, 2);
        assert.strictEqual(map!.hasConditionalGroups, true);

        const legacy = map!.conditional.find((e) => e.condition === CONDITION_LEGACY);
        const modern = map!.conditional.find((e) => e.condition === CONDITION_MODERN);
        assert.ok(legacy);
        assert.ok(modern);
        assert.strictEqual(legacy!.framework, 'not net11.0');
        assert.strictEqual(modern!.framework, 'net11.0');
        assert.strictEqual(legacy!.versions.get('Microsoft.Extensions.Logging'), '10.0.13');
        assert.strictEqual(modern!.versions.get('Microsoft.Extensions.Logging'), '11.0.0-rc.2.26504.105');
    });

    test('resolves each TFM to its own version line', async () => {
        writeFrameworkProps();
        const map = await CpmResolver.GetFrameworkPackageMapAsync(projectPath);

        const resolutions = CpmResolver.ResolveVersions(
            map!,
            ['Microsoft.Extensions.Logging', 'Shared.Library'],
            ['net10.0', 'net11.0']
        );

        const logging = resolutions.get('Microsoft.Extensions.Logging')!;
        assert.strictEqual(logging.length, 2);
        assert.strictEqual(logging.find((r) => r.Tfm === 'net10.0')!.Version, '10.0.13');
        assert.strictEqual(logging.find((r) => r.Tfm === 'net11.0')!.Version, '11.0.0-rc.2.26504.105');
        assert.ok(logging.every((r) => r.Matched));

        const shared = resolutions.get('Shared.Library')!;
        assert.strictEqual(shared.length, 1, 'unconditional package should produce one shared row');
        assert.strictEqual(shared[0]!.Tfm, '');
        assert.strictEqual(shared[0]!.Version, '1.0.0');
    });

    test('resolves platform-specific TFMs through StartsWith', async () => {
        writeFrameworkProps();
        const map = await CpmResolver.GetFrameworkPackageMapAsync(projectPath);

        const resolutions = CpmResolver.ResolveVersions(
            map!,
            ['Microsoft.Extensions.Logging'],
            ['net10.0-windows10.0.26100.0']
        );

        assert.strictEqual(resolutions.get('Microsoft.Extensions.Logging')![0]!.Version, '10.0.13');
    });

    test('falls back to every group when no TFMs could be evaluated', async () => {
        writeFrameworkProps();
        const map = await CpmResolver.GetFrameworkPackageMapAsync(projectPath);

        const resolutions = CpmResolver.ResolveVersions(map!, ['Microsoft.Extensions.Logging'], []);
        const logging = resolutions.get('Microsoft.Extensions.Logging')!;
        assert.strictEqual(logging.length, 2);
        assert.deepStrictEqual(
            logging.map((r) => r.ConditionLabel).sort((a, b) => a.localeCompare(b)),
            ['net11.0', 'not net11.0']
        );
    });

    test('negated condition also matches non-net11 TFMs', async () => {
        writeFrameworkProps();
        const map = await CpmResolver.GetFrameworkPackageMapAsync(projectPath);

        const resolutions = CpmResolver.ResolveVersions(
            map!,
            ['Microsoft.Extensions.Logging'],
            ['netstandard2.0']
        );
        const logging = resolutions.get('Microsoft.Extensions.Logging')!;
        assert.strictEqual(logging.length, 1);
        assert.strictEqual(logging[0]!.Matched, true);
        assert.strictEqual(logging[0]!.Version, '10.0.13');
        assert.strictEqual(logging[0]!.Tfm, 'netstandard2.0');
    });

    test('does not surface a package whose positive condition matches none of the project TFMs', async () => {
        const cpmPath = path.join(tmpDir, 'Directory.Packages.props');
        fs.writeFileSync(cpmPath, `<Project>
  <PropertyGroup><ManagePackageVersionsCentrally>true</ManagePackageVersionsCentrally></PropertyGroup>
  <ItemGroup Condition="$(TargetFramework.StartsWith('net8.0'))">
    <PackageVersion Include="Pkg.Net8" Version="8.0.0" />
  </ItemGroup>
</Project>`);

        const map = await CpmResolver.GetFrameworkPackageMapAsync(projectPath);
        const resolutions = CpmResolver.ResolveVersions(map!, ['Pkg.Net8'], ['net10.0']);
        assert.strictEqual(resolutions.get('Pkg.Net8'), undefined);
    });

    test('flags a package when its condition cannot be evaluated', async () => {
        const cpmPath = path.join(tmpDir, 'Directory.Packages.props');
        fs.writeFileSync(cpmPath, `<Project>
  <PropertyGroup><ManagePackageVersionsCentrally>true</ManagePackageVersionsCentrally></PropertyGroup>
  <ItemGroup Condition="$([MSBuild]::VersionGreaterThanOrEquals('$(TargetFrameworkVersion)', 'v11.0'))">
    <PackageVersion Include="Pkg.Unsupported" Version="3.0.0" />
  </ItemGroup>
</Project>`);

        const map = await CpmResolver.GetFrameworkPackageMapAsync(projectPath);
        const resolved = CpmResolver.ResolveVersions(map!, ['Pkg.Unsupported'], ['net10.0']);
        const entry = resolved.get('Pkg.Unsupported')!;
        assert.strictEqual(entry.length, 1);
        assert.strictEqual(entry[0]!.Matched, false);
        assert.strictEqual(entry[0]!.Version, '3.0.0');
    });

    test('updates only the net11.0 group when its condition is supplied', async () => {
        const cpmPath = writeFrameworkProps();

        await CpmResolver.UpdatePackageVersionAsync(
            projectPath,
            'Microsoft.Extensions.Logging',
            '11.0.0-rc.3',
            CONDITION_MODERN
        );

        const updated = fs.readFileSync(cpmPath, 'utf8');
        assert.ok(updated.includes('Version="10.0.13"'), 'net10 line must be unchanged');
        assert.ok(
            updated.includes('Include="Microsoft.Extensions.Logging" Version="11.0.0-rc.3"'),
            'net11 logging line must be updated'
        );
        assert.ok(
            updated.includes('Include="Microsoft.Extensions.Hosting" Version="11.0.0-rc.2.26504.105"'),
            'other net11 packages must be unchanged'
        );
    });

    test('updates only the negated net10.0 group when its condition is supplied', async () => {
        const cpmPath = writeFrameworkProps();

        await CpmResolver.UpdatePackageVersionAsync(
            projectPath,
            'Microsoft.Extensions.Logging',
            '10.0.14',
            CONDITION_LEGACY
        );

        const updated = fs.readFileSync(cpmPath, 'utf8');
        assert.ok(updated.includes('Version="10.0.14"'), 'net10 line must be updated');
        assert.ok(updated.includes('Version="11.0.0-rc.2.26504.105"'), 'net11 line must be unchanged');
    });

    test('applies changes for both groups in one write', async () => {
        const cpmPath = writeFrameworkProps();

        await CpmResolver.UpdateCpmVersionsAsync(cpmPath, [
            { packageId: 'Microsoft.Extensions.Logging', version: '10.0.14', condition: CONDITION_LEGACY, scope: 'group' },
            { packageId: 'Microsoft.Extensions.Logging', version: '11.0.0-rc.3', condition: CONDITION_MODERN, scope: 'group' },
        ]);

        const map = await CpmResolver.ParseCpmFileAsync(cpmPath);
        const legacy = map.conditional.find((e) => e.condition === CONDITION_LEGACY)!;
        const modern = map.conditional.find((e) => e.condition === CONDITION_MODERN)!;
        assert.strictEqual(legacy.versions.get('Microsoft.Extensions.Logging'), '10.0.14');
        assert.strictEqual(modern.versions.get('Microsoft.Extensions.Logging'), '11.0.0-rc.3');
    });

    test('scope "all" updates every group and preserves other packages', async () => {
        const cpmPath = writeFrameworkProps();

        await CpmResolver.UpdateCpmVersionsAsync(cpmPath, [
            { packageId: 'Microsoft.Extensions.Hosting', version: '12.0.0', scope: 'all' },
        ]);

        const map = await CpmResolver.ParseCpmFileAsync(cpmPath);
        for (const entry of map.conditional) {
            assert.strictEqual(entry.versions.get('Microsoft.Extensions.Hosting'), '12.0.0');
        }
        assert.strictEqual(map.unconditional.get('Shared.Library'), '1.0.0');
    });

    test('verification failure leaves the file untouched', async () => {
        const cpmPath = writeFrameworkProps();
        const before = fs.readFileSync(cpmPath, 'utf8');

        await assert.rejects(
            async () => await CpmResolver.UpdateCpmVersionsAsync(cpmPath, [
                { packageId: 'Microsoft.Extensions.Logging', version: '10.0.14', condition: CONDITION_LEGACY, scope: 'group' },
                { packageId: 'Missing.Package', version: '1.0.0', condition: CONDITION_MODERN, scope: 'group' },
            ]),
            (err: Error) => err.message.includes('Missing.Package')
        );

        assert.strictEqual(fs.readFileSync(cpmPath, 'utf8'), before, 'no partial write should occur');
    });

    test('removes a package version from every group', async () => {
        const cpmPath = writeFrameworkProps();

        const removed = await CpmResolver.RemovePackageVersionAsync(
            cpmPath,
            'Microsoft.Extensions.Logging'
        );

        assert.strictEqual(removed, true);
        const updated = fs.readFileSync(cpmPath, 'utf8');
        assert.ok(!updated.includes('Microsoft.Extensions.Logging'));
        const map = await CpmResolver.ParseCpmFileAsync(cpmPath);
        assert.strictEqual(CpmResolver.HasPackage(map, 'Microsoft.Extensions.Logging'), false);
    });

    test('package IDs are matched case-insensitively', async () => {
        const cpmPath = writeFrameworkProps();

        await CpmResolver.UpdatePackageVersionAsync(
            projectPath,
            'microsoft.extensions.logging',
            '10.0.14',
            CONDITION_LEGACY
        );

        const updated = fs.readFileSync(cpmPath, 'utf8');
        assert.ok(updated.includes('Version="10.0.14"'));
    });
});
