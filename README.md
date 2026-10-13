# Daily Red

A daily Pokémon Emerald challenge that runs in your browser. Every day you get six random, fully evolved Pokémon at level 100 with the best moves each one can learn, and no type appears twice on the team. You start a couple of steps below Red on a snowy summit. Red has his original team and moves from Gold and Silver, raised to level 100.

**Play:** https://emanuelebermani.github.io/daily-red/

**Everyone's results:** [results.txt](results.txt)

## How it works

* The page runs the real Pokémon Emerald engine inside a JavaScript GBA emulator ([gbajs](https://github.com/endrift/gbajs)), so the overworld, menus, battles, animations and music are the genuine GBA ones.
* You load your own copy of Pokémon Emerald (USA/Europe, game code BPEE). This repository contains no game data, and the ROM never leaves your browser. It is kept in the browser's storage so you only load it once.
* When you press start, the page patches a copy of the ROM in memory: Red's trainer data and party, his script, and the Mt. Pyre summit, renamed MT. SILVER, with snow and no music. It then writes a save file that places you two steps below Red with today's team, and skips the title screen.
* Today's team comes from the date, so everyone playing on the same day gets the same six Pokémon. Moves are chosen from level up, TM and HM, move tutor, egg moves and earlier evolutions, scored against Red's actual team.

## Results

After your first finished battle each day, the game shows a button that opens a prefilled GitHub issue. Submitting that issue runs a GitHub Action that checks the result, adds one line to [results.txt](results.txt) and closes the issue with a reply. Only the first result per GitHub account per day is recorded. Results are on the honour system, and you need a free GitHub account to submit one.

If you lose, the game puts you back at the start of the summit so you can practise. Only your first finished battle of the day counts.

## Controls

| Key | GBA button |
| --- | --- |
| Arrow keys | D pad |
| Z | A |
| X | B |
| Enter | Start |
| Shift or Backspace | Select |
| A and S | L and R |
| Space (hold) | Fast forward |

Touch controls appear on phones and tablets, and standard gamepads work too.

## Building

The game is a single HTML file. To rebuild `index.html` after changing anything in `src/`:

```sh
python3 tools/build.py OWNER/daily-red
```

The argument is the GitHub repository that collects results.

## Files

* `src/core.js` reads the ROM, picks the daily team and moves, builds the save file and patches the ROM.
* `src/app.js` and `src/page.html` are the page around the game screen.
* `vendor/gbajs/` is the emulator, with its licence in `COPYING`.
* `.github/workflows/record-result.yml` and `.github/scripts/record-result.js` turn result issues into lines of `results.txt`.

## Credits

* gbajs is © 2012 Jeffrey Pfau and is used under its BSD licence (see `vendor/gbajs/COPYING`).
* ROM addresses and data layouts come from the [pret/pokeemerald](https://github.com/pret/pokeemerald) disassembly.

Daily Red is an unofficial fan project. It is not affiliated with or endorsed by Nintendo, Creatures or GAME FREAK. Pokémon and Pokémon Emerald are trademarks of their respective owners.
