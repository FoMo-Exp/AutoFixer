import type { ReactElement } from "react";
import type { AuthMembership } from "../../electron/auth";
import { Select } from "../ui/Select";

interface WorkspaceSwitcherProps {
  memberships: AuthMembership[];
  selected?: AuthMembership;
  onChange: (workspaceId: string) => void;
}

/**
 * A display scope only. Server-side authorization still comes from the
 * session's membership; the selected id is never sent as proof of access.
 */
export function WorkspaceSwitcher({
  memberships,
  selected,
  onChange,
}: WorkspaceSwitcherProps): ReactElement {
  const options = memberships.map((membership) => ({
    value: membership.workspace_id,
    label: `${membership.workspace_id} · ${membership.role}`,
  }));
  return (
    <div className="workspace-switcher">
      <span className="workspace-switcher-label">Workspace</span>
      <Select
        id="workspace-switcher"
        ariaLabel="Workspace"
        value={selected?.workspace_id ?? ""}
        options={options}
        onChange={onChange}
        className="workspace-switcher-select"
      />
    </div>
  );
}
