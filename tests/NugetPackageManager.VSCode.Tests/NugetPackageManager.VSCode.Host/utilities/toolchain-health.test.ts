import * as assert from 'assert';
import { RedactDiagnostics } from '@/host/utilities/toolchain-health';

suite('toolchain-health', () => {
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
