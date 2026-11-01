import * as assert from 'assert';
import { satisfiesVersionRange } from '@/host/utilities/version';

suite('version ranges', () => {
    test('exact pin only matches the pinned version', () => {
        assert.strictEqual(
            satisfiesVersionRange('11.0.0-rc.2.26504.105', '[11.0.0-rc.2.26504.105]'),
            true
        );
        assert.strictEqual(
            satisfiesVersionRange('11.0.0-rc.3.26522.148', '[11.0.0-rc.2.26504.105]'),
            false
        );
    });

    test('lower bound ranges accept newer versions', () => {
        assert.strictEqual(satisfiesVersionRange('11.0.0-rc.3.26522.148', '[11.0.0-rc.2.26504.105, )'), true);
        assert.strictEqual(satisfiesVersionRange('11.0.0-rc.1.26425.128', '[11.0.0-rc.2.26504.105, )'), false);
    });

    test('upper bound ranges exclude the upper bound when it is exclusive', () => {
        assert.strictEqual(satisfiesVersionRange('9.0.5', '[8.0.0, 10.0.0)'), true);
        assert.strictEqual(satisfiesVersionRange('10.0.0', '[8.0.0, 10.0.0)'), false);
    });

    test('a bare version means at least that version', () => {
        assert.strictEqual(satisfiesVersionRange('13.0.3', '13.0.1'), true);
        assert.strictEqual(satisfiesVersionRange('13.0.0', '13.0.1'), false);
    });

    test('floating ranges match the prefix', () => {
        assert.strictEqual(satisfiesVersionRange('10.0.14', '10.*'), true);
        assert.strictEqual(satisfiesVersionRange('11.0.0-rc.2.26504.105', '10.*'), false);
        assert.strictEqual(satisfiesVersionRange('1.2.9', '1.2.*'), true);
    });

    test('an unconstrained range accepts everything', () => {
        assert.strictEqual(satisfiesVersionRange('1.0.0', ''), true);
        assert.strictEqual(satisfiesVersionRange('1.0.0', '*'), true);
    });
});
