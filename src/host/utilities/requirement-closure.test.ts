import * as assert from 'assert';
import { ComputeRequirementClosureAsync, OrderRequirements, type ClosureDependency } from './requirement-closure';

type Deps = Record<string, ClosureDependency[]>;

function provider(deps: Deps) {
    return async (id: string, version: string, tfm: string): Promise<ClosureDependency[] | null> => {
        return deps[`${id}@${version}|${tfm}`] ?? null;
    };
}

suite('requirement-closure', () => {
    test('reports a direct requirement below the resolved version', async () => {
        const result = await ComputeRequirementClosureAsync({
            Selected: [{ Id: 'A', Version: '2.0.0' }],
            Tfms: ['net10.0'],
            Effective: new Map([['b', '1.0.0']]),
            GetDependencies: provider({
                'A@2.0.0|net10.0': [{ Id: 'B', Range: '[2.0.0, )' }],
            }),
        });

        assert.deepStrictEqual(result.Conflicts, [{
            PackageId: 'B',
            RequiredBy: 'A',
            RequiredByVersion: '2.0.0',
            Range: '[2.0.0, )',
            RequiredVersion: '2.0.0',
            Tfm: 'net10.0',
        }]);
        assert.strictEqual(result.Planned.get('b'), '2.0.0');
    });

    test('follows the closure through a required package', async () => {
        const result = await ComputeRequirementClosureAsync({
            Selected: [{ Id: 'A', Version: '2.0.0' }],
            Tfms: ['net10.0'],
            Effective: new Map([['b', '1.0.0'], ['c', '1.0.0']]),
            GetDependencies: provider({
                'A@2.0.0|net10.0': [{ Id: 'B', Range: '[2.0.0, )' }],
                'B@2.0.0|net10.0': [{ Id: 'C', Range: '[3.0.0, )' }],
            }),
        });

        assert.deepStrictEqual(result.Conflicts.map((conflict) => conflict.PackageId), ['B', 'C']);
        assert.deepStrictEqual(result.Conflicts.map((conflict) => conflict.RequiredBy), ['A', 'B']);
        assert.strictEqual(result.Planned.get('c'), '3.0.0');
    });

    test('ignores requirements the resolved graph already satisfies', async () => {
        const result = await ComputeRequirementClosureAsync({
            Selected: [{ Id: 'A', Version: '2.0.0' }],
            Tfms: ['net10.0'],
            Effective: new Map([['b', '2.5.0']]),
            GetDependencies: provider({
                'A@2.0.0|net10.0': [{ Id: 'B', Range: '[2.0.0, )' }],
            }),
        });

        assert.deepStrictEqual(result.Conflicts, []);
    });

    test('ignores ranges without a lower bound', async () => {
        const result = await ComputeRequirementClosureAsync({
            Selected: [{ Id: 'A', Version: '2.0.0' }],
            Tfms: ['net10.0'],
            Effective: new Map([['b', '1.0.0']]),
            GetDependencies: provider({
                'A@2.0.0|net10.0': [{ Id: 'B', Range: '(, 2.0.0]' }],
            }),
        });

        assert.deepStrictEqual(result.Conflicts, []);
    });

    test('keeps per-TFM requirements apart', async () => {
        const result = await ComputeRequirementClosureAsync({
            Selected: [{ Id: 'A', Version: '2.0.0' }],
            Tfms: ['net10.0', 'net11.0'],
            Effective: new Map([['b', '1.0.0']]),
            GetDependencies: provider({
                'A@2.0.0|net10.0': [{ Id: 'B', Range: '[2.0.0, )' }],
                'A@2.0.0|net11.0': [{ Id: 'B', Range: '[3.0.0, )' }],
            }),
        });

        assert.deepStrictEqual(
            result.Conflicts.map((conflict) => `${conflict.Tfm}:${conflict.RequiredVersion}`),
            ['net10.0:2.0.0', 'net11.0:3.0.0']
        );
    });

    test('stops at the inspection budget', async () => {
        const deps: Deps = {};
        for (let index = 0; index < 10; index++) {
            deps[`P${index}@1.0.0|net10.0`] = [{ Id: `P${index + 1}`, Range: '[1.0.0, )' }];
        }

        const result = await ComputeRequirementClosureAsync({
            Selected: [{ Id: 'P0', Version: '1.0.0' }],
            Tfms: ['net10.0'],
            Effective: new Map(),
            GetDependencies: provider(deps),
            MaxInspected: 3,
        });

        assert.strictEqual(result.Conflicts.length <= 3, true);
        assert.strictEqual(result.Conflicts.length > 0, true);
    });
});

suite('requirement ordering', () => {
    const conflict = (requiredBy: string, packageId: string) => ({
        PackageId: packageId,
        RequiredBy: requiredBy,
        RequiredByVersion: '1.0.0',
        Range: '[1.0.0, )',
        RequiredVersion: '1.0.0',
        Tfm: 'net10.0',
    });

    test('puts dependencies in earlier steps', () => {
        const order = OrderRequirements([
            conflict('Globalization', 'Core'),
            conflict('Core', 'Microsoft.Extensions.Hosting'),
        ]);

        assert.strictEqual(order.get('microsoft.extensions.hosting')!.Order, 0);
        assert.strictEqual(order.get('core')!.Order, 1);
        assert.strictEqual(order.get('globalization')!.Order, 2);
        assert.deepStrictEqual(order.get('core')!.DependsOn, ['microsoft.extensions.hosting']);
    });

    test('tolerates a cycle instead of throwing', () => {
        const order = OrderRequirements([conflict('A', 'B'), conflict('B', 'A')]);

        assert.strictEqual(Number.isFinite(order.get('a')!.Order), true);
        assert.strictEqual(Number.isFinite(order.get('b')!.Order), true);
    });
});
