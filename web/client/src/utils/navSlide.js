// Direction of the course-list <-> watch-page slide, or null for every other
// navigation (which stays instant).
//
// Derived from the path pair rather than from the click that caused it, so the
// browser/Android back button and a swipe-back gesture animate exactly like the
// in-page back chevron does. React Router's own `viewTransition` option cannot
// cover those: `navigate(delta)` takes no options, and a history pop never opts
// in, so half the ways out of a video would have been unanimated.
const WATCH = /^\/course\/[^/]+\/watch\/[^/]+\/?$/;
const COURSE = /^\/course\/[^/]+(\/materials)?\/?$/;

export function slideDirection(from, to) {
  if (!from || !to || from === to) return null;
  if (COURSE.test(from) && WATCH.test(to)) return 'vs-slide-in-right';
  if (WATCH.test(from) && COURSE.test(to)) return 'vs-slide-in-left';
  return null;
}
