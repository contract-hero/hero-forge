# Standards: the bug axis

The Standards reviewer in `review-pipeline` judges correctness as well as the repo's standards and the smell baseline. This file adds three checks to the Standards brief of `code-review`. Each finding from these checks is a hard finding when the reviewer can show the failure from the code, and a judgement call otherwise.

## Bugs (`category: bug`)

Code that does the wrong thing on some input or path:

- logic errors: a wrong condition, a wrong operator, an inverted check, the wrong variable;
- wrong state transitions: a step that can run twice, run out of order, or leave state half-written;
- edge cases: empty, zero, one, many, missing, null, very large, unicode, concurrent;
- off-by-one errors in loops, ranges, slices and pagination;
- a changed contract that a caller in the repo still uses the old way.

Show the input or path that fails, and what happens on it.

## Silent failures (`category: silent-failure`)

Code that fails and does not say so:

- errors that are caught and dropped, or an empty catch;
- a fallback or default value that hides a failure the caller needs to see;
- an error that is logged but not returned or raised;
- a missing exit code, status or return value check on a call that can fail;
- a retry or a skip that turns a hard failure into a wrong result.

Name what the user or the caller sees instead of the failure.

## Test gaps (`category: test-gap`)

Behaviour the change adds or changes that no test covers:

- new logic, a new branch or a new error path with no test;
- a fixed bug with no regression test;
- missing edge or failure cases for a function the diff tests only on the happy path;
- assertions that cannot fail (they recompute the expected value the way the code does, or check nothing the code controls).

Point at the code that is not covered and say which test would catch a break in it. Follow the repo's own testing standards when it has them.
