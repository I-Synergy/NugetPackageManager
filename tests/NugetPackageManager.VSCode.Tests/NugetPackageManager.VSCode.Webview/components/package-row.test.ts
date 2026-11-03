import '@/web/web-setup';
import * as assert from 'assert';
import { PackageRow } from '@/web/components/package-row';
import { PackageViewModel } from '@/web/types';

// Mock types locally since we can't import hidden types easily or want to simplify
function createPackageViewModel(overrides: any = {}): PackageViewModel {
    const defaultPackage = {
        Id: 'Test.Package',
        Name: 'Test.Package',
        Authors: ['Author1'],
        Description: 'Test Description',
        IconUrl: 'http://test.com/icon.png',
        LicenseUrl: 'http://license.com',
        ProjectUrl: 'http://project.com',
        Registration: '',
        TotalDownloads: 100,
        Verified: false,
        InstalledVersion: '',
        Version: '1.0.0',
        Versions: [],
        Tags: ['tag1']
    };

    const model = { ...defaultPackage, ...overrides };

    // Status is the second argument
    const status = overrides.Status || 'Detailed';

    // Create the view model
    const vm = new PackageViewModel(model, status);

    // Apply other overrides that might not be in the model but on the VM directly if needed (like Selected)
    if (overrides.Selected !== undefined) {
        vm.Selected = overrides.Selected;
    }

    return vm;
}

