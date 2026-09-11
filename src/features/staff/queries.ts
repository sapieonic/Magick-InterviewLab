import 'server-only';
import { prisma } from '@/lib/db/prisma';
import { can, STAFF_ROLES } from '@/features/auth/capabilities';
import type { Role } from '@/generated/prisma/enums';

/**
 * Read models for the staff half of the user table.
 *
 * Same house rule as `features/candidates/queries.ts`, and for the same
 * reason: every `select` is explicit, because a `select`-free query on `User`
 * hands the Argon2 hash to whatever renders the row.
 */

export interface StaffRow {
  id: string;
  name: string;
  email: string;
  role: Role;
  isActive: boolean;
  mustChangePassword: boolean;
  lastLoginAt: Date | null;
  createdAt: Date;
  /** Applications they are accountable for, so an admin can see what would be
   *  orphaned before deactivating or demoting someone — both of which are on
   *  the settings table this feeds. */
  ownedApplicationCount: number;
  panelSeatCount: number;
}

export async function listStaff(): Promise<StaffRow[]> {
  const rows = await prisma.user.findMany({
    where: { role: { in: [...STAFF_ROLES] } },
    orderBy: [{ role: 'asc' }, { name: 'asc' }],
    select: {
      id: true,
      name: true,
      email: true,
      role: true,
      isActive: true,
      mustChangePassword: true,
      lastLoginAt: true,
      createdAt: true,
      _count: { select: { ownedApplications: true, panels: true } },
    },
  });

  return rows.map((row) => ({
    id: row.id,
    name: row.name,
    email: row.email,
    role: row.role,
    isActive: row.isActive,
    mustChangePassword: row.mustChangePassword,
    lastLoginAt: row.lastLoginAt,
    createdAt: row.createdAt,
    ownedApplicationCount: row._count.ownedApplications,
    panelSeatCount: row._count.panels,
  }));
}

export interface PanelCandidate {
  id: string;
  name: string;
  email: string;
  role: Role;
}

/**
 * Who may be put on a panel.
 *
 * Every staff role currently holds `GIVE_FEEDBACK`, so this is "active staff"
 * today. It is still asked of the grant table rather than hard-coded, so that
 * a future role without the capability drops out of the picker by itself
 * instead of producing seats `addPanelistAction` then refuses — the two must
 * agree, and the table is where they agree. Deactivated accounts are excluded:
 * a seat is an obligation to write a scorecard, and someone who cannot sign in
 * cannot meet it.
 */
export async function listStaffForPanel(): Promise<PanelCandidate[]> {
  const rows = await prisma.user.findMany({
    where: { role: { in: [...STAFF_ROLES] }, isActive: true },
    orderBy: [{ name: 'asc' }],
    select: { id: true, name: true, email: true, role: true },
  });
  return rows.filter((row) => can(row.role, 'GIVE_FEEDBACK'));
}

export interface ApplicationOwner {
  id: string;
  name: string;
  email: string;
  role: Role;
}

/**
 * Staff who may own an application.
 *
 * Asked of the grant table for the same reason `listStaffForPanel` is, rather
 * than hard-coding the three roles that hold `MANAGE_PIPELINE` today: an owner
 * is the person accountable for moving the application along, so the set is
 * exactly "who may move one". Listing the roles by hand meant a role added to
 * or dropped from the capability had to be remembered here too, and the one
 * place the two could disagree is a picker that offers an owner every write
 * path would then refuse.
 *
 * Its own type rather than `PanelCandidate`: an owner is not a panel candidate,
 * and the two answer different questions even where the rows coincide.
 */
export async function listApplicationOwners(): Promise<ApplicationOwner[]> {
  const rows = await prisma.user.findMany({
    where: { role: { in: [...STAFF_ROLES] }, isActive: true },
    orderBy: [{ name: 'asc' }],
    select: { id: true, name: true, email: true, role: true },
  });
  return rows.filter((row) => can(row.role, 'MANAGE_PIPELINE'));
}
