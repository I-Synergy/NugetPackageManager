import * as assert from 'assert';
import { shouldShowFrameworkGroups } from '@/common/framework';

suite('framework group headers', () => {
    test('hides the header when there are no groups', () => {
        assert.strictEqual(shouldShowFrameworkGroups([]), false);
    });

    test('hides the header for a single framework line', () => {
        assert.strictEqual(shouldShowFrameworkGroups([{ key: '', label: 'Shared' }]), false);
    });

    test('shows the header once two framework lines are present', () => {
        assert.strictEqual(
            shouldShowFrameworkGroups([
                { key: '', label: 'Shared' },
                { key: 'net10.0', label: 'net10.0' },
            ]),
            true
        );
    });
});
