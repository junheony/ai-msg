# BRIEF10c UI decisions

Extend the existing Yapping page tokens and type scale. The chart uses the page's
mode ink for views, link color for posts, and foreground for followers, with the
same raised background, muted annotations, and border already used by feeds.
Keep labels left aligned in the existing Korean UI font; numeric values remain
tabular. Three aligned, compact tracks share a calendar axis and show their own
numeric ranges, avoiding a misleading common scale for views, posts, and people.

Layout: growth tiles → 30-day calendar chart → existing publication feeds.
The chart's distinct feature is truthful gaps: absent follower observations and
missing calendar days interrupt the line. Labels and daily readout remain HTML
text at the inherited mobile size while only plotting marks scale in the SVG.
Review against brief: preserve page hierarchy and avoid introducing a new card
or typography system. Separate scales retain visible post bars when views are
orders of magnitude larger. Today is visibly an incomplete daily bucket.

Validation: `npm test -- src/ui/hub/YappingHome.test.tsx` passed all 8 tests.
Coverage includes null followers, zero bars, missing calendar dates, KST rollover,
failure isolation, and keyboard-focus readout. The root typecheck identified strict
array-index types; the fixed 30-slot invariant is now explicit and date labels use
safe iteration. Final full typecheck, suite, build, and captures are owned by root.
