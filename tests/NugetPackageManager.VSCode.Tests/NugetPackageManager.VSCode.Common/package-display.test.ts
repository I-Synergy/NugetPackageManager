import * as assert from 'assert';
import { FormatDownloads, IsPrereleaseVersion } from '@/common/package-display';

suite('package display helpers', () => {
    test('renders an em dash for an unknown download count', () => {
        assert.strictEqual(FormatDownloads(null), '—');
        assert.strictEqual(FormatDownloads(undefined), '—');
    });

    test('scales download counts', () => {
        assert.strictEqual(FormatDownloads(999), '999');
        assert.strictEqual(FormatDownloads(1_500), '1.5K');
        assert.strictEqual(FormatDownloads(2_500_000), '2.5M');
        assert.strictEqual(FormatDownloads(3_200_000_000), '3.2B');
    });

    test('detects prerelease versions', () => {
        assert.strictEqual(IsPrereleaseVersion('1.2.3'), false);
        assert.strictEqual(IsPrereleaseVersion('1.2.3-preview.1'), true);
    });
});
