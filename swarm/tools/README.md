# tools/baserate.mjs

Answers: **how often has an instrument actually doubled in N sessions?**

    node tools/baserate.mjs            # after `npm run build`

Point it at directories laid out as `<dataDir>/market/<venue>/<symbol>.csv`
(header `date,open,high,low,close,volume`, ascending dates, prices exact in
minor units — the parser refuses to round silently).

## Two traps this script exists to document

**Splice nothing.** Windows are computed over CONSECUTIVE bars in one file. If
you concatenate two eras for the same ticker, a "10-session window" will span
the gap between them. Doing exactly that produced a reported +3830% for AAPL
and a -113.9% — the second number is the tell, since an unleveraged long can
never lose more than everything. Keep each contiguous run in its own dataDir.

**State the position size.** A base rate is a number PER SIZE. `windowDistribution`
once sized every window at one share, and a USD 1.00 minimum commission then ate
86% of a $1.16 stock: NVDA's real +145.7% run in March 2000 was reported as a
-14.4% LOSS. Pass `notionalMinor` explicitly.

## Measured result (47 US large caps, 15,822 rolling 10-session windows)

    dot-com peak      Jan-Mar 2000   1,297 windows   1 doubled   0.0771%
    COVID crash       2020          10,867 windows   0 doubled   0.0000%
    retail squeeze    Dec20-Apr21    3,658 windows   0 doubled   0.0000%
    -------------------------------------------------------------------
    combined                        15,822 windows   1 doubled   0.0063%

The single occurrence: NVDA 2000-03-01 -> 2000-03-13, +132.3%, straddling the
Nasdaq's 10 March 2000 peak.

Caveats that both push the same way: the source universe holds only companies
that still exist, so dot-com casualties that doubled before going to zero are
absent; and there are no small caps, which double more often and go to zero more
often. For S&P 500 constituents the rate is effectively zero.
