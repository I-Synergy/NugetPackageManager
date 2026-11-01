import * as assert from 'assert';
import {
    AnalyzeAssets,
    RangeLowerBound,
    SplitPackageKey,
    type AssetsFile,
} from '@/host/utilities/dependency-graph';

function assetsFor(directLibVersion: string, libRange = '>= 1.0.0'): AssetsFile {
    return {
        targets: {
            'net10.0': {
                'Parent/1.0.0': { type: 'package', dependencies: { Lib: libRange } },
                [`Lib/${directLibVersion}`]: { type: 'package' },
            },
        },
        project: {
            frameworks: {
                'net10.0': {
                    dependencies: {
                        Parent: { target: 'Package', version: '[1.0.0, )' },
                        Lib: { target: 'Package', version: `[${directLibVersion}, )` },
                    },
                },
            },
        },
    };
}

suite('dependency-graph', () => {
    test('SplitPackageKey separates id and version', () => {
        assert.deepStrictEqual(SplitPackageKey('Microsoft.Extensions.Logging/10.0.3'), {
            id: 'Microsoft.Extensions.Logging',
            version: '10.0.3',
        });
        assert.strictEqual(SplitPackageKey('no-version-here'), null);
    });

    test('RangeLowerBound reads NuGet ranges', () => {
        assert.strictEqual(RangeLowerBound('[1.2.3, )'), '1.2.3');
        assert.strictEqual(RangeLowerBound('(1.2.3, 2.0.0]'), '1.2.3');
        assert.strictEqual(RangeLowerBound('[1.2.3]'), '1.2.3');
        assert.strictEqual(RangeLowerBound('1.2.3'), '1.2.3');
        assert.strictEqual(RangeLowerBound('>= 1.2.3'), '1.2.3');
        assert.strictEqual(RangeLowerBound('>1.2.3'), '1.2.3');
        assert.strictEqual(RangeLowerBound('(, 2.0.0]'), null);
    });

    test('flags a direct reference the graph already provides', () => {
        const issues = AnalyzeAssets(assetsFor('1.0.0'), 'D:/ws/App.csproj');

        assert.deepStrictEqual(issues.map((issue) => [issue.PackageId, issue.Kind, issue.Chain]), [
            ['Lib', 'Redundant', 'Parent -> Lib'],
        ]);
        assert.strictEqual(issues[0]!.Tfm, 'net10.0');
        assert.strictEqual(issues[0]!.ProjectPath, 'D:/ws/App.csproj');
    });

    test('keeps a direct reference that raises the version (pinned)', () => {
        const issues = AnalyzeAssets(assetsFor('2.0.0'), 'D:/ws/App.csproj');

        assert.deepStrictEqual(issues.map((issue) => [issue.PackageId, issue.Kind]), [['Lib', 'Pinned']]);
    });

    test('keeps a direct reference when the chain has no lower bound', () => {
        const issues = AnalyzeAssets(assetsFor('1.5.0', '(, 2.0.0]'), 'D:/ws/App.csproj');

        assert.deepStrictEqual(issues.map((issue) => issue.Kind), ['Pinned']);
    });

    test('ignores packages that are only transitive', () => {
        const assets: AssetsFile = {
            targets: {
                'net10.0': {
                    'Parent/1.0.0': { type: 'package', dependencies: { Shared: '>= 1.0.0' } },
                    'Other/1.0.0': { type: 'package', dependencies: { Shared: '>= 1.0.0' } },
                    'Shared/1.0.0': { type: 'package' },
                },
            },
            project: {
                frameworks: {
                    'net10.0': {
                        dependencies: {
                            Parent: { target: 'Package' },
                            Other: { target: 'Package' },
                        },
                    },
                },
            },
        };

        assert.deepStrictEqual(AnalyzeAssets(assets, 'D:/ws/App.csproj'), []);
    });

    test('does not report project references as packages', () => {
        const assets: AssetsFile = {
            targets: {
                'net10.0': {
                    'Lib/1.0.0': { type: 'package' },
                    'Sibling/1.0.0': { type: 'project', dependencies: { Lib: '>= 1.0.0' } },
                },
            },
            project: {
                frameworks: {
                    'net10.0': {
                        dependencies: {
                            Sibling: { target: 'Project' },
                            Lib: { target: 'Package' },
                        },
                    },
                },
            },
        };

        assert.deepStrictEqual(AnalyzeAssets(assets, 'D:/ws/App.csproj'), []);
    });
});
