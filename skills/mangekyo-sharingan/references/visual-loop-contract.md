# Visual Loop Contract

## Evidence hierarchy

1. Fresh rendered screenshot / simulator capture of the exact target state
2. Functional test/build output relevant to changed behavior
3. Approved `DESIGN.md` / product rules
4. Reference screenshot(s)
5. Source code inspection

A lower item cannot substitute for a higher one when the higher one is required.

## Finding classes

### CRITICAL
Fix before visual completion:
- broken layout, clipping, overlap, safe-area failure
- wrong information hierarchy or primary action
- broken navigation or interaction
- inaccessible contrast/touch target/state
- implementation contradicts approved UX

### IMPORTANT
Fix when it materially weakens the approved direction:
- typography scale or weight hierarchy mismatch
- inconsistent spacing rhythm
- component geometry or visual-weight mismatch
- design-system inconsistency visible to users
- motion/state feedback that confuses intent

### POLISH
Fix only after CRITICAL and IMPORTANT:
- minor optical spacing
- small radius/shadow/line-height refinement
- micro-animation timing
- subtle alignment that does not change hierarchy

### IGNORE
Do not chase:
- harmless pixel differences
- source-brand quirks that do not belong in the product
- differences caused by platform-native controls when UX is correct
- decorative similarity with no user or system value

## One-objective rule

Each iteration chooses one coherent visual objective, e.g. “restore hero hierarchy” or “reduce card density.” A single objective may touch several files if they form one system. Do not mix unrelated polish into the same loop.

## Mobile rule

Use the project’s actual simulator/emulator/device path. Do not force web-only libraries or GSAP into a native mobile stack merely because a motion skill is installed.
