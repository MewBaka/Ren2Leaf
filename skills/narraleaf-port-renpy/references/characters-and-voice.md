# Characters, aliases and voice

Who speaks is the one thing a converter cannot get from a lookup table. A commercial Ren'Py game
names its speakers for the engine's convenience, not after its cast: in one finished game, **52
variables had dialogue and six of them were people**. Build the cast from evidence, and show the
author what the evidence was.

None of the writing below is against the rules - Ren'Py simply has no better way to do these things,
so most finished games do them.

## 1 - One person, several `Character` variables

`Character(image="…")` binds a side image to the *variable*, so a second sprite set (an outfit, a
chibi, a later arc) means a second `Character`. The display name is what the player sees, so start
there.

1. **Group the variables by display name.** One group is one Studio character, whatever the
   variable names look like. Counting variables instead gives a cast several times too large.
2. **Each variable in the group carries one sprite set**: its `image=` tag, or, when it has none,
   the tag standing on the stage while it speaks. That set becomes the poses of the one character.
3. **Enumerate poses per tag**, from the attribute combinations that tag actually has
   (`statement-mapping.md` → "Image attributes"). Do not try to name poses after the attributes.
4. **Dialogue binds to the character; the picture comes from the stage model.** Which image a line
   shows is decided by resolving `show <tag> <attrs>`, not by which variable spoke.
5. **A variable's sprite tag is often unrelated to its name.** A chibi or an outfit set lives on its
   own tag with its own spelling; the only reliable signal is which tag is on stage when that
   variable speaks. Tabulate `variable → tags seen while speaking, with counts` and read it.
6. **An `image=` tag may have no files at all** (a cut character, a leftover). Record it under
   "Needs the author" and carry on; do not invent art.

Log the table (`log_note`) before you merge anything, and let the author confirm the
grouping. A wrong merge is expensive once voice is linked.

## 2 - Aliases: the same person under another name box

Games rename a speaker while the player does not know them yet (`???`), or while they appear
masked, in silhouette, or in another role. In Ren'Py that is another variable with another display
name, sometimes with the name blanked out in the text as well (`██`).

`/rename` on one character is the right port **only when the alias is that character and nothing
else**. Prove it first.

**The hard evidence is the voice take numbering, not the folder name.** A voice actor's takes
usually run as one series across the whole game, and the author hands parts of that series to
different name boxes. Two variables sharing one unbroken series are one person.

```
voice/vo_p  takes 1-107    p1 1-26    u0 27-68    k2 32-107    (empty box) e2/e3 31-59
voice/vo_q  takes 1-83     q4 1-5     q5 6-27     u0 28-58     k7 33-82
```

Read it as: `k2` is `p1`, `k7` is `q4`, and `u0` is a box both of them use. A folder named after a
character is a guess; a shared take series is a fact.

- **Take parsing:** a number in brackets wins - `vo_q(6)-2.mp3` is take 6 recorded twice, not take
  2. Only without brackets does the trailing number count.
- **Second evidence: complementary distribution.** An alias usually appears exactly where the real
  name box does not (one chapter, one flashback). Check it per chapter; it catches the cases where
  takes were re-numbered.
- **One alias variable can hold several people.** Resolve it per line from that line's voice file,
  not per variable, and split the lines between the real characters. A variable with takes from two
  series is the sign.
- Show the author, for every alias: **folder, take range, line count and the chapters it appears
  in**. A list of folder names alone reads as if you guessed from the spelling.

When the alias is genuinely a later-revealed name for one character, port it as a rename at the
point the game does it. When it mixes people, or the author wants the mask kept, keep separate
Studio characters and say so in the hand-over.

## 3 - Empty name boxes are narration

Variables whose display name is the empty string are a typographic device - black-screen captions,
an inner-monologue look, an unseen narrator. **Do not create characters for them.** Map them to
narration rows, with the dialogue look the game gives them
(`interface.md` → the per-mode dialogue styles).

Two things to check before you do:

- They often carry voice too, and sometimes from several people. Link those takes to the narration
  rows as usual; list the ones you could not attribute.
- A file that defines such a box may still contain the author's own demo lines, left in the source
  and never played. Lines no label can reach are not part of the port.

## 4 - Speakers that stay a bare name

A speaker the author chose not to make a character (the supplement's 临时角色, a one-off passer-by)
is written as `Name: text` with a name no character answers to. That is a valid line, and **it can
carry voice**: since Studio 1.8.0 the voice table, the recording script and the file-name rule name
such a line by its own name, and `voice_list` / `voice_link` treat it like any other line. Link its
takes the same way. `voice_status` counts its lines under that name, and `voice_list {character}`
takes the name.

What it does not get, because these hang off a character:

- its own voice volume - its takes play on the plain voice track;
- a voice actor entry (the casting list is per character).

So a bare name is not a reason to drop a voice take, and a take is not by itself a reason to create
a character. Create one (no sprite needed) only when the speaker needs either of the two above, or
the author asks.

## 5 - What needs the author

- **Two speakers in one row.** A display name like `A/B` on a single line has no `.story` spelling:
  one row, one speaker. List each occurrence with its text; the author decides how to split it.
- **A POV character whose name box changes by chapter** (a title in the main story, "I" in a
  flashback) is one Studio character; port the change as a rename and confirm the reading.
- Any variable you could not place in a group, and any group with no sprite tag.

## 6 - Order of work

Resolve the cast *before* generating story rows: a merge or a split afterwards costs a
regeneration, and after voice is linked a regeneration orphans the takes (the port `SKILL.md`,
step 6). Link voice last, by scene and line order from your IR, and keep the variable → character
decision table in the port log (`log_note`) so a successor can see why the cast looks the way it does.
