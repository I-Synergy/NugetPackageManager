/** UI-only option value for unconditional/shared CPM versions. */
export const SHARED_FRAMEWORK = "__shared__";

/** Reduces a platform TFM (net10.0-windows, net10.0-android) to its base line. */
export function getBaseTargetFramework(tfm: string): string {
  const value = tfm.trim();
  if (!value) return "";
  const separator = value.indexOf("-");
  return (separator > 0 ? value.slice(0, separator) : value).toLowerCase();
}

/** Human label for the framework selector. */
export function getFrameworkLabel(value: string): string {
  if (value === "") return "All frameworks";
  if (value === SHARED_FRAMEWORK) return "Shared";
  return value;
}

export type FrameworkOption = { value: string; label: string };

/** Builds the selector options from raw TFMs, collapsing platform variants. */
export function buildFrameworkOptions(
  values: Iterable<string>,
  hasShared: boolean
): FrameworkOption[] {
  const frameworks = new Set<string>();
  for (const value of values) {
    if (!value || value === SHARED_FRAMEWORK) continue;
    const base = getBaseTargetFramework(value);
    if (base) frameworks.add(base);
  }
  if (frameworks.size === 0) return [];
  return [
    { value: "", label: getFrameworkLabel("") },
    ...(hasShared ? [{ value: SHARED_FRAMEWORK, label: getFrameworkLabel(SHARED_FRAMEWORK) }] : []),
    ...[...frameworks].sort((a, b) => a.localeCompare(b)).map((value) => ({ value, label: getFrameworkLabel(value) })),
  ];
}

/** Whether a package row belongs to the selected framework option. */
export function matchesFrameworkSelection(selected: string, tfm: string): boolean {
  if (selected === "") return true;
  if (selected === SHARED_FRAMEWORK) return tfm === "";
  return tfm !== "" && getBaseTargetFramework(tfm) === selected;
}

/** Group key used by framework-grouped lists. */
export function getFrameworkGroupKey(selected: string, tfm: string): string {
  return selected === SHARED_FRAMEWORK ? "" : getBaseTargetFramework(tfm);
}
