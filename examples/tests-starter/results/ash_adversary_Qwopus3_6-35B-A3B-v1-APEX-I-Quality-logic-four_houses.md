# Logic Puzzle Solution: Four Suspects in Four Houses

## Step-by-Step Reasoning

### Phase 1: Anchoring fixed positions

**Clue 1:** The Baker lives in House 1.
→ House 1: Profession = **Baker**

**Clue 3:** Corey lives in House 4.
→ House 4: Name = **Corey**

**Clue 6:** The person in House 2 wears a green hat.
→ House 2: Hat = **green**

**Clue 9:** The person wearing the yellow hat lives in House 3.
→ House 3: Hat = **yellow**

At this point, the hat colors for Houses 1 and 4 remain undetermined. The two remaining hat colors are red and blue.

---

### Phase 2: Placing the Painter/Iguana/Blue-hat triplet

**Clue 4:** The Painter owns an iguana and wears a blue hat.
These three attributes (Painter, iguana, blue hat) belong to the same person/house.

Since Houses 2 and 3 have known hat colors (green and yellow), the blue hat must be in House 1 or House 4.

- If blue hat were in House 1, the Painter would be in House 1 — but House 1 is the Baker. Contradiction.
- Therefore, **blue hat is in House 4**, making House 4: **Painter, iguana, blue hat**.

Consequently, **red hat is in House 1**.

Updated grid:

| House | 1          | 2        | 3        | 4            |
|-------|------------|----------|----------|--------------|
| Name  | ?          | ?        | ?        | **Corey**    |
| Prof  | **Baker**  | ?        | ?        | **Painter**  |
| Pet   | ?          | ?        | ?        | **iguana**   |
| Hat   | **red**    | **green**| **yellow**| **blue**     |

---

### Phase 3: Locating the ferret and Gardener

**Clue 2:** The person wearing the red hat lives directly next to the owner of the ferret.
Red hat is in House 1, so the ferret owner must be in **House 2** (the only neighbor of House 1).

→ House 2: Pet = **ferret**

**Clue 8:** The Gardener lives directly next to the house with the ferret.
Ferret is in House 2, so the Gardener is in House 1 or House 3.
House 1 is the Baker, so the Gardener must be in **House 3**.

→ House 3: Profession = **Gardener**

---

### Phase 4: Placing the Chef/Bram

**Clue 11:** The Chef does not live in House 1 or House 4.
**Clue 7:** Bram is the Chef.

Chef cannot be in House 1 (Baker) or House 4 (Painter), so Chef is in House 2 or House 3.
House 3 is the Gardener, so **Chef is in House 2**.

Therefore, **Bram is in House 2**.

→ House 2: Name = **Bram**, Profession = **Chef**

Updated grid:

| House | 1          | 2          | 3          | 4            |
|-------|------------|------------|------------|--------------|
| Name  | ?          | **Bram**   | ?          | **Corey**    |
| Prof  | **Baker**  | **Chef**   | **Gardener**| **Painter**  |
| Pet   | ?          | **ferret** | ?          | **iguana**   |
| Hat   | **red**    | **green**  | **yellow** | **blue**     |

Remaining names for Houses 1 and 3: **Aria** and **Dana**.
Remaining pets for Houses 1 and 3: **cat** and **dog**.

---

### Phase 5: Assigning names and remaining pets

**Clue 10:** Dana owns a dog.
**Clue 5:** Aria lives somewhere to the left of the person who owns the cat.

There are two possible arrangements:

#### Arrangement A: Dana in House 1 (with dog), Aria in House 3 (with cat)
- House 1: Aria/House 1 with **dog** → No, Dana owns dog, so House 1 = Dana + dog.
- Then House 3 = Aria + cat.
- Check clue 5: Aria (House 3) lives to the left of cat owner (House 3) → **Fails** — Aria is the cat owner herself; she cannot be to the left of herself.

#### Arrangement B: Aria in House 1 (with cat), Dana in House 3 (with dog)
- House 1: Aria + cat.
- House 3: Dana + dog.
- Check clue 5: Aria (House 1) lives to the left of cat owner (House 1) → **Fails** — same problem.

In both arrangements, Aria and the cat end up in the same house, violating clue 5 ("Aria lives somewhere to the left of the person who owns the cat"), since one cannot be to the left of oneself.

---

## Conclusion

After exhaustive deduction, **no valid solution exists** that satisfies all eleven clues simultaneously under the standard interpretation of logic puzzles.

The root cause of the inconsistency is as follows:

1. Clues 1–4, 6, 8–9, and 11 tightly constrain the puzzle such that the only degrees of freedom remaining after placing the Baker, Painter, Chef, and Gardener are:
   - Which of Aria/Dana occupies House 1 or House 3, and
   - Whether the cat or dog occupies House 1 or House 3.

2. Because Dana must own the dog (clue 10), and the only two unassigned pets are the dog and cat (ferret is in House 2, iguana in House 4), whichever of Aria or Dana gets House 1 automatically gets whichever of dog or cat is placed there.

3. Since the cat can only occupy House 1 or House 3, and Aria must also occupy one of those two houses, **Aria always ends up in the same house as the cat**. This makes it impossible for Aria to be "somewhere to the left of" the cat owner.

All other clues are satisfied in every arrangement attempted. The conflict arises solely between clue 5 and the combined effect of clues 1–4, 6, 8–11, and 10.

---

## Closest Possible Solutions (each violates exactly one condition — clue 5):

### Option 1 (violates clue 5):
| House | 1              | 2              | 3              | 4                |
|-------|----------------|----------------|----------------|------------------|
| Name  | **Dana**       | **Bram**       | **Aria**       | **Corey**        |
| Prof  | Baker          | Chef           | Gardener       | Painter          |
| Pet   | dog            | ferret         | cat            | iguana           |
| Hat   | red            | green          | yellow         | blue             |

### Option 2 (violates clue 5):
| House | 1              | 2              | 3              | 4                |
|-------|----------------|----------------|----------------|------------------|
| Name  | **Aria**       | **Bram**       | **Dana**       | **Corey**        |
| Prof  | Baker          | Chef           | Gardener       | Painter          |
| Pet   | cat            | ferret         | dog            | iguana           |
| Hat   | red            | green          | yellow         | blue             |

Both options satisfy ten of the eleven clues perfectly. The only clue violated in each case is clue 5, since Aria shares her house with the cat owner.
