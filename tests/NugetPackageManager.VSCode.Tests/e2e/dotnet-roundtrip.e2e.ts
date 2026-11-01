import * as assert from 'assert';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { repositoryPath } from '../test-paths';
import { createHostAPI } from '@/host/host-api';
import coreProcess from '@/host/nuget/core-process';
import type { Result } from '@/common/rpc/result';
import type { UpdateProjectResponse } from '@/common/rpc/types';

/**
 * End-to-end round trip with the real sidecar and the real `dotnet` CLI.
 *
 * No core stub, no task-executor stub: `dotnet add package` writes the project file and restores
 * from the configured feeds (nuget.org through the machine config). The fixture project lives
 * inside the workspace so the host's path containment accepts it.
 *
 * Requires `dist/core` (`npm run build:core`) and `dotnet` on PATH.
 */

const fixtureRoot = repositoryPath('tests', 'NugetPackageManager.VSCode.Tests', 'e2e-workspace');
coreProcess.Configure(repositoryPath());

suite('E2E: dotnet round trip', () => {
    const api = createHostAPI();
    let projectDir: string;
    let projectPath: string;

    function writeProject(content = '<Project Sdk="Microsoft.NET.Sdk"><PropertyGroup><TargetFramework>net8.0</TargetFramework></PropertyGroup></Project>'): void {
        fs.writeFileSync(projectPath, content);
    }

    function readProject(): string {
        return fs.readFileSync(projectPath, 'utf8');
    }

    function unwrap<T>(result: Result<T>): T {
        assert.ok(result.ok, result.ok ? 'unexpected failure' : result.error);
        return result.value;
    }

    setup(() => {
        fs.mkdirSync(fixtureRoot, { recursive: true });
        projectDir = fs.mkdtempSync(path.join(fixtureRoot, 'roundtrip-'));
        projectPath = path.join(projectDir, 'App.csproj');
        // The fixture lives inside this repository, which enables CPM in Directory.Packages.props.
        // A nearer file opts out, exactly like tests/NugetPackageManager.TestUtilities/Fixtures.
        fs.writeFileSync(path.join(projectDir, 'Directory.Packages.props'), `
            <Project>
              <PropertyGroup>
                <ManagePackageVersionsCentrally>false</ManagePackageVersionsCentrally>
              </PropertyGroup>
            </Project>
            `.trim());
        writeProject();
    });

    teardown(() => {
        fs.rmSync(projectDir, { recursive: true, force: true });
    });

    test('installs, updates and uninstalls a package through dotnet', async () => {
        const install: Result<UpdateProjectResponse> = await api.updateProjectAsync({
            ProjectPath: projectPath,
            PackageId: 'Newtonsoft.Json',
            Version: '13.0.1',
            Type: 'INSTALL',
        });
        const installed = unwrap(install);
        // The fixture opts out of CPM. If that ever stops holding, the CPM writer edits the
        // nearest props file — which would be this repository's own Directory.Packages.props.
        assert.strictEqual(installed.IsCpmEnabled, false, 'the fixture must stay outside CPM');
        assert.match(readProject(), /Newtonsoft\.Json/, 'the reference should be written to the project file');
        assert.match(readProject(), /13\.0\.1/, 'the requested version should be written');

        const update = await api.updateProjectAsync({
            ProjectPath: projectPath,
            PackageId: 'Newtonsoft.Json',
            Version: '13.0.3',
            Type: 'UPDATE',
        });
        const updated = unwrap(update);
        assert.match(readProject(), /13\.0\.3/);
        assert.ok(
            updated.Project.Packages.some((pkg) => pkg.Id === 'Newtonsoft.Json'),
            'the parsed project should report the package after the restore');

        const uninstall = await api.updateProjectAsync({
            ProjectPath: projectPath,
            PackageId: 'Newtonsoft.Json',
            Type: 'UNINSTALL',
        });
        unwrap(uninstall);
        assert.doesNotMatch(readProject(), /Newtonsoft\.Json/);
    });

    test('writes a CPM version into Directory.Packages.props', async () => {
        fs.writeFileSync(path.join(projectDir, 'Directory.Packages.props'), `
            <Project>
              <PropertyGroup>
                <ManagePackageVersionsCentrally>true</ManagePackageVersionsCentrally>
              </PropertyGroup>
              <ItemGroup>
                <PackageVersion Include="Newtonsoft.Json" Version="13.0.1" />
              </ItemGroup>
            </Project>
            `.trim());
        writeProject(`
            <Project Sdk="Microsoft.NET.Sdk">
              <PropertyGroup>
                <TargetFramework>net8.0</TargetFramework>
              </PropertyGroup>
              <ItemGroup>
                <PackageReference Include="Newtonsoft.Json" />
              </ItemGroup>
            </Project>
            `.trim());

        const result = await api.updateProjectAsync({
            ProjectPath: projectPath,
            PackageId: 'Newtonsoft.Json',
            Version: '13.0.3',
            Type: 'UPDATE',
        });
        unwrap(result);

        const props = fs.readFileSync(path.join(projectDir, 'Directory.Packages.props'), 'utf8');
        assert.match(props, /Newtonsoft\.Json[^>]*13\.0\.3/, 'the central version should be updated in place');
        assert.doesNotMatch(readProject(), /13\.0\.3/, 'the csproj must not pin the version under CPM');
    });

    test('reports the package as outdated against the configured feed', async () => {
        unwrap(await api.updateProjectAsync({
            ProjectPath: projectPath,
            PackageId: 'Newtonsoft.Json',
            Version: '12.0.3',
            Type: 'INSTALL',
        }));

        const outdated = unwrap(await api.getOutdatedPackagesAsync({
            Prerelease: false,
            ProjectPaths: [projectPath],
        }));

        const row = outdated.Packages.find((pkg) => pkg.Id === 'Newtonsoft.Json');
        assert.ok(row, 'Newtonsoft.Json should be listed as outdated');
        assert.strictEqual(row.InstalledVersion, '12.0.3');
        assert.notStrictEqual(row.LatestVersion, '12.0.3');
    });
});
