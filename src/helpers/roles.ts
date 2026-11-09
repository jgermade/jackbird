// The roles of an instance (S3, 21:32 as renamed at 11:57): each includes the
// ones before it. The service enforces them; the interface only hides what a
// role may not do. See RECORD/2026-08-11.musikmatch-rust-migration.WIP.md.

export const ROLES = ["listener", "editor", "admin", "owner"] as const;

export type Role = (typeof ROLES)[number];

/** Whether `role` includes `least`. */
export function atLeast(role: Role | null | undefined, least: Role): boolean {
  return role ? ROLES.indexOf(role) >= ROLES.indexOf(least) : false;
}

/** Whether `actor` may add, change or remove someone with `role`: admins up to editor, owners anyone. */
export function canManage(actor: Role | null | undefined, role: Role): boolean {
  return actor === "owner" || (actor === "admin" && atLeast("editor", role));
}

/** The roles `actor` may give. */
export function assignable(actor: Role | null | undefined): Role[] {
  return ROLES.filter((role) => canManage(actor, role));
}
