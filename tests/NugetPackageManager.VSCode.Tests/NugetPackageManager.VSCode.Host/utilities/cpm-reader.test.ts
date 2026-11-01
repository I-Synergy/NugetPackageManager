import * as assert from 'assert';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as sinon from 'sinon';
import coreProcess from '@/host/nuget/core-process';
import CpmReader from '@/host/utilities/cpm-reader';

/** The wire shape the core's `getCpmMap` handler returns. */
type CpmMapWire = {
    unconditional: Record<string, string>;
    conditional: Array<{
        condition: string;
        framework: string;
        versions: Record<string, string>;
        order: number;
    }>;
    hasConditionalGroups: boolean;
};

suite('cpm-reader', () => {
    let sandbox: sinon.SinonSandbox;
    let workspaceDir: string;
    let propsPath: string;
    let projectPath: string;

    setup(() => {
        sandbox = sinon.createSandbox();
        workspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cpm-reader-'));
        propsPath = path.join(workspaceDir, 'Directory.Packages.props');
        projectPath = path.join(workspaceDir, 'src', 'App.csproj');
        fs.mkdirSync(path.dirname(projectPath), { recursive: true });

        fs.writeFileSync(
            propsPath,
            '<Project><PropertyGroup><ManagePackageVersionsCentrally>true</ManagePackageVersionsCentrally></PropertyGroup></Project>'
        );
        fs.writeFileSync(projectPath, '<Project Sdk="Microsoft.NET.Sdk"></Project>');
    });

    teardown(() => {
        sandbox.restore();
        fs.rmSync(workspaceDir, { recursive: true, force: true });
    });

    function stubMap(wire: CpmMapWire | null): sinon.SinonStub {
        return sandbox.stub(coreProcess, 'CallAsync').resolves(wire);
    }

    suite('FindCpmFilePathAsync', () => {
        test('walks up from the project to the nearest props file', async () => {
            const result = await CpmReader.FindCpmFilePathAsync(projectPath);
            assert.strictEqual(result, propsPath);
        });

        test('returns null when the props file does not enable CPM', async () => {
            fs.writeFileSync(propsPath, '<Project><PropertyGroup></PropertyGroup></Project>');
            assert.strictEqual(await CpmReader.FindCpmFilePathAsync(projectPath), null);
        });

        test('returns null when the project opts out of CPM', async () => {
            fs.writeFileSync(
                projectPath,
                '<Project><PropertyGroup><ManagePackageVersionsCentrally>false</ManagePackageVersionsCentrally></PropertyGroup></Project>'
            );
            assert.strictEqual(await CpmReader.FindCpmFilePathAsync(projectPath), null);
        });

        test('returns null when no props file exists', async () => {
            fs.rmSync(propsPath);
            assert.strictEqual(await CpmReader.FindCpmFilePathAsync(projectPath), null);
        });
    });

    suite('ParseCpmFileAsync', () => {
        test('turns the core wire shape into maps', async () => {
            const stub = stubMap({
                unconditional: { 'Pkg.Shared': '1.0.0' },
                conditional: [{
                    condition: "$(TargetFramework.StartsWith('net10.0'))",
                    framework: 'net10.0',
                    versions: { 'Pkg.Shared': '2.0.0' },
                    order: 3,
                }],
                hasConditionalGroups: true,
            });

            const map = await CpmReader.ParseCpmFileAsync(propsPath);

            assert.deepStrictEqual(stub.firstCall.args, ['getCpmMap', { propsFilePath: propsPath }]);
            assert.deepStrictEqual([...map.unconditional], [['Pkg.Shared', '1.0.0']]);
            assert.strictEqual(map.conditional.length, 1);
            assert.strictEqual(map.conditional[0]!.framework, 'net10.0');
            assert.deepStrictEqual([...map.conditional[0]!.versions], [['Pkg.Shared', '2.0.0']]);
            assert.strictEqual(map.conditional[0]!.order, 3);
            assert.strictEqual(map.hasConditionalGroups, true);
        });

        test('returns an empty map when the core reports no file', async () => {
            stubMap(null);

            const map = await CpmReader.ParseCpmFileAsync(propsPath);

            assert.strictEqual(map.unconditional.size, 0);
            assert.deepStrictEqual(map.conditional, []);
            assert.strictEqual(map.hasConditionalGroups, false);
        });
    });

    suite('map helpers', () => {
        const map = {
            unconditional: new Map([['Pkg.Shared', '1.0.0']]),
            conditional: [{
                condition: "$(TargetFramework.StartsWith('net10.0'))",
                framework: 'net10.0',
                versions: new Map([['OTHER.Package', '2.0.0']]),
                order: 3,
            }],
            hasConditionalGroups: true,
        };

        test('HasPackage looks through both kinds of version line', () => {
            assert.strictEqual(CpmReader.HasPackage(map, 'pkg.shared'), true);
            assert.strictEqual(CpmReader.HasPackage(map, 'other.package'), true);
            assert.strictEqual(CpmReader.HasPackage(map, 'missing'), false);
        });

        test('PackageIds keeps the casing the file uses', () => {
            assert.deepStrictEqual([...CpmReader.PackageIds(map)], ['Pkg.Shared', 'OTHER.Package']);
        });
    });
});
