# sudoku.coach Anti-Chess Auto-Eliminate

A Chrome extension that extends sudoku.coach's automatic candidate elimination
("AUTO" in the Candidate Helpers panel) to **Anti-Knight**, **Anti-King** and
**Nonconsecutive** puzzles.

The site removes a placed digit from the candidates of its row, column and box.
This extension additionally removes it from every cell a knight's move away
(Anti-Knight) and every diagonally adjacent cell (Anti-King), and for
Nonconsecutive puzzles removes the two adjacent digits (d−1 and d+1) from the
orthogonal neighbours of a placed digit d. It also cleans up after "Fill all
Cell Candidates", which the site fills without regard to those constraints.

## Install (unpacked)

1. Open `chrome://extensions` and turn on **Developer mode** (top right).
2. Click **Load unpacked** and pick this folder.
3. Open any Anti-Knight / Anti-King puzzle on sudoku.coach, for example
   <https://sudoku.coach/en/s/JCDs>, and turn on the site's candidates as usual.

A small badge at the bottom right of the page shows which rules are active and
how many candidates have been removed. The toolbar popup lets you disable the
extension, hide the badge, or force each rule on/off instead of auto-detecting.

## How it works

- The puzzle's rules are auto-detected from the constraint names the site
  prints on the page ("Anti-Knight", "Anti-King", "Nonconsecutive", plus
  common translations).
- The grid is read from the site's SVG geometrically (grid lines, digit
  positions, font sizes), so it does not depend on the site's minified class
  names.
- Candidates are removed by driving the site's own input: the affected cells
  are selected with synthetic mouse events and the digit is toggled with the
  site's `Ctrl + digit` shortcut. Each removal is therefore a normal move in
  the site's history and can be undone with `Ctrl + Z`.
- After you undo, the extension does not re-remove the same candidates until
  the placed digits change, so undo can step back through your own moves.
  One placement can produce one extension move per affected digit (for
  example a Nonconsecutive puzzle removes d−1, d+1 and d), so it may take a
  few Ctrl+Z presses to get back to the placement itself.

## Error warnings

When "Warn when a correct candidate is removed" is on (default), the extension
compares the candidates after every change with the previous state. If a
candidate disappears from an empty cell and that digit is the cell's solution
value, a red toast appears at the top of the page and the cell flashes red for
a few seconds. This catches a slip while pencil-marking, and also the case
where a wrong placed digit makes the site's (or this extension's) automatic
elimination wipe out the right candidate somewhere else.

For shared puzzles (`/s/<id>` links) the solution is fetched from the site's
own puzzle API; for classic puzzles with the 81-digit URL it is solved locally. It is only used
while it agrees with the digits on the board, so nothing is reported when no
solution is known; the badge then shows "no solution". Clearing many cells at
once (e.g. the "clear all candidates" button) is not treated as an error.

## Limitations

- Only 9×9 (or smaller) grids with digits 1–9 are handled.
- Corner (box) marks are not touched; only centre candidates are removed.
- Auto-detection relies on the rule names shown on the page. If a puzzle's
  rules are only described in free text, use "Always on" in the popup.
- The extension acts on whatever digits are on the board, including wrong
  entries, exactly like the site's own AUTO elimination.