suite('PackageRow Component', () => {
    let packageRow: PackageRow;

    setup(() => {
        packageRow = new PackageRow();
        // Initialize with a default package to prevent undefined access in template during connection
        packageRow.package = createPackageViewModel();
        document.body.appendChild(packageRow);
    });

    teardown(() => {
        document.body.removeChild(packageRow);
    });

    test('should initialize with default values', () => {
        assert.strictEqual(packageRow.iconUrl, null);
    });

    test('should render package name', async () => {
        const pkg = createPackageViewModel({
            Name: 'Test.Package'
        });
        packageRow.package = pkg;
        packageRow.showInstalledVersion = false;

        await packageRow.updateComplete;

        const shadowRoot = packageRow.shadowRoot;
        assert.ok(shadowRoot);

        const nameElement = shadowRoot.querySelector('.name');
        assert.ok(nameElement);
        assert.strictEqual(nameElement.textContent?.trim(), 'Test.Package');
    });

    test('should render authors if present', async () => {
        const pkg = createPackageViewModel({
            Authors: ['Author1', 'Author2']
        });
        packageRow.package = pkg;

        await packageRow.updateComplete;

        const shadowRoot = packageRow.shadowRoot;
        assert.ok(shadowRoot);

        const authorsElement = shadowRoot.querySelector('.authors');
        assert.ok(authorsElement);
        // PackageViewModel joins authors with ", "
        // Template adds "by " prefix
        assert.strictEqual(authorsElement.textContent?.trim(), 'by Author1, Author2');
    });

    test('should not render authors if missing (empty array)', async () => {
        const pkg = createPackageViewModel({
            Authors: []
        });
        packageRow.package = pkg;

        await packageRow.updateComplete;

        const shadowRoot = packageRow.shadowRoot;
        assert.ok(shadowRoot);

        const authorsElement = shadowRoot.querySelector('.authors');
        assert.strictEqual(authorsElement, null);
    });

    test('should use default icon if IconUrl is missing', async () => {
        const pkg = createPackageViewModel({
            IconUrl: ''
        });
        packageRow.package = pkg;

        await packageRow.updateComplete;

        const shadowRoot = packageRow.shadowRoot;
        const img = shadowRoot?.querySelector('img.icon');
        assert.ok(img);

        assert.strictEqual(img.getAttribute('src'), 'https://nuget.org/Content/gallery/img/default-package-icon.svg');
    });

    test('should use provided IconUrl', async () => {
        const iconUrl = 'http://test.com/icon.png';
        const pkg = createPackageViewModel({
            IconUrl: iconUrl
        });
        packageRow.package = pkg;

        await packageRow.updateComplete;

        const shadowRoot = packageRow.shadowRoot;
        const img = shadowRoot?.querySelector('img.icon');
        assert.ok(img);

        assert.strictEqual(img.getAttribute('src'), iconUrl);
    });

    test('should fallback to default icon on error', async () => {
        const iconUrl = 'http://test.com/invalid.png';
        const pkg = createPackageViewModel({
            IconUrl: iconUrl
        });
        packageRow.package = pkg;

        await packageRow.updateComplete;

        const shadowRoot = packageRow.shadowRoot;
        const img = shadowRoot?.querySelector('img.icon') as HTMLImageElement;
        assert.ok(img);

        // jsdom 30 no longer raises image error events; invoke the same handler
        // the template binds to @error.
        (packageRow as unknown as { onIconError(): void }).onIconError();

        await packageRow.updateComplete;

        assert.strictEqual(packageRow.iconUrl, 'https://nuget.org/Content/gallery/img/default-package-icon.svg');
        await packageRow.updateComplete;
        const updatedImg = shadowRoot?.querySelector('img.icon') as HTMLImageElement;
        assert.strictEqual(updatedImg.getAttribute('src'), 'https://nuget.org/Content/gallery/img/default-package-icon.svg');
    });

    test('should display version when showInstalledVersion is false', async () => {
        const pkg = createPackageViewModel({
            Version: '1.2.3'
        });
        packageRow.package = pkg;
        packageRow.showInstalledVersion = false;

        await packageRow.updateComplete;

        const shadowRoot = packageRow.shadowRoot;
        const versionDiv = shadowRoot?.querySelector('.package-version');
        assert.ok(versionDiv);

        assert.strictEqual(versionDiv.textContent?.trim(), '1.2.3');
    });

    test('should display installed version when showInstalledVersion is true', async () => {
        const pkg = createPackageViewModel({
            InstalledVersion: '1.0.0',
            Version: '1.2.3'
        });
        packageRow.package = pkg;
        packageRow.showInstalledVersion = true;

        await packageRow.updateComplete;

        const shadowRoot = packageRow.shadowRoot;
        const versionDiv = shadowRoot?.querySelector('.package-version');
        assert.ok(versionDiv);

        assert.ok(versionDiv.textContent?.includes('1.0.0'));
    });

    test('should show update arrow when detailed and update available', async () => {
        const pkg = createPackageViewModel({
            InstalledVersion: '1.0.0',
            Version: '1.2.3',
            Status: 'Detailed'
        });
        packageRow.package = pkg;
        packageRow.showInstalledVersion = true;

        await packageRow.updateComplete;

        const shadowRoot = packageRow.shadowRoot;
        const arrow = shadowRoot?.querySelector('.codicon-arrow-circle-up');
        assert.ok(arrow, 'Update arrow should be visible');
    });

    test('renders the update arrow as a button naming the target version', async () => {
        const pkg = createPackageViewModel({
            InstalledVersion: '1.0.0',
            Version: '1.2.3',
            Status: 'Detailed'
        });
        packageRow.package = pkg;
        packageRow.showInstalledVersion = true;

        await packageRow.updateComplete;

        const button = packageRow.shadowRoot?.querySelector('.update-indicator') as HTMLButtonElement | null;
        assert.ok(button, 'the arrow should be a real button');
        assert.strictEqual(button.tagName, 'BUTTON');
        assert.strictEqual(button.getAttribute('aria-label'), 'Update Test.Package to 1.2.3');
        assert.ok(button.getAttribute('title')?.includes('1.2.3'));
        assert.ok(button.querySelector('.codicon-arrow-circle-up'), 'the button keeps the arrow glyph');
    });

    test('clicking the arrow requests an update and does not reach the row handler', async () => {
        const pkg = createPackageViewModel({
            InstalledVersion: '1.0.0',
            Version: '1.2.3',
            Status: 'Detailed'
        });
        packageRow.package = pkg;
        packageRow.showInstalledVersion = true;

        await packageRow.updateComplete;

        const requested: PackageViewModel[] = [];
        const rowClicks: Event[] = [];
        packageRow.addEventListener('package-update-requested', (e) => {
            requested.push((e as CustomEvent<{ package: PackageViewModel }>).detail.package);
        });
        // Mimics the Installed tab's row-level `@click` → SelectPackageAsync binding.
        packageRow.addEventListener('click', (e) => rowClicks.push(e));

        const button = packageRow.shadowRoot?.querySelector('.update-indicator') as HTMLButtonElement;
        button.click();

        assert.strictEqual(requested.length, 1, 'the arrow dispatches package-update-requested');
        assert.strictEqual(requested[0], pkg);
        assert.strictEqual(rowClicks.length, 0, 'the row click handler must not also fire');
    });

    test('renders a spinner instead of the update button while updating', async () => {
        const pkg = createPackageViewModel({
            InstalledVersion: '1.0.0',
            Version: '1.2.3',
            Status: 'Detailed'
        });
        packageRow.package = pkg;
        packageRow.showInstalledVersion = true;
        packageRow.updating = true;

        await packageRow.updateComplete;

        const shadowRoot = packageRow.shadowRoot;
        assert.strictEqual(shadowRoot?.querySelector('.update-indicator'), null, 'no button while updating');
        const spinner = shadowRoot?.querySelector('.spinner');
        assert.ok(spinner, 'a spinner signals the in-flight update');
        assert.strictEqual(spinner?.getAttribute('aria-label'), 'Updating Test.Package');
    });

    test('should NOT show update arrow when versions match', async () => {
        const pkg = createPackageViewModel({
            InstalledVersion: '1.0.0',
            Version: '1.0.0',
            Status: 'Detailed'
        });
        packageRow.package = pkg;
        packageRow.showInstalledVersion = true;

        await packageRow.updateComplete;

        const shadowRoot = packageRow.shadowRoot;
        const arrow = shadowRoot?.querySelector('.codicon-arrow-circle-up');
        assert.strictEqual(arrow, null, 'Update arrow should not be visible');
    });

    test('should show loader when Status is MissingDetails', async () => {
        const pkg = createPackageViewModel({
            InstalledVersion: '1.0.0',
            Status: 'MissingDetails'
        });
        packageRow.package = pkg;
        packageRow.showInstalledVersion = true;

        await packageRow.updateComplete;

        const shadowRoot = packageRow.shadowRoot;
        const loader = shadowRoot?.querySelector('.spinner');
        assert.ok(loader, 'Loader should be visible');
    });

    test('should show error icon when Status is Error', async () => {
        const pkg = createPackageViewModel({
            InstalledVersion: '1.0.0',
            Status: 'Error'
        });
        packageRow.package = pkg;
        packageRow.showInstalledVersion = true;

        await packageRow.updateComplete;

        const shadowRoot = packageRow.shadowRoot;
        const errorIcon = shadowRoot?.querySelector('.codicon-error');
        assert.ok(errorIcon, 'Error icon should be visible');

        const row = shadowRoot?.querySelector('.package-row');
        assert.ok(row?.classList.contains('package-row-error'), 'Row should have error class');
    });

    test('should render an inline framework badge', async () => {
        const pkg = createPackageViewModel();
        pkg.CpmFramework = 'net8.0';
        packageRow.package = pkg;

        await packageRow.updateComplete;

        const badge = packageRow.shadowRoot?.querySelector('.tfm-badge');
        assert.ok(badge, 'TFM badge should be rendered inline');
        assert.strictEqual(badge?.textContent?.trim(), 'net8.0');
    });

    test('should add selected class when selected', async () => {
        const pkg = createPackageViewModel({
            Selected: true
        });
        packageRow.package = pkg;

        await packageRow.updateComplete;

        const shadowRoot = packageRow.shadowRoot;
        const row = shadowRoot?.querySelector('.package-row');
        assert.ok(row?.classList.contains('package-row-selected'), 'Row should have selected class');
    });
});
