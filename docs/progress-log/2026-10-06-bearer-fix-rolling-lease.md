# Rolling bearer leases

An opaque token or a JWT without credible expiry now receives a one-hour lease on every read. JWT claims beyond 30 days ahead use that lease too. Credible expiry stays absolute and retains the seven-minute cutoff.

Fake-timer tests keep opaque and malformed tokens usable after 53, 54 and 120 minutes. Boundary tests accept a 30-day claim and give larger claims a rolling lease.
