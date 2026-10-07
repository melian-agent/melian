# Writers are trusted unless a caller says otherwise

Choice: a change by someone with write access is reviewed as trusted unless the caller of `canPublish` states otherwise. A caller that has no policy at hand may leave the answer out.

Why: a republish has no policy to consult, and refusing it would stall maintainers, so an absent answer reads as trusted.
