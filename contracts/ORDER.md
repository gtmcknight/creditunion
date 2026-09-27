# Burn order: how a Credit Union decides where each Credit goes

Every Credit Union knows the exact order its 80 Credits burn in, before anyone deposits. Nobody picks it at burn
time: the rule is fixed when the Credit Union opens, the contract computes the order itself, and `assemble()`
hands that exact list to the adapter, which must not reorder it (see [ADAPTER.md](ADAPTER.md)).

Read it any time:

```
cast call <union> "burnOrder()(uint256[])"   # the Credit ids, slot 1 first
cast call <union> "layout()(uint8[80])"      # Layout unions: what each slot is painted with
cast call <union> "arrangement()(uint8)"     # which rule this union uses
```

## The rules

| `arrangement` | Name | Order |
|---|---|---|
| 0 | Deposit | The order people deposited. Leaving moves everyone behind you up one. |
| 2 | Number | By Credit number, low to high. |
| 5 | NumberDesc | By Credit number, high to low. |
| 4 | Layout | A design painted when the Credit Union is created (below). |

1 (MintTime) and 3 (Creator) are retired. New Credit Unions can't choose them.

## Layout: painting the sheet

A Layout union paints **one trait** across the 80 slots (`layoutTrait`). Each slot holds a small number for
that trait, or `0` for any Credit. One trait per union: you can't have a Colors row next to a Print row.

| `layoutTrait` | Trait | Slot numbers |
|---|---|---|
| 0 | Colors | Add up the inks: C = 1, M = 2, Y = 4, K = 8. So 4 = Y only, 9 = C+K, 15 = all four. |
| 1 | Eights | Number of eights + 1: 1 = none, 2 = one, up to 6. |
| 2 | Print | 1 Registered, 2 Nudge, 3 Slip, 4 Skew, 5 Drift, 6 Loose. |
| 3 | Weight | 1 even, 2 lean, 3 sparse, 4 extreme. |
| 4 | Plates | Number of inks, 1 to 4. |

The 80 numbers are packed 4 bits each into `Filter.layout0` (slots 1 to 64) and `Filter.layout1` (65 to 80),
set once at creation and never changed. The union's other filters (number range, rating, Bits) still decide
who can join at all.

**Depositing.** The contract reads the Credit's traits from Jack's art contract (`_keyOf`), turns the painted
trait into its number, and takes the Credit only if a slot with that number, or a free `0` slot, is left.
`canTake(ids)` answers that before you send.

**Placing.** `layoutOrder()` fills each painted slot with the earliest-deposited Credit of its number, then
fills the `0` slots with everything else in deposit order. Once the union is full the sheet is always complete.

**Before it's full,** `burnOrder()` returns only as many slots as there are deposits, and a painted slot with
no matching Credit yet reads `0`. At 80 it's the whole sheet.

## Filters vs order

Score, payment time, Credit number, Bits and the allowlist decide **who can join**, not where a Credit goes. Only
the Layout traits above can be painted.

| Filter | Who can join | Painted? | Sets the order? |
|---|---|---|---|
| Score (`minScore`, `maxScore`) | Official rating range, e.g. 90.0 and up | No | No |
| Time paid (`paidFrom`, `paidTo`) | Credits paid for inside a window | No | Through Number: on mainnet Credit numbers follow payment time |
| Credit number (`idFrom`, `idTo`) | A number range | No | Number, NumberDesc |
| Bits (`bitsFrom`, `bitsTo`) | Marks on the Credit, 0 to 256 | No | No |
| Allowlist | Up to 200 named Credits | No | No |
| Colors, Print, Weight, Eights | Which values are allowed | Yes, plus Plates | Only through a Layout |

So a "90+ only" union can be painted by color or ordered by number, but there's no score gradient and no
best-to-worst order.

## Example: "Black Frame" on Sepolia

[`0x400c…7173`](https://sepolia.etherscan.io/address/0x400cdaE9b9E54F82905ab381f9CD51ed7B977173), Colors,
a C+K frame (`9`) around an any-Credit middle (`0`). `layout()`, 8 across by 10 down:

```
row  1:  9  9  9  9  9  9  9  9
row  2:  9  0  0  0  0  0  0  9
 …       (same through row 9)
row 10:  9  9  9  9  9  9  9  9
```

`burnOrder()` at 52 of 80 (2026-09-27):

```
row  1:   153   227   337   347     0     0     0     0
row  2:     0     1     2     3   240   142   239     0
row  3:     0   144   145   146   147   238   149     0
row  4:     0   150   151   237   154   236   156     0
row  5:     0   235   158   234   160   161   162     0
row  6:     0   163   233   232   166   167   168     0
row  7:     0   231   170   230
```

Four C+K Credits have come in (153, 227, 337, 347) and took the first four frame slots. The `0`s on the edge are
frame slots still waiting for one. Everything else fills the middle in deposit order.

To paint a yellow row over a cyan row, row 1 is `4 4 4 4 4 4 4 4` and row 2 is `1 1 1 1 1 1 1 1`.

## Open: slot to sheet position

Slot 1 is the first id in the list. We read it as top left, filling rows left to right, 8 across and 10 down.
**Guess:** Jack's Statement contract decides how list position maps onto its sheet, and it hasn't shipped. When it
does, check this before proposing the adapter. If it fills by column or from the bottom, the adapter reorders
the ids so a painted row still prints as a row.
