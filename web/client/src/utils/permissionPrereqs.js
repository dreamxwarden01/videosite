// Client mirror of the server's permission-prerequisite logic. The rule map
// (PERMISSION_PREREQS) itself is sent by the server in the roles / edit-user
// GET responses — there is nothing to keep in sync here, only the pure logic
// that consumes it. Same semantics as services/permissionConstants.js.
//
//   effective : { key: bool }   — the resolved granted set
//   prereqs   : { key: [[...alts], ...] }  — AND across groups, OR within a group

// Every effectively-granted permission whose prerequisites aren't met, as
// { [key]: [[...unsatisfiedAlts], ...] } (one entry per key, listing the groups
// still unsatisfied). Empty object = valid.
export function prereqViolations(effective, prereqs) {
  const out = {};
  for (const [key, groups] of Object.entries(prereqs || {})) {
    if (!effective[key]) continue;
    const missing = groups.filter((g) => !g.some((alt) => effective[alt]));
    if (missing.length) out[key] = missing;
  }
  return out;
}

// Keys that must NOT be turned off, because some effectively-granted dependent
// relies on them as the SOLE satisfier of one of its prerequisite groups.
// (For an OR group, a key is only locked while it's the last one standing.)
export function lockedPrereqs(effective, prereqs) {
  const locked = new Set();
  for (const [key, groups] of Object.entries(prereqs || {})) {
    if (!effective[key]) continue;
    for (const g of groups) {
      const granted = g.filter((alt) => effective[alt]);
      if (granted.length === 1) locked.add(granted[0]);
    }
  }
  return locked;
}
