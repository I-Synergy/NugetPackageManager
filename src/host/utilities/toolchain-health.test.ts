import * as assert from 'assert';
import {
    MergeInstalledSdks,
    ParseMsBuildProperty,
    ParseSdkList,
    RedactDiagnostics,
    SdkSatisfiesPin,
} from './toolchain-health';

suite('toolchain-health', () => {
    test('SdkSatisfiesPin accepts an exact match', () => {
        assert.strictEqual(SdkSatisfiesPin('10.0.403', '10.0.403', undefined), true);
    });

    test('SdkSatisfiesPin rejects a different major line', () => {
        assert.strictEqual(SdkSatisfiesPin('11.0.100-rc.3', '10.0.403', 'latestPatch'), false);
    });

    test('SdkSatisfiesPin honours rollForward: disable', () => {
        assert.strictEqual(SdkSatisfiesPin('10.0.404', '10.0.403', 'disable'), false);
    });

    test('SdkSatisfiesPin allows a patch bump under latestPatch', () => {
        assert.strictEqual(SdkSatisfiesPin('10.0.404', '10.0.403', 'latestPatch'), true);
    });

    test('ParseSdkList reads dotnet --list-sdks output', () => {
        const output = [
            '10.0.403 [C:\\Program Files\\dotnet\\sdk]',
            '9.0.320 [C:\\Program Files\\dotnet\\sdk]',
            '',
        ].join('\r\n');

        assert.deepStrictEqual(ParseSdkList(output), [
            { Version: '10.0.403', Path: 'C:\\Program Files\\dotnet\\sdk', Source: 'system' },
            { Version: '9.0.320', Path: 'C:\\Program Files\\dotnet\\sdk', Source: 'system' },
        ]);
    });

    test('MergeInstalledSdks adds private SDKs without duplicating versions', () => {
        const merged = MergeInstalledSdks(
            [{ Version: '10.0.403', Path: 'C:\\dotnet\\sdk', Source: 'system' }],
            ['10.0.403', '9.0.100']
        );

        assert.deepStrictEqual(
            merged.map((sdk) => `${sdk.Version}:${sdk.Source}`),
            ['10.0.403:system', '9.0.100:private']
        );
    });

    test('ParseMsBuildProperty reads the SDK the build resolved', () => {
        const output = [
            'MSBuild version 17.14.8 for .NET',
            '{',
            '  "Properties": {',
            '    "TargetFramework": "net10.0",',
            '    "NETCoreSdkVersion": "10.0.403"',
            '  }',
            '}',
        ].join('\n');

        assert.strictEqual(ParseMsBuildProperty(output, 'NETCoreSdkVersion'), '10.0.403');
        assert.strictEqual(ParseMsBuildProperty(output, 'Missing'), undefined);
        assert.strictEqual(ParseMsBuildProperty('not json', 'NETCoreSdkVersion'), undefined);
    });

    test('RedactDiagnostics removes credentials from URLs and key/value pairs', () => {
        const report = [
            'source: https://user:secret@pkgs.dev.azure.com/feed',
            'password=hunter2',
            'ApiKey: abc123',
        ].join('\n');

        const redacted = RedactDiagnostics(report);

        assert.strictEqual(redacted.includes('secret'), false);
        assert.strictEqual(redacted.includes('hunter2'), false);
        assert.strictEqual(redacted.includes('abc123'), false);
        assert.match(redacted, /https:\/\/\*\*\*@pkgs\.dev\.azure\.com\/feed/);
    });
});
