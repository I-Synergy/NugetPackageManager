import * as assert from 'assert';
import {
    evaluateCondition,
    getConditionLabel,
    getTfmMajorVersion,
    parseCondition,
} from '@/host/utilities/cpm-condition';

suite('CpmCondition Tests', () => {
    const net10 = { TargetFramework: 'net10.0' };
    const net11 = { TargetFramework: 'net11.0' };
    const net10Windows = { TargetFramework: 'net10.0-windows10.0.26100.0' };

    suite('StartsWith / EndsWith / Contains', () => {
        test('positive StartsWith matches', () => {
            const condition = "$(TargetFramework.StartsWith('net11.0'))";
            assert.strictEqual(evaluateCondition(condition, net11), true);
            assert.strictEqual(evaluateCondition(condition, net10), false);
        });

        test('negated StartsWith inverts the result', () => {
            const condition = "!$(TargetFramework.StartsWith('net11.0'))";
            assert.strictEqual(evaluateCondition(condition, net10), true);
            assert.strictEqual(evaluateCondition(condition, net11), false);
        });

        test('platform-specific TFMs still match their base TFM', () => {
            const condition = "$(TargetFramework.StartsWith('net10.0'))";
            assert.strictEqual(evaluateCondition(condition, net10Windows), true);
        });

        test('EndsWith and Contains', () => {
            assert.strictEqual(
                evaluateCondition("$(TargetFramework.EndsWith('26100.0'))", net10Windows),
                true
            );
            assert.strictEqual(
                evaluateCondition("$(TargetFramework.Contains('-windows'))", net10Windows),
                true
            );
            assert.strictEqual(
                evaluateCondition("$(TargetFramework.Contains('-android'))", net10Windows),
                false
            );
        });
    });

    suite('Comparisons and boolean operators', () => {
        test('equality and inequality', () => {
            assert.strictEqual(
                evaluateCondition("'$(TargetFramework)' == 'net10.0'", net10),
                true
            );
            assert.strictEqual(
                evaluateCondition("'$(TargetFramework)' != 'net10.0'", net10),
                false
            );
            assert.strictEqual(
                evaluateCondition("'$(TargetFramework)' != 'net10.0'", net11),
                true
            );
        });

        test('And / Or with parentheses', () => {
            const condition =
                "('$(TargetFramework)' == 'net10.0' Or '$(TargetFramework)' == 'net11.0') And $(TargetFramework.StartsWith('net'))";
            assert.strictEqual(evaluateCondition(condition, net10), true);
            assert.strictEqual(evaluateCondition(condition, { TargetFramework: 'netstandard2.0' }), false);
        });

        test('negated comparison', () => {
            assert.strictEqual(
                evaluateCondition("!('$(TargetFramework)' == 'net11.0')", net10),
                true
            );
        });
    });

    suite('Unknown and malformed conditions', () => {
        test('unknown property yields null', () => {
            assert.strictEqual(
                evaluateCondition("$(SomeOtherProperty.StartsWith('x'))", net10),
                null
            );
        });

        test('malformed condition yields null', () => {
            assert.strictEqual(evaluateCondition("$(TargetFramework.StartsWith(", net10), null);
            assert.strictEqual(evaluateCondition("And", net10), null);
        });

        test('property-only condition is evaluated as a boolean', () => {
            assert.strictEqual(evaluateCondition("$(Enabled)", { Enabled: 'true' }), true);
            assert.strictEqual(evaluateCondition("$(Enabled)", { Enabled: 'false' }), false);
            assert.strictEqual(evaluateCondition("$(Enabled)", {}), null);
        });

        test('empty condition is always true', () => {
            assert.strictEqual(evaluateCondition("", net10), true);
            assert.ok(parseCondition(""));
        });
    });

    suite('Labels', () => {
        test('positive and negated conditions get distinct labels', () => {
            const positive = "$(TargetFramework.StartsWith('net11.0'))";
            const negated = "!$(TargetFramework.StartsWith('net11.0'))";
            assert.strictEqual(getConditionLabel(positive), 'net11.0');
            assert.strictEqual(getConditionLabel(negated), 'not net11.0');
        });

        test('comparison labels', () => {
            assert.strictEqual(getConditionLabel("'$(TargetFramework)' == 'net9.0'"), 'net9.0');
            assert.strictEqual(getConditionLabel("'$(TargetFramework)' != 'net9.0'"), 'not net9.0');
        });

        test('unsupported conditions fall back to a readable label', () => {
            const label = getConditionLabel("$([MSBuild]::VersionGreaterThanOrEquals('1','2'))");
            assert.ok(label.length > 0);
            assert.ok(!label.includes('$('));
        });
    });

    suite('TFM major version', () => {
        test('parses major from net TFMs', () => {
            assert.strictEqual(getTfmMajorVersion('net10.0'), 10);
            assert.strictEqual(getTfmMajorVersion('net11.0-windows'), 11);
            assert.strictEqual(getTfmMajorVersion('net8.0-android'), 8);
        });

        test('returns null for non-net TFMs', () => {
            assert.strictEqual(getTfmMajorVersion('netstandard2.0'), null);
            assert.strictEqual(getTfmMajorVersion('unknown'), null);
        });
    });
});
