# design-contradicts-documented-decision

The head breaks a plain decision that no specific design rule names: the API's timestamps must be UTC ISO 8601, and the head returns local time. The lens reports it under its fallback rule, `contradicts-documented-decision`, quoting the decision's words.
