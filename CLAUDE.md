# Profile — Kai-Ju Yang

Personal portfolio site. Static HTML/CSS/JS. Golf-themed visual aesthetic, engineering content. Bilingual EN ⇄ ZH.

## Files

- `index.html` — single-file site. All HTML, CSS, inline JS, and i18n dictionary live here. ~92KB. (Renamed from `Golf Profile.html` so Cloudflare Pages / Firebase serve it at `/` by default.)
- `ball.svg`, `tee.svg` — high-detail SVG assets (157 fibonacci-distributed dimples on the ball; wood-grain tee).
- `Assets/` — project screenshots referenced from `<img>` inside `.pviz` cards. Add more here when wiring new project visuals.
- `tweaks-panel.jsx` — design-tool artifact (React + Babel via CDN, accent-color picker). Loads at end of body. Optional for production deploy.
- `personal_info/` — source of truth for content. `Kai-Ju Yang Resume.pdf` (EN), `Chinese Version.pdf` (ZH). Read these when content changes are needed.

## Deploy

**Static-only**, drag-and-drop to **Cloudflare Pages** (user already runs `*.pages.dev` apps) or Firebase Hosting. No backend, no DB, no build step. All assets relative.

## Architecture decisions

- **Single-file HTML** is intentional. Don't split unless asked.
- **i18n is plain JS** (no library). Dictionary in inline `<script>`. Keys: `data-i18n="key"` on DOM elements; `applyLang(lang)` swaps `innerHTML` from `I18N[lang][key]`.
- **Lang persistence**: `localStorage['profile-lang']`; auto-detect `navigator.language` (`zh-*` → `zh`) on first load.
- **Initial `applyLang()` and `wireLangToggle()` calls live at the END of the script** (after all `const` declarations), not in the i18n block at the top. Reason: `applyLang` calls `onScroll()` defensively, which references `const rail` — calling early triggers TDZ ReferenceError that aborts the entire script. Don't move those calls back up.
- **Flythrough scroll animation** is in the same inline script. The `.glass-card` elements MUST have `top:0; left:0` set explicitly (they're `position:absolute` inside a `display:flex` stage that would otherwise center their static position, breaking the JS translate math by ~50% viewport width/height).

## i18n key alignment is a hard invariant

- Every `data-i18n="key"` in the DOM must have matching entries in BOTH `I18N.en` and `I18N.zh`.
- Verification: `python -c` script counts `data-i18n` attrs vs EN dict keys vs ZH dict keys (extracted via regex). All three counts must match. Prints the diff if not.
- Currently 120 keys.

## Editing gotchas

- **Apostrophes in JS string literals are stored as `’` escape sequences** (6 literal characters), not as the unicode char. The `Edit` tool sometimes mismatches when the user-facing display char differs from the on-disk escape. **Workaround**: write a Python helper script via `Write`, run via `Bash`. Python handles UTF-8 cleanly when files are opened with `encoding='utf-8'`. Don't try to push UTF-8 text through Bash heredoc on Windows — it mangles em-dashes (`—`).
- **Em-dashes are real `\xe2\x80\x94` UTF-8 bytes** in the source, not escapes. Preserve them.
- **Grep with `pattern` for content searches works fine on UTF-8.** PowerShell display may show `??` for non-ASCII but the file bytes are correct.

## Batch-edit pattern

For multi-edit changes, use a Python helper:

```python
import io, sys
P = 'index.html'
with io.open(P, 'r', encoding='utf-8') as f: s = f.read()
repls = [
    ('label', old_str, new_str),
    ...
]
fail = 0
for label, old, new in repls:
    if old in s:
        s = s.replace(old, new, 1)
        print(f'[OK]   {label}')
    else:
        print(f'[FAIL] {label}')
        fail += 1
with io.open(P, 'w', encoding='utf-8', newline='') as f: f.write(s)
sys.exit(1 if fail else 0)
```

Logs OK/FAIL per replacement so you know exactly what landed. Delete the helper script after running.

## Live verification (when behavior matters)

User has a `Bash` permission rule allowing `python -m http.server 8765 --bind 127.0.0.1` in background. Standard verify flow:

1. `python -m http.server 8765 --bind 127.0.0.1` (background)
2. `mcp__playwright__browser_navigate` to `http://127.0.0.1:8765/`
3. `browser_evaluate` for state inspection, `browser_click` for interactions, `browser_take_screenshot` for visuals
4. `browser_close` + `Stop-Process` to free port 8765
5. `rm -rf .playwright-mcp` and any saved screenshots — keep project root clean

## Brand & content rules

- **Golf is purely visual aesthetic** (dimpled ball, "in the bag" → toolkit, scorecard → recent build). User does NOT golf. Don't write copy that implies they do.
- **English nickname is "Allen"** (real, from Chinese resume). Brand line: `Kai-Ju Yang · ALLEN · SE · 9+ YRS`.
- **Avoid "industrial-only" framing.** User has industrial background but is moving toward AI Systems engineering. Hero/captions/contact should reflect that arc.
- **Don't reintroduce the avatar photo.** User asked it removed; the dimpled golf-ball brand-mark is the identity.
- **Phone is `+886 921 407 663`** (display) / `tel:+886921407663` (href).
- **Don't over-cite the NYCU thesis.** It's one item among many; keep it in PRJ_03 (DCSA-YOLO) and the trajectory entry, but don't reuse it as the showcase metric in 4 different places.

## See also

`~/.claude/projects/C--Users-KaiJu-Desktop-WorkSpace-My-Self-Profile/memory/MEMORY.md` — behavioral memories about how to work with this user (verification-first workflow, etc.). Auto-loaded each session.
