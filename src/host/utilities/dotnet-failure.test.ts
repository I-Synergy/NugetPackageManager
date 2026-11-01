import * as assert from 'assert';
import { ClassifyDotnetFailure, ToFailureInfo } from './dotnet-failure';

const WORKLOAD_CONFLICT_OUTPUT = [
    'C:\\Program Files\\dotnet\\sdk\\11.0.100-rc.3.26522.148\\Sdks\\Microsoft.NET.Sdk\\targets\\Microsoft.NET.Sdk.ImportWorkloads.props(14,38): error MSB4242: SDK Resolver Failure: "The SDK resolver "Microsoft.DotNet.MSBuildWorkloadSdkResolver" failed while attempting to resolve the SDK "Microsoft.NET.SDK.WorkloadAutoImportPropsLocator". Exception: "Microsoft.NET.Sdk.WorkloadManifestReader.WorkloadManifestCompositionException: Workload pack \'Microsoft.NET.Runtime.Emscripten.Node.net10\' in manifest \'microsoft.net.workload.emscripten.net10\' [C:\\Program Files\\dotnet\\sdk-manifests\\11.0.100-rc.3\\microsoft.net.workload.emscripten.net10\\11.0.100-rc.3.26522.148\\WorkloadManifest.json] conflicts with manifest \'microsoft.net.workload.emscripten.current\' [C:\\Program Files\\dotnet\\sdk-manifests\\10.0.100\\microsoft.net.workload.emscripten.current\\10.0.112\\WorkloadManifest.json] [d:\\Projects\\Sample\\Sample.csproj]',
].join('\n');

suite('dotnet-failure classifier', () => {
    test('classifies the workload manifest conflict as a toolchain problem', () => {
        const failure = ClassifyDotnetFailure(WORKLOAD_CONFLICT_OUTPUT, {
            ProjectPath: 'd:\\Projects\\Sample\\Sample.csproj',
            Context: {
                WorkingDirectory: 'd:\\Projects\\Sample',
                GlobalJsonPath: 'd:\\Projects\\Sample\\global.json',
                PinnedSdkVersion: '10.0.403',
                Command: 'dotnet',
            },
        });

        assert.strictEqual(failure.Kind, 'WorkloadManifestConflict');
        assert.strictEqual(failure.SdkVersion, '11.0.100-rc.3.26522.148');
        assert.strictEqual(failure.PinnedSdkVersion, '10.0.403');
        assert.match(failure.Summary, /conflicting workload manifests/);
        assert.match(failure.Summary, /Microsoft\.NET\.Runtime\.Emscripten\.Node\.net10/);
        assert.match(failure.Hint, /dotnet workload update/);
        assert.strictEqual(failure.Detail.includes('MSB4242'), true);
        assert.deepStrictEqual(failure.Conflicts, []);
    });

    test('classifies a promoted vulnerability audit, not as a version conflict', () => {
        const output = [
            "sample.csproj : error NU1903: Warning As Error: Package 'SQLitePCLRaw.lib.e_sqlite3' 2.1.11 has a known high severity vulnerability, https://github.com/advisories/GHSA-2m69-gcr7-jv3q",
            "sample.csproj : error NU1903: Warning As Error: Package 'SQLitePCLRaw.lib.e_sqlite3.android' 2.1.11 has a known high severity vulnerability, https://github.com/advisories/GHSA-2m69-gcr7-jv3q",
        ].join('\n');

        const failure = ClassifyDotnetFailure(output);

        assert.strictEqual(failure.Kind, 'VulnerabilityAudit');
        assert.match(failure.Summary, /SQLitePCLRaw\.lib\.e_sqlite3 2\.1\.11 \(high\)/);
        assert.match(failure.Hint, /WarningsAsErrors/);
        assert.match(failure.Hint, /GHSA-2m69-gcr7-jv3q/);
    });

    test('keeps NU1107 as a restore conflict with parsed chains', () => {
        const output = [
            'C:\\ws\\Sample.csproj : error NU1107: Version conflict detected for Microsoft.EntityFrameworkCore.Relational. Install/reference Microsoft.EntityFrameworkCore.Relational 11.0.0 directly to project Sample to resolve this issue.',
            'C:\\ws\\Sample.csproj :  Sample.Api -> Npgsql.EntityFrameworkCore.PostgreSQL 11.0.0 -> Microsoft.EntityFrameworkCore.Relational (= 11.0.0).',
        ].join('\n');

        const failure = ClassifyDotnetFailure(output);

        assert.strictEqual(failure.Kind, 'RestoreConflict');
        assert.strictEqual(failure.Conflicts.length, 1);
        assert.strictEqual(failure.Conflicts[0]!.packageId, 'Microsoft.EntityFrameworkCore.Relational');
        assert.match(failure.Hint, /Consolidate/);
    });

    test('reports a missing pinned SDK', () => {
        const failure = ClassifyDotnetFailure(
            "error MSB4236: The SDK '9.0.100' specified could not be found.",
            { Context: { WorkingDirectory: 'x', PinnedSdkVersion: '9.0.100', Command: 'dotnet' } }
        );

        assert.strictEqual(failure.Kind, 'PinnedSdkMissing');
        assert.match(failure.Summary, /9\.0\.100/);
        assert.match(failure.Hint, /global\.json/);
    });

    test('reports a missing dotnet CLI when spawn fails', () => {
        const failure = ClassifyDotnetFailure('spawn dotnet ENOENT', { SpawnFailed: true });

        assert.strictEqual(failure.Kind, 'DotnetMissing');
        assert.match(failure.Hint, /PATH/);
    });

    test('falls back to Unknown for unrecognized output', () => {
        const failure = ClassifyDotnetFailure('Something unexpected happened.');

        assert.strictEqual(failure.Kind, 'Unknown');
        assert.strictEqual(failure.Summary, 'Something unexpected happened.');
    });

    test('ToFailureInfo drops the host-only conflict list', () => {
        const failure = ClassifyDotnetFailure(WORKLOAD_CONFLICT_OUTPUT);
        const info = ToFailureInfo(failure);

        assert.strictEqual('Conflicts' in info, false);
        assert.strictEqual(info.Kind, 'WorkloadManifestConflict');
    });
});
