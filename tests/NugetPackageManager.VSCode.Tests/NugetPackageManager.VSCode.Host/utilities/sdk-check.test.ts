import * as assert from 'assert';
import { FindSdkStatus, ParseSdkCheckOutput } from '@/host/utilities/sdk-check';

const SAMPLE = [
    '.NET SDKs:',
    'Version                      Status',
    '-------------------------------------------------------------------',
    '9.0.320                      .NET 9.0 is going out of support soon.',
    '10.0.403                     Up to date.',
    '11.0.100-rc.3.26522.148      Up to date.',
    '',
    '.NET Runtimes:',
    'Name                              Version                    Status',
    '---------------------------------------------------------------------------------------------------',
    'Microsoft.AspNetCore.App          10.0.8                     Patch 10.0.14 is available.',
    'Microsoft.NETCore.App             10.0.14                    Up to date.',
    '',
].join('\n');

suite('sdk-check', () => {
    test('parses the SDK and runtime tables', () => {
        const result = ParseSdkCheckOutput(SAMPLE);

        assert.strictEqual(result.Unavailable, false);
        assert.deepStrictEqual(result.Sdks.map((row) => row.Version), [
            '9.0.320',
            '10.0.403',
            '11.0.100-rc.3.26522.148',
        ]);
        assert.strictEqual(result.Sdks[0]!.Status, '.NET 9.0 is going out of support soon.');
        assert.strictEqual(result.Sdks[1]!.Status, 'Up to date.');
        assert.deepStrictEqual(result.Runtimes[0], {
            Name: 'Microsoft.AspNetCore.App',
            Version: '10.0.8',
            Status: 'Patch 10.0.14 is available.',
        });
    });

    test('reports unusable output as unavailable', () => {
        for (const output of ['', '   ', 'Something went wrong\n']) {
            const result = ParseSdkCheckOutput(output);
            assert.strictEqual(result.Unavailable, true, output);
            assert.deepStrictEqual(result.Sdks, []);
        }
    });

    test('FindSdkStatus matches the exact version', () => {
        const result = ParseSdkCheckOutput(SAMPLE);
        assert.strictEqual(FindSdkStatus(result, '10.0.403'), 'Up to date.');
        assert.strictEqual(FindSdkStatus(result, '10.0.499'), 'Up to date.');
        assert.strictEqual(FindSdkStatus(result, '8.0.100'), undefined);
    });
});
