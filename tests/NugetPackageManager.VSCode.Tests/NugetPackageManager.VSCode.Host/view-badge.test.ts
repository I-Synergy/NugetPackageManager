import * as assert from "assert";
import * as vscode from "vscode";
import { ClearBadgeView, RegisterBadgeView, SetUpdateBadge } from "@/host/view-badge";

type BadgeView = vscode.TreeView<unknown> & { badge: vscode.ViewBadge | undefined };

function CreateView(): BadgeView {
    return { badge: undefined } as unknown as BadgeView;
}

suite("view badge", () => {
    test("shows the update count in the badge tooltip", () => {
        const view = CreateView();
        RegisterBadgeView(view);

        SetUpdateBadge(5);

        assert.strictEqual(view.badge?.value, 5);
        assert.strictEqual(view.badge?.tooltip, "5 updates available");
        ClearBadgeView(view);
    });

    test("mentions updates blocked by dependency conflicts", () => {
        const view = CreateView();
        RegisterBadgeView(view);

        SetUpdateBadge(5, 2);

        assert.strictEqual(view.badge?.value, 5);
        assert.strictEqual(
            view.badge?.tooltip,
            "5 updates available · 2 blocked by dependency conflicts"
        );
        ClearBadgeView(view);
    });

    test("uses singular wording for one update and one conflict", () => {
        const view = CreateView();
        RegisterBadgeView(view);

        SetUpdateBadge(1, 1);

        assert.strictEqual(
            view.badge?.tooltip,
            "1 update available · 1 blocked by a dependency conflict"
        );
        ClearBadgeView(view);
    });

    test("hides the badge when there are no updates", () => {
        const view = CreateView();
        RegisterBadgeView(view);

        SetUpdateBadge(0, 3);

        assert.strictEqual(view.badge, undefined);
        ClearBadgeView(view);
    });

    test("ignores updates after the view is cleared", () => {
        const view = CreateView();
        RegisterBadgeView(view);
        ClearBadgeView(view);

        SetUpdateBadge(4, 1);

        assert.strictEqual(view.badge, undefined);
    });
});
