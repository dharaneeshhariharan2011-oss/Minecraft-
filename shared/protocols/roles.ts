/**
 * Permission roles inside a hosted session.
 *  - host:     the player who created the session (full control)
 *  - operator: may edit blocks, kick and ban members and change roles below operator
 *  - member:   normal friend, may build and break blocks and chat
 *  - visitor:  may watch and chat, cannot modify blocks
 *  - banned:   cannot (re)join the session
 */
export const ROLES = ['host', 'operator', 'member', 'visitor', 'banned'] as const;
export type Role = (typeof ROLES)[number];

export function isRole(value: unknown): value is Role {
  return typeof value === 'string' && (ROLES as readonly string[]).includes(value);
}

/** Numeric rank: higher means more power. Banned is the lowest. */
export function roleRank(role: Role): number {
  switch (role) {
    case 'host':
      return 4;
    case 'operator':
      return 3;
    case 'member':
      return 2;
    case 'visitor':
      return 1;
    case 'banned':
      return 0;
  }
}

export function canEditBlocks(role: Role): boolean {
  return role === 'host' || role === 'operator' || role === 'member';
}

export function canChat(role: Role): boolean {
  return role !== 'banned';
}

export function canJoin(role: Role): boolean {
  return role !== 'banned';
}

/** Whether `actor` may kick, ban or change the role of `target`. */
export function canModerate(actor: Role, target: Role): boolean {
  if (actor !== 'host' && actor !== 'operator') return false;
  if (target === 'host') return false;
  return roleRank(actor) > roleRank(target);
}

/** Whether `actor` may grant `newRole` to a player (the host is never grantable). */
export function canAssignRole(actor: Role, newRole: Role): boolean {
  if (newRole === 'host') return false;
  if (actor === 'host') return true;
  if (actor === 'operator') return newRole !== 'operator';
  return false;
}
