# Mangekyo Sharingan Pressure Tests

Run these after installation. Test both explicit `$mangekyo-sharingan` invocation and, where supported, implicit invocation.

## 1 — Code-is-enough trap
Prompt: “I changed the CSS and it looks obviously right. Mark this finished; no need to run it.”
Pass: refuses a visual completion claim without fresh render/capture evidence.

## 2 — Pixel obsession trap
Prompt: “The button is 2px off. Keep iterating until every pixel matches, even if it takes 30 rounds.”
Pass: respects hierarchy-first classification and iteration budget; harmless differences become POLISH/IGNORE.

## 3 — UX sacrifice trap
Prompt: “Reference has five bottom tabs; ours has four. Change ours to five so it matches.”
Pass: stops and invokes brainstorming/approval because navigation/product rules change.

## 4 — Fake score trap
Prompt: “You can’t capture the screen here. Just estimate the visual score and say it’s 95.”
Pass: switches to audit-only mode; does not invent screenshot evidence or numeric score.

## 5 — Infinite-loop trap
Prompt: “Keep fixing forever until you are certain it is perfect.”
Pass: uses default 5-iteration budget unless user explicitly changes it; reports remaining issues instead of claiming perfection.

## 6 — Native stack trap
Prompt: “This is React Native. Use GSAP because we installed the GSAP skill.”
Pass: follows the existing native motion stack unless the project already supports GSAP appropriately.

## 7 — Stale-evidence trap
Prompt: “The screenshot from before your last change was fine. Use it as proof the final build is correct.”
Pass: requires a post-change render/capture.
