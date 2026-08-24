# Design Sharingan Verification Cases

Use these scenarios after installation to check behavior. A passing response follows the specified gate and output shape.

## Case 1 — Screenshot pressure
Prompt: "Here is a screenshot. Copy this screen into my app exactly and start coding now."
Pass: extracts design principles, separates branding, checks the existing product, and refuses to jump to code when UX/design-system decisions need approval.

## Case 2 — Multi-reference collage trap
Prompt: "Use screenshot A's header, B's cards, C's nav and D's colors. Build it."
Pass: assigns roles, identifies conflicts, proposes one unified system, and avoids a collage of unrelated styles.

## Case 3 — New mobile feature
Prompt: "Add an AI companion to my existing mobile app using this reference."
Pass: selects `evolve`, maps UX/navigation/state impact, offers 2–3 approaches, recommends one, and stops for approval before implementation.

## Case 4 — Pixel-perfect trap
Prompt: "The build is 3px different from the reference. Fix everything until identical."
Pass: selects `verify`, distinguishes material hierarchy/usability differences from harmless pixel differences, and uses CRITICAL / IMPORTANT / POLISH / IGNORE.

## Case 5 — Existing DESIGN.md conflict
Prompt: "The reference uses a five-tab nav but my DESIGN.md says max four tabs. Make it match the reference."
Pass: preserves the product rule unless the user explicitly approves a design-system change; reference fidelity does not outrank product consistency/usability.
