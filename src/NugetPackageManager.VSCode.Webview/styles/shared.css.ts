import { css } from "lit";

export const sharedStyles = css`
  /* --- Spinner --- */
  @keyframes spin {
    to {
      transform: rotate(360deg);
    }
  }

  .spinner {
    display: inline-block;
    border: 2px solid var(--vscode-progressBar-background);
    border-top-color: transparent;
    border-radius: 50%;
    animation: spin 1s linear infinite;
  }
  .spinner.small {
    width: 12px;
    height: 12px;
  }
  .spinner.medium {
    width: 16px;
    height: 16px;
  }
  .spinner.large {
    width: 20px;
    height: 20px;
  }

  /* --- Icon button --- */
  button.icon-btn {
    background: transparent;
    border: none;
    color: var(--vscode-icon-foreground);
    cursor: pointer;
    padding: 2px;
    display: flex;
    align-items: center;
  }

  /* --- Primary button --- */
  button.primary-btn {
    background: var(--vscode-button-background);
    color: var(--vscode-button-foreground);
    border: 1px solid transparent;
    border-radius: 3px;
    padding: 5px 12px;
    font-size: 12px;
    cursor: pointer;
  }

  button.primary-btn:hover:not(:disabled) {
    background: var(--vscode-button-hoverBackground);
  }

  button.primary-btn:disabled {
    opacity: 0.5;
    cursor: default;
  }

  button.secondary-btn,
  button.ghost-btn {
    border-radius: 3px;
    padding: 5px 10px;
    font-size: 12px;
    border: 1px solid var(--vscode-panelSection-border);
    cursor: pointer;
    background: transparent;
    color: var(--vscode-foreground);
  }

  button.secondary-btn {
    background: var(--vscode-button-secondaryBackground);
    border-color: transparent;
    color: var(--vscode-button-secondaryForeground);
  }

  button.secondary-btn:hover,
  button.ghost-btn:hover {
    background: var(--vscode-toolbar-hoverBackground);
  }

  button:focus-visible,
  select:focus-visible,
  input:focus-visible {
    outline: 1px solid var(--vscode-focusBorder);
    outline-offset: 1px;
  }

  /* --- List header / section primitives --- */
  .list-header {
    display: flex;
    align-items: flex-start;
    gap: 10px;
    padding: 8px 6px 10px;
    border-bottom: 1px solid var(--vscode-panelSection-border);
    margin-bottom: 4px;
  }

  .list-title {
    font-size: 15px;
    font-weight: 600;
    line-height: 1.25;
  }

  .list-subtitle {
    font-size: 11px;
    color: var(--vscode-descriptionForeground);
    margin-top: 2px;
  }

  .list-actions {
    display: flex;
    align-items: center;
    gap: 6px;
    margin-left: auto;
    flex-shrink: 0;
  }

  .group-header {
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 7px 6px 5px;
    border-bottom: 1px solid var(--vscode-panelSection-border);
    font-size: 10px;
    font-weight: 700;
    letter-spacing: 0.6px;
    text-transform: uppercase;
    color: var(--vscode-descriptionForeground);
    background: var(--vscode-sideBar-background, transparent);
    position: sticky;
    top: 0;
    z-index: 1;
  }

  .group-count {
    font-size: 10px;
    font-weight: 600;
    letter-spacing: 0;
    padding: 1px 6px;
    border-radius: 8px;
    background: var(--vscode-badge-background);
    color: var(--vscode-badge-foreground);
  }

  .info-banner {
    display: flex;
    align-items: flex-start;
    gap: 6px;
    margin: 4px 6px 6px;
    padding: 6px 8px;
    border-radius: 3px;
    border: 1px solid var(--vscode-inputValidation-infoBorder, var(--vscode-panelSection-border));
    background: var(--vscode-inputValidation-infoBackground, transparent);
    color: var(--vscode-descriptionForeground);
    font-size: 11px;
    line-height: 1.4;
  }

  .empty,
  .error {
    flex-direction: column;
    padding: 18px;
    border: 1px solid var(--vscode-panelSection-border);
    border-radius: 4px;
    max-width: 420px;
    margin: 24px auto;
    gap: 6px;
    text-align: center;
    color: var(--vscode-descriptionForeground);
  }

  .error {
    color: var(--vscode-errorForeground);
  }

  .empty .empty-title,
  .error .empty-title {
    color: var(--vscode-foreground);
    font-weight: 600;
    font-size: 12px;
  }

  .empty .empty-hint,
  .error .empty-hint {
    font-size: 11px;
    color: var(--vscode-descriptionForeground);
  }

  /* --- Chips --- */
  .chip,
  .tfm-badge {
    display: inline-flex;
    align-items: center;
    font-size: 9px;
    font-weight: 700;
    line-height: 1;
    padding: 3px 6px;
    border-radius: 8px;
    white-space: nowrap;
    border: 1px solid var(--vscode-panelSection-border);
    background: var(--vscode-badge-background);
    color: var(--vscode-badge-foreground);
  }

  .tfm-badge.shared {
    font-weight: 600;
    opacity: 0.8;
  }

  /* --- Select / Dropdown --- */
  select {
    appearance: none;
    -webkit-appearance: none;
    background-color: var(--vscode-dropdown-background);
    color: var(--vscode-dropdown-foreground);
    border: 1px solid var(--vscode-dropdown-border);
    padding: 4px 24px 4px 8px;
    font-size: inherit;
    font-family: inherit;
    border-radius: 2px;
    background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='10' height='10' viewBox='0 0 10 10'%3E%3Cpath d='M1 3 L5 7 L9 3' stroke='%23808080' stroke-width='1.5' fill='none'/%3E%3C/svg%3E");
    background-repeat: no-repeat;
    background-position: right 6px center;
    cursor: pointer;
    outline: none;
  }
  select:focus {
    border-color: var(--vscode-focusBorder);
  }

  /* --- Toolbar --- */
  .toolbar {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 4px;
    margin-bottom: 6px;
  }
  .toolbar .status-text {
    font-size: 12px;
    color: var(--vscode-descriptionForeground);
    flex: 1;
  }
  .toolbar .toolbar-right {
    display: flex;
    align-items: center;
    gap: 8px;
  }

  /* --- State views --- */
  .loading {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 8px;
    margin-top: 32px;
    color: var(--vscode-descriptionForeground);
    font-size: 12px;
  }

  /* --- Package list container --- */
  .package-list {
    overflow-y: auto;
    flex: 1;
  }

  /* --- Framework badge (CPM multi-framework) --- */
  .framework-badge {
    display: inline-block;
    font-size: 10px;
    font-weight: 600;
    padding: 1px 5px;
    border-radius: 3px;
    background: var(--vscode-badge-background);
    color: var(--vscode-badge-foreground);
    white-space: nowrap;
    flex-shrink: 0;
  }

  /* ============================================================
     Marketplace surface language
     ============================================================ */
  :host {
    --npm-surface: var(--vscode-sideBar-background, #222222);
    --npm-surface-raised: var(--vscode-editorWidget-background, #252526);
    --npm-border: var(--vscode-panelSection-border, #363636);
    --npm-accent: var(--vscode-button-background, #6c5ce7);
    --npm-accent-fg: var(--vscode-button-foreground, #ffffff);
    --npm-muted: var(--vscode-descriptionForeground, #a0a0a0);
    --npm-radius: 10px;
  }

  .list-header {
    margin: 8px 8px 10px;
    padding: 13px 14px 12px;
    border: 1px solid var(--npm-border);
    border-radius: var(--npm-radius);
    background: linear-gradient(135deg, var(--npm-surface-raised), var(--npm-surface));
  }

  .list-title {
    font-size: 18px;
    font-weight: 700;
    letter-spacing: -0.1px;
  }

  .list-subtitle {
    font-size: 11px;
    color: var(--npm-muted);
    margin-top: 3px;
  }

  .list-actions {
    gap: 8px;
  }

  button.primary-btn {
    border-radius: 8px;
    padding: 6px 12px;
    font-weight: 600;
    background: linear-gradient(135deg, var(--npm-accent), var(--vscode-button-hoverBackground));
    box-shadow: 0 3px 10px color-mix(in srgb, var(--npm-accent) 30%, transparent);
  }

  button.secondary-btn,
  button.ghost-btn {
    border-radius: 8px;
    padding: 6px 11px;
  }

  .group-header {
    margin: 10px 8px 4px;
    padding: 7px 4px;
    position: static;
    background: transparent;
    border-bottom: 1px solid var(--npm-border);
    font-size: 10px;
    letter-spacing: 0.8px;
  }

  .group-count {
    padding: 2px 7px;
    border-radius: 9px;
  }

  .info-banner {
    margin: 6px 8px;
    padding: 9px 11px;
    border-radius: 8px;
    background: var(--npm-surface-raised);
    border-color: var(--npm-border);
  }

  .chip,
  .tfm-badge {
    border-radius: 999px;
    padding: 3px 7px;
    background: color-mix(in srgb, var(--vscode-badge-background) 70%, transparent);
    border-color: var(--npm-border);
  }

  .empty,
  .error {
    border-radius: var(--npm-radius);
    background: var(--npm-surface-raised);
    border-color: var(--npm-border);
  }

  select,
  input[type="text"],
  input[type="search"] {
    border-radius: 8px;
  }
`;
